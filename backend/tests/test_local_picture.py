"""POST /api/local-picture: a picture read by the location a drop or paste carried.

QQ copies a picture as ``<img src="file://L:\\Tencent Files\\...\\x.png">``
and other apps drag out ``file:///...`` links, so the Reader gets a location
instead of a file. These pin every location shape, the refusals, and that
only the program's own page may read files this way.
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote, unquote

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from services.local_picture import (
    LocalPictureError,
    path_candidates,
    resolve_local_picture,
)

WINDOWS = os.name == "nt"


def _picture(folder: Path, name: str = "pic.png", prompt: str = "1girl, solo") -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    info = PngInfo()
    info.add_text(
        "parameters",
        f"{prompt}\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 8x8",
    )
    Image.new("RGB", (8, 8), color="red").save(path, pnginfo=info)
    return path


def _file_url(path: Path, *, encode: bool = True) -> str:
    text = str(path).replace("\\", "/")
    if encode:
        text = quote(text, safe="/:")
    return f"file:///{text.lstrip('/')}"


# -- location shapes ---------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("file:///C:/Users/a/x.png", "C:/Users/a/x.png"),
        ("file:///C:/My%20Pictures/%E5%9B%BE.png", "C:/My Pictures/\u56fe.png"),
        (
            "file://L:\\Tencent Files\\nt_qq\\Pic\\Ori\\abc.png",
            "L:\\Tencent Files\\nt_qq\\Pic\\Ori\\abc.png",
        ),
        ("file:/C:/x.png", "C:/x.png"),
        ("FILE://localhost/C:/x.png", "C:/x.png"),
        ('"C:\\Users\\a\\x.png"', "C:\\Users\\a\\x.png"),
        ("  C:\\Users\\a\\x.png  ", "C:\\Users\\a\\x.png"),
    ],
)
def test_windows_locations_become_paths(raw, expected):
    assert path_candidates(raw)[0] == expected


def test_an_unencoded_name_with_a_percent_sign_is_tried_as_written():
    candidates = path_candidates("file://C:\\pics\\100%25 done #2.png")
    assert "C:\\pics\\100% done #2.png" in candidates
    assert "C:\\pics\\100%25 done #2.png" in candidates


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "x.png",
        "pics\\x.png",
        "C:x.png",
        "https://example.com/x.png",
        "file:x.png",
    ],
)
def test_relative_and_web_locations_are_not_paths(raw):
    assert path_candidates(raw) == []


@pytest.mark.skipif(WINDOWS, reason="POSIX paths only mean something off Windows")
def test_posix_locations_become_paths():
    assert path_candidates("file:///home/a/x%20y.png")[0] == "/home/a/x y.png"
    assert path_candidates("/home/a/x.png") == ["/home/a/x.png"]


@pytest.mark.skipif(
    not WINDOWS, reason="a POSIX path on Windows would land on the current drive"
)
def test_posix_locations_are_refused_on_windows():
    assert path_candidates("/home/a/x.png") == []


# -- resolving on disk --------------------------------------------------------


def test_every_location_shape_finds_the_same_picture(tmp_path):
    picture = _picture(tmp_path / "QQ \u56fe\u7247" / "Ori", "a1b2.png")
    shapes = [
        str(picture),
        f'"{picture}"',
        _file_url(picture),
        _file_url(picture, encode=False),
    ]
    if WINDOWS:
        # QQ NT: file:// followed straight by the drive and backslashes.
        shapes.append(f"file://{picture}")
    for raw in shapes:
        assert resolve_local_picture(raw) == picture.resolve(), raw


def test_a_location_without_a_picture_extension_is_refused(tmp_path):
    notes = tmp_path / "notes.txt"
    notes.write_text("hello", encoding="utf-8")
    with pytest.raises(LocalPictureError) as caught:
        resolve_local_picture(str(notes))
    assert caught.value.code == "local_picture_not_picture"
    assert caught.value.status_code == 415


def test_a_missing_picture_names_the_file(tmp_path):
    with pytest.raises(LocalPictureError) as caught:
        resolve_local_picture(_file_url(tmp_path / "gone.png"))
    assert caught.value.code == "local_picture_missing"
    assert caught.value.status_code == 404
    assert caught.value.params["name"] == "gone.png"


def test_a_file_that_only_looks_like_a_picture_is_refused(tmp_path):
    fake = tmp_path / "fake.png"
    fake.write_bytes(b"this is not a png")
    with pytest.raises(LocalPictureError) as caught:
        resolve_local_picture(str(fake))
    assert caught.value.code == "local_picture_unreadable"
    assert caught.value.status_code == 422


def test_a_folder_named_like_a_picture_is_missing(tmp_path):
    folder = tmp_path / "folder.png"
    folder.mkdir()
    with pytest.raises(LocalPictureError) as caught:
        resolve_local_picture(str(folder))
    assert caught.value.code == "local_picture_missing"


def test_a_relative_location_is_refused():
    with pytest.raises(LocalPictureError) as caught:
        resolve_local_picture("pics/x.png")
    assert caught.value.code == "local_picture_bad_path"
    assert caught.value.status_code == 400


@pytest.mark.parametrize(
    "location",
    [
        r"\\evil.example\share\a.png",
        r"\\evil.example@80\dav\a.png",
        "//evil.example/share/a.png",
        "file://evil.example/share/a.png",
        r"\\?\C:\pics\a.png",
        r"\\.\C:\pics\a.png",
    ],
)
def test_a_network_share_or_device_path_is_refused_without_touching_it(
    location, monkeypatch
):
    # Looking up \\host\share makes Windows sign in to that host, so the
    # refusal must come before any file system call.
    import services.local_picture as local_picture

    def no_lookup(*_args, **_kwargs):
        raise AssertionError("a network location was looked up")

    monkeypatch.setattr(local_picture, "validate_file_path", no_lookup)
    monkeypatch.setattr(local_picture, "verify_image_readable", no_lookup)
    with pytest.raises(LocalPictureError) as caught:
        resolve_local_picture(location)
    # Off Windows a file://host/ URL is not a location at all.
    if os.name != "nt" and location.startswith("file:"):
        assert caught.value.code == "local_picture_bad_path"
    else:
        assert caught.value.code == "local_picture_network"
        assert caught.value.params == {"name": "a.png"}


def test_parent_folder_steps_are_refused(tmp_path):
    _picture(tmp_path, "x.png")
    with pytest.raises(LocalPictureError) as caught:
        resolve_local_picture(str(tmp_path / "sub" / ".." / "x.png"))
    assert caught.value.code == "local_picture_bad_path"


# -- the endpoint ---------------------------------------------------------------


def test_the_endpoint_answers_the_picture_bytes(test_client, tmp_path):
    picture = _picture(tmp_path / "\u804a\u5929", "\u56fe 1.png")
    answer = test_client.post(
        "/api/local-picture",
        json={"path": f"file://{picture}" if WINDOWS else _file_url(picture)},
    )
    assert answer.status_code == 200, answer.text
    assert answer.headers["content-type"] == "image/png"
    assert answer.headers["cache-control"] == "no-store"
    assert unquote(answer.headers["x-picture-name"]) == "\u56fe 1.png"
    assert answer.content == picture.read_bytes()


def test_the_answered_picture_reads_like_an_upload(test_client, tmp_path):
    """The page sends the answer on to /api/parse-image: the generation details survive."""
    picture = _picture(tmp_path, "meta.png", prompt="masterpiece, qq test")
    answer = test_client.post("/api/local-picture", json={"path": str(picture)})
    parsed = test_client.post(
        "/api/parse-image",
        files={"file": ("meta.png", answer.content, answer.headers["content-type"])},
    )
    assert parsed.status_code == 200, parsed.text
    assert "qq test" in parsed.json()["prompt"]


@pytest.mark.parametrize(
    "name, status, code",
    [
        ("missing.png", 404, "local_picture_missing"),
        ("notes.txt", 415, "local_picture_not_picture"),
        (None, 400, "local_picture_bad_path"),
    ],
)
def test_the_endpoint_says_why_with_a_code(test_client, tmp_path, name, status, code):
    (tmp_path / "notes.txt").write_text("x", encoding="utf-8")
    path = str(tmp_path / name) if name else "relative/x.png"
    answer = test_client.post("/api/local-picture", json={"path": path})
    assert answer.status_code == status
    body = answer.json()
    assert body["code"] == code
    assert body["message"]


def test_an_empty_location_is_refused_before_any_lookup(test_client):
    answer = test_client.post("/api/local-picture", json={"path": ""})
    assert answer.status_code in (400, 422)
    assert "code" not in answer.json() or not answer.json()["code"].startswith(
        "local_picture"
    )


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "http://localhost:3000", "Sec-Fetch-Site": "same-site"},
        {"Sec-Fetch-Site": "cross-site", "Origin": "http://127.0.0.1:3000"},
        {"Origin": "http://127.0.0.1:9999"},
    ],
)
def test_only_the_programs_own_page_may_read_files_by_location(
    test_client, tmp_path, headers
):
    picture = _picture(tmp_path)
    answer = test_client.post(
        "/api/local-picture", json={"path": str(picture)}, headers=headers
    )
    assert answer.status_code == 403
    assert "own page" in answer.json()["error"]
    assert answer.content != picture.read_bytes()
