"""Censor saves work without setup and never make the user rename by hand.

Owner request 2026-10-04: a blank output folder means the built-in
``output/censor`` folder instead of an error, and saving a second version of a
picture picks a free name (``name_2.png``) instead of failing with 409. The
"open folder" button may only reveal files the censor save itself wrote.
"""

from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image


def _png_data_url(color: tuple[int, int, int]) -> str:
    buffer = BytesIO()
    Image.new("RGB", (16, 12), color).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(
        "ascii"
    )


def _save(client: TestClient, folder: str, color=(200, 40, 40), **extra) -> dict:
    response = client.post(
        "/api/censor/save-data",
        json={
            "image_data": _png_data_url(color),
            "filename": "00042-123.png",
            "output_folder": folder,
            "metadata_option": "strip",
            "output_format": "png",
            **extra,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _pixel(path: Path) -> object:
    with Image.open(path) as image:
        return image.convert("RGB").getpixel((0, 0))


def test_blank_output_folder_saves_into_the_builtin_censor_folder(
    test_client: TestClient,
) -> None:
    import config

    body = _save(test_client, "")

    expected = Path(config.OUTPUT_DIR) / "censor" / "00042-123.png"
    assert Path(body["output_path"]) == expected.resolve()
    assert expected.is_file()


def test_default_output_folders_endpoint_reports_the_censor_folder(
    test_client: TestClient,
) -> None:
    import config

    response = test_client.get("/api/output-folders")

    assert response.status_code == 200, response.text
    folders = response.json()["folders"]
    assert Path(folders["censor"]) == Path(config.OUTPUT_DIR) / "censor"


def test_unique_name_conflict_keeps_both_versions(
    test_client: TestClient, tmp_path: Path
) -> None:
    out_dir = tmp_path / "out"

    first = _save(test_client, str(out_dir), (200, 40, 40), name_conflict="unique")
    second = _save(test_client, str(out_dir), (40, 40, 200), name_conflict="unique")
    third = _save(test_client, str(out_dir), (40, 200, 40), name_conflict="unique")

    assert [first["filename"], second["filename"], third["filename"]] == [
        "00042-123.png",
        "00042-123_2.png",
        "00042-123_3.png",
    ]
    assert _pixel(out_dir / "00042-123.png") == (200, 40, 40)
    assert _pixel(out_dir / "00042-123_2.png") == (40, 40, 200)
    assert second["overwrote_existing"] is False


def test_skip_name_conflict_leaves_the_existing_file(
    test_client: TestClient, tmp_path: Path
) -> None:
    out_dir = tmp_path / "out"
    _save(test_client, str(out_dir), (200, 40, 40))

    body = _save(test_client, str(out_dir), (40, 40, 200), name_conflict="skip")

    assert body["skipped"] is True
    assert _pixel(out_dir / "00042-123.png") == (200, 40, 40)
    assert sorted(p.name for p in out_dir.iterdir()) == ["00042-123.png"]


def test_default_conflict_still_refuses_and_overwrite_still_replaces(
    test_client: TestClient, tmp_path: Path
) -> None:
    out_dir = tmp_path / "out"
    _save(test_client, str(out_dir), (200, 40, 40))

    refused = test_client.post(
        "/api/censor/save-data",
        json={
            "image_data": _png_data_url((40, 40, 200)),
            "filename": "00042-123.png",
            "output_folder": str(out_dir),
            "output_format": "png",
        },
    )
    assert refused.status_code == 409

    replaced = _save(
        test_client,
        str(out_dir),
        (40, 40, 200),
        allow_overwrite=True,
        name_conflict="unique",
    )
    assert replaced["filename"] == "00042-123.png"
    assert replaced["overwrote_existing"] is True
    assert _pixel(out_dir / "00042-123.png") == (40, 40, 200)


def test_reveal_output_opens_only_files_the_censor_save_wrote(
    test_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import routers.output_folders as output_folders_router

    opened: list[Path] = []
    monkeypatch.setattr(
        output_folders_router, "open_in_file_manager", lambda path: opened.append(path) or True
    )
    body = _save(test_client, str(tmp_path / "out"))
    stranger = tmp_path / "not-saved-here.png"
    stranger.write_bytes(b"x")

    refused = test_client.post(
        "/api/output-folders/reveal", json={"path": str(stranger)}
    )
    allowed = test_client.post(
        "/api/output-folders/reveal", json={"path": body["output_path"]}
    )

    assert refused.status_code == 404
    assert allowed.status_code == 200, allowed.text
    assert opened == [Path(body["output_path"])]


def test_updater_and_packages_leave_the_output_folder_alone() -> None:
    import update_worker

    assert any(
        prefix == Path("output") for prefix in update_worker.PROTECTED_RUNTIME_PREFIXES
    )
    import importlib.util

    script = Path(__file__).resolve().parents[2] / "scripts" / "build_release_packages.py"
    spec = importlib.util.spec_from_file_location("build_release_packages", script)
    assert spec is not None and spec.loader is not None
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    assert builder.should_skip_path(Path("output/censor/00042-123.png"))
    assert builder.should_prune_directory(Path("output"))


def _add_source_image(test_db, path: Path) -> int:
    Image.new("RGB", (20, 14), (90, 160, 30)).save(path, format="PNG")
    return int(test_db.add_image(path=str(path), filename=path.name, metadata_json="{}"))


@pytest.mark.parametrize(
    ("endpoint", "extra"),
    [
        ("/api/censor/save-original", {"output_format": "original"}),
        ("/api/censor/save-operations", {"operations": [], "output_format": "png"}),
    ],
)
def test_unique_name_conflict_on_the_server_side_save_paths(
    test_client: TestClient, test_db, tmp_path: Path, endpoint: str, extra: dict
) -> None:
    image_id = _add_source_image(test_db, tmp_path / "source.png")
    out_dir = tmp_path / "out"
    payload = {
        "original_image_id": image_id,
        "filename": "set_001.png",
        "output_folder": str(out_dir),
        "metadata_option": "strip",
        "name_conflict": "unique",
        **extra,
    }

    names = [test_client.post(endpoint, json=payload).json()["filename"] for _ in range(2)]

    assert names == ["set_001.png", "set_001_2.png"]
    assert sorted(p.name for p in out_dir.iterdir()) == ["set_001.png", "set_001_2.png"]


def test_a_failed_write_removes_the_claimed_placeholder(
    test_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services.censor_service import CensorService

    def _boom(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(CensorService, "_save_image_with_format", staticmethod(_boom))
    out_dir = tmp_path / "out"

    response = test_client.post(
        "/api/censor/save-data",
        json={
            "image_data": _png_data_url((1, 2, 3)),
            "filename": "00042-123.png",
            "output_folder": str(out_dir),
            "output_format": "png",
            "name_conflict": "unique",
        },
    )

    assert response.status_code == 500
    assert list(out_dir.iterdir()) == []


def test_concurrent_claims_never_share_a_name(tmp_path: Path) -> None:
    from concurrent.futures import ThreadPoolExecutor

    from services.censor_service import CensorService

    service = CensorService.__new__(CensorService)
    folder = str(tmp_path)

    with ThreadPoolExecutor(max_workers=8) as pool:
        claimed = list(pool.map(lambda _: service._claim_free_output_path(folder, "dup", ".png")[1], range(16)))

    assert len(set(claimed)) == 16
    assert "dup.png" in claimed and "dup_16.png" in claimed


def test_running_out_of_numbers_is_a_conflict_not_an_overwrite(
    test_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import services.censor.output_io as output_io

    monkeypatch.setattr(output_io, "_MAX_UNIQUE_NAME_ATTEMPTS", 2)
    out_dir = tmp_path / "out"
    _save(test_client, str(out_dir), name_conflict="unique")
    _save(test_client, str(out_dir), name_conflict="unique")

    response = test_client.post(
        "/api/censor/save-data",
        json={
            "image_data": _png_data_url((7, 7, 7)),
            "filename": "00042-123.png",
            "output_folder": str(out_dir),
            "output_format": "png",
            "name_conflict": "unique",
        },
    )

    assert response.status_code == 409
    assert sorted(p.name for p in out_dir.iterdir()) == ["00042-123.png", "00042-123_2.png"]
