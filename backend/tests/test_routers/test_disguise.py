"""HTTP contract of the chat-disguise endpoints."""

from __future__ import annotations

import io
import json
import shutil
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image

import database as db
import disguise_apng
import disguise_registry
from image_manager import scan_folder
from utils import file_clipboard

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "disguise"
RED = (200, 40, 40, 255)
GREEN = (40, 200, 40, 255)
BLUE = (40, 40, 200, 255)


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch) -> Path:
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(disguise_registry, "get_data_dir", lambda: str(data))
    return data


def _png(color, size=(60, 40)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def _library_image(tmp_path: Path, name: str, color) -> int:
    folder = tmp_path / "library"
    folder.mkdir(exist_ok=True)
    path = folder / name
    Image.new("RGBA", (80, 60), color).save(path)
    scan_folder(
        str(folder), recursive=False, metadata_workers=1, restore_disguised=False
    )
    return db.get_image_by_path(str(path))["id"]


def _make(client, sources, files=(), **form):
    data = {
        "sources": json.dumps(sources),
        **{key: str(value) for key, value in form.items()},
    }
    multipart = [("files", (name, content, "image/png")) for name, content in files]
    if "cover_file" in form:
        data.pop("cover_file")
        multipart.append(("cover_file", ("cover.png", form["cover_file"], "image/png")))
    return client.post("/api/disguise/make", data=data, files=multipart or None)


def _center(image: Image.Image):
    return image.getpixel((image.width // 2, image.height // 2))


class _FakeCensor:
    def __init__(self, detections=None, error=None):
        self.detections = detections or []
        self.error = error
        self.requests = []

    def detect(self, request):
        self.requests.append(request)
        if self.error:
            raise self.error
        return {"detections": self.detections}


@pytest.fixture
def fake_censor(test_client, monkeypatch):
    from main import app
    from routers.censor import get_censor_service

    holder = {"service": _FakeCensor()}
    monkeypatch.setitem(
        app.dependency_overrides, get_censor_service, lambda: holder["service"]
    )
    return holder


def test_an_uploaded_picture_with_an_uploaded_cover_makes_a_disguise(
    test_client, data_dir: Path
) -> None:
    response = _make(
        test_client,
        [{"file_index": 0}],
        files=[("mine.png", _png(RED))],
        cover_kind="upload",
        cover_file=_png(BLUE),
    )

    body = response.json()
    assert response.status_code == 200, body
    assert body["status"] == "ok"
    assert body["file_name"] == "mine.png"
    assert Path(body["output_path"]).parent == data_dir / "disguise" / "output"
    assert body["cover_preview"].startswith("data:image/png;base64,")
    served = test_client.get(body["file_url"])
    assert served.status_code == 200
    info = disguise_apng.probe_disguise(served.content)
    assert info is not None and info.real_frames == 1
    assert _center(disguise_apng.extract_real_frames(served.content)[0].image)[:3] == (
        200,
        40,
        40,
    )


def test_library_images_and_uploads_pack_into_one_animation_in_order(
    test_client, tmp_path, data_dir
) -> None:
    image_id = _library_image(tmp_path, "first.png", RED)

    response = _make(
        test_client,
        [{"image_id": image_id}, {"file_index": 0}],
        files=[("second.png", _png(GREEN, (80, 60)))],
        cover_kind="blur",
        frame_ms=700,
    )

    body = response.json()
    assert body["status"] == "ok", body
    assert body["real_frames"] == 2
    assert body["file_name"] == "first_2p.png"
    frames = disguise_apng.extract_real_frames(Path(body["output_path"]))
    assert [_center(frame.image)[:3] for frame in frames] == [
        (200, 40, 40),
        (40, 200, 40),
    ]
    assert [frame.duration_ms for frame in frames] == [700, 700]


def test_the_output_never_replaces_an_existing_file(
    test_client, tmp_path, data_dir
) -> None:
    out = tmp_path / "out"
    out.mkdir()
    (out / "mine.png").write_bytes(b"keep me")

    body = _make(
        test_client,
        [{"file_index": 0}],
        files=[("mine.png", _png(RED))],
        cover_kind="blur",
        output_folder=str(out),
    ).json()

    assert body["file_name"] == "mine (2).png"
    assert (out / "mine.png").read_bytes() == b"keep me"


def test_a_mosaic_cover_uses_the_censor_detections_of_the_first_library_image(
    test_client, tmp_path, data_dir, fake_censor
) -> None:
    image_id = _library_image(tmp_path, "nsfw.png", RED)
    fake_censor["service"] = _FakeCensor(detections=[{"box": [10, 10, 50, 50]}])

    body = _make(
        test_client,
        [{"image_id": image_id}],
        cover_kind="mosaic",
        detect_model_type="both",
        detect_confidence=0.3,
        detect_targets=json.dumps(["pussy", "dick"]),
    ).json()

    assert body["status"] == "ok", body
    request = fake_censor["service"].requests[0]
    assert (request.image_id, request.model_type, request.confidence_threshold) == (
        image_id,
        "both",
        0.3,
    )
    assert request.target_classes == ["pussy", "dick"]


@pytest.mark.parametrize(
    ("censor", "reason"),
    [
        (_FakeCensor(detections=[]), "nothing_detected"),
        (
            _FakeCensor(
                error=HTTPException(status_code=503, detail="NudeNet is not installed")
            ),
            "detector_unavailable",
        ),
    ],
)
def test_a_mosaic_cover_that_finds_nothing_asks_for_a_cover_and_writes_nothing(
    test_client, tmp_path, data_dir, fake_censor, censor, reason
) -> None:
    image_id = _library_image(tmp_path, "clean.png", RED)
    fake_censor["service"] = censor

    body = _make(test_client, [{"image_id": image_id}], cover_kind="mosaic").json()

    assert body == {"status": "needs_cover", "reason": reason}
    assert not (data_dir / "disguise" / "output").exists() or not any(
        (data_dir / "disguise" / "output").iterdir()
    )


def test_a_mosaic_cover_for_a_dropped_file_asks_for_a_cover(
    test_client, data_dir
) -> None:
    body = _make(
        test_client,
        [{"file_index": 0}],
        files=[("x.png", _png(RED))],
        cover_kind="mosaic",
    ).json()

    assert body == {"status": "needs_cover", "reason": "not_in_library"}


def test_the_default_cover_round_trip(test_client, data_dir) -> None:
    assert test_client.get("/api/disguise/default-cover").status_code == 404
    missing = _make(
        test_client,
        [{"file_index": 0}],
        files=[("x.png", _png(RED))],
        cover_kind="default",
    ).json()
    assert missing == {"status": "needs_cover", "reason": "no_default_cover"}

    saved = test_client.put(
        "/api/disguise/default-cover",
        files={"file": ("c.png", _png(BLUE), "image/png")},
    )
    made = _make(
        test_client,
        [{"file_index": 0}],
        files=[("x.png", _png(RED))],
        cover_kind="default",
    ).json()
    served = test_client.get("/api/disguise/default-cover")
    removed = test_client.delete("/api/disguise/default-cover").json()

    assert saved.json()["status"] == "ok"
    assert made["status"] == "ok"
    assert served.status_code == 200
    assert removed == {"status": "ok", "removed": True}
    assert test_client.get("/api/disguise/default-cover").status_code == 404


def test_restore_returns_the_real_picture_of_an_uploaded_disguise(test_client) -> None:
    content = (FIXTURES / "reference_tool_single.png").read_bytes()

    response = test_client.post(
        "/api/disguise/restore", files={"file": ("qq.png", content, "image/png")}
    )

    assert response.status_code == 200
    assert 'filename="qq_real.png"' in response.headers["content-disposition"]
    with Image.open(io.BytesIO(response.content)) as image:
        assert _center(image.convert("RGBA")) == RED


def test_restore_refuses_a_picture_that_is_not_a_disguise(test_client) -> None:
    response = test_client.post(
        "/api/disguise/restore", files={"file": ("x.png", _png(RED), "image/png")}
    )

    assert response.status_code == 400


def test_copy_puts_the_made_files_on_the_clipboard(
    test_client, data_dir, monkeypatch
) -> None:
    copied = []
    monkeypatch.setattr(
        file_clipboard, "copy_files", lambda paths: copied.append(list(paths))
    )
    first = _make(
        test_client,
        [{"file_index": 0}],
        files=[("a.png", _png(RED))],
        cover_kind="blur",
    ).json()
    second = _make(
        test_client,
        [{"file_index": 0}],
        files=[("b.png", _png(GREEN))],
        cover_kind="blur",
    ).json()

    response = test_client.post(
        "/api/disguise/copy", json={"tokens": [first["token"], second["token"]]}
    )

    assert response.json() == {"status": "ok", "copied": 2}
    assert copied == [[first["output_path"], second["output_path"]]]


def test_copy_reports_a_platform_without_file_copy(
    test_client, data_dir, monkeypatch
) -> None:
    def unsupported(paths):
        raise file_clipboard.ClipboardUnsupported("no")

    monkeypatch.setattr(file_clipboard, "copy_files", unsupported)
    made = _make(
        test_client,
        [{"file_index": 0}],
        files=[("a.png", _png(RED))],
        cover_kind="blur",
    ).json()

    response = test_client.post("/api/disguise/copy", json={"tokens": [made["token"]]})

    assert response.status_code == 501


def test_unknown_tokens_are_not_found(test_client) -> None:
    assert test_client.get("/api/disguise/result/nope").status_code == 404
    assert (
        test_client.post("/api/disguise/copy", json={"tokens": ["nope"]}).status_code
        == 404
    )


@pytest.mark.parametrize(
    ("sources", "form", "status"),
    [
        ([], {"cover_kind": "blur"}, 400),
        ([{"file_index": 3}], {"cover_kind": "blur"}, 400),
        ([{"file_index": 0}], {"cover_kind": "rainbow"}, 400),
        ([{"image_id": 999999}], {"cover_kind": "blur"}, 404),
    ],
)
def test_bad_requests_are_rejected_with_a_reason(
    test_client, data_dir, sources, form, status
) -> None:
    response = _make(test_client, sources, files=[("a.png", _png(RED))], **form)

    assert response.status_code == status
    assert response.json()["error"]


def test_a_scan_of_the_output_folder_leaves_our_own_disguises_alone(
    test_client, tmp_path, data_dir
) -> None:
    out = tmp_path / "shared"
    out.mkdir()
    made = _make(
        test_client,
        [{"file_index": 0}],
        files=[("mine.png", _png(RED))],
        cover_kind="blur",
        output_folder=str(out),
    ).json()
    shutil.copyfile(FIXTURES / "reference_tool_single.png", out / "from_friend.png")

    result = scan_folder(str(out), recursive=False, metadata_workers=1)

    assert made["status"] == "ok"
    assert result["disguise_restored"] == 1
    assert not (out / "mine_real.png").exists()
    assert (out / "from_friend_real.png").exists()


def test_restore_keeps_a_chinese_file_name(test_client) -> None:
    content = (FIXTURES / "reference_tool_single.png").read_bytes()

    response = test_client.post("/api/disguise/restore", files={"file": ("群聊图片.png", content, "image/png")})

    assert response.status_code == 200
    assert "filename*=UTF-8''%E7%BE%A4%E8%81%8A%E5%9B%BE%E7%89%87_real.png" in response.headers["content-disposition"]


def test_an_output_name_cannot_leave_the_output_folder(test_client, tmp_path, data_dir) -> None:
    out = tmp_path / "out"
    out.mkdir()

    body = _make(
        test_client,
        [{"file_index": 0}],
        files=[("a.png", _png(RED))],
        cover_kind="blur",
        output_folder=str(out),
        output_name="../../escape",
    ).json()

    assert Path(body["output_path"]).parent == out


def test_reveal_opens_the_file_manager_on_the_made_file(test_client, data_dir, monkeypatch) -> None:
    from routers import disguise as disguise_router

    opened = []
    monkeypatch.setattr(disguise_router, "open_in_file_manager", lambda path: opened.append(path) or True)
    made = _make(test_client, [{"file_index": 0}], files=[("a.png", _png(RED))], cover_kind="blur").json()

    response = test_client.post("/api/disguise/reveal", json={"token": made["token"]})

    assert response.json() == {"status": "ok"}
    assert opened == [Path(made["output_path"])]
    assert test_client.post("/api/disguise/reveal", json={"token": "nope"}).status_code == 404


def test_the_page_can_ask_whether_a_default_cover_exists(test_client, data_dir) -> None:
    assert test_client.get("/api/disguise/default-cover/info").json() == {"exists": False}

    test_client.put("/api/disguise/default-cover", files={"file": ("c.png", _png(BLUE), "image/png")})
    info = test_client.get("/api/disguise/default-cover/info").json()

    assert info["exists"] is True
    assert isinstance(info["version"], int)


def test_a_pack_can_be_a_plain_looping_gif_without_a_cover(test_client, data_dir) -> None:
    body = _make(
        test_client,
        [{"file_index": 0}, {"file_index": 1}],
        files=[("a.png", _png(RED)), ("b.png", _png(GREEN))],
        cover_kind="mosaic",  # ignored: a GIF has no cover
        output_format="gif",
        frame_ms=250,
    ).json()

    assert body["status"] == "ok", body
    assert body["file_name"] == "a_2p.gif"
    served = test_client.get(body["file_url"])
    assert served.headers["content-type"] == "image/gif"
    with Image.open(io.BytesIO(served.content)) as gif:
        assert gif.format == "GIF" and gif.n_frames == 2


def test_an_unknown_output_format_is_refused(test_client, data_dir) -> None:
    response = _make(test_client, [{"file_index": 0}], files=[("a.png", _png(RED))], cover_kind="blur", output_format="webm")

    assert response.status_code == 400
