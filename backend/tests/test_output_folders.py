"""One place decides where blank-folder saves go (owner decisions 2026-10-04).

Settings can move the built-in ``output`` root; every save flow that is left
blank follows it (censor, publish set, video censor). "Open folder" works for
every flow but only on files a save of this server run wrote.
"""

from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image


def _png_data_url() -> str:
    buffer = BytesIO()
    Image.new("RGB", (8, 8), (10, 20, 30)).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(
        "ascii"
    )


def _blank_censor_save(client: TestClient) -> Path:
    response = client.post(
        "/api/censor/save-data",
        json={
            "image_data": _png_data_url(),
            "filename": "pic.png",
            "output_folder": "",
            "output_format": "png",
        },
    )
    assert response.status_code == 200, response.text
    return Path(response.json()["output_path"])


def test_a_custom_root_moves_every_builtin_folder(
    test_client: TestClient, tmp_path: Path
) -> None:
    custom = tmp_path / "my saves"

    response = test_client.patch("/api/output-folders", json={"root": str(custom)})

    assert response.status_code == 200, response.text
    body = response.json()
    assert Path(body["root"]) == custom
    assert Path(body["custom_root"]) == custom
    assert Path(body["folders"]["publish"]) == custom / "publish"
    assert _blank_censor_save(test_client).parent == (custom / "censor").resolve()


def test_clearing_the_custom_root_goes_back_to_the_program_folder(
    test_client: TestClient, tmp_path: Path
) -> None:
    import config

    test_client.patch("/api/output-folders", json={"root": str(tmp_path / "elsewhere")})

    body = test_client.patch("/api/output-folders", json={"root": ""}).json()

    assert body["custom_root"] == ""
    assert Path(body["root"]) == Path(config.OUTPUT_DIR)
    assert Path(body["builtin_root"]) == Path(config.OUTPUT_DIR)
    assert (
        _blank_censor_save(test_client).parent
        == (Path(config.OUTPUT_DIR) / "censor").resolve()
    )


def test_an_invalid_root_is_refused_and_not_saved(test_client: TestClient) -> None:
    import config

    response = test_client.patch(
        "/api/output-folders", json={"root": "C:/bad<name>|here"}
    )

    assert response.status_code == 400
    assert Path(test_client.get("/api/output-folders").json()["root"]) == Path(
        config.OUTPUT_DIR
    )


def test_publish_set_with_a_blank_folder_exports_into_output_publish(
    test_client: TestClient, test_db, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import config
    import routers.output_folders as output_folders_router

    source = tmp_path / "source.png"
    Image.new("RGB", (12, 12), (200, 100, 50)).save(source, format="PNG")
    image_id = int(
        test_db.add_image(path=str(source), filename=source.name, metadata_json="{}")
    )
    opened: list[Path] = []
    monkeypatch.setattr(
        output_folders_router,
        "open_in_file_manager",
        lambda path: opened.append(path) or True,
    )

    result = test_client.post(
        "/api/publish/export",
        json={
            "items": [{"image_id": image_id, "use_censored": False}],
            "output_folder": "",
        },
    )

    assert result.status_code == 200, result.text
    body = result.json()
    assert (
        Path(body["output_folder"]) == (Path(config.OUTPUT_DIR) / "publish").resolve()
    )
    assert Path(body["reveal_path"]).is_file()
    reveal = test_client.post(
        "/api/output-folders/reveal", json={"path": body["reveal_path"]}
    )
    assert reveal.status_code == 200, reveal.text
    assert opened == [Path(body["reveal_path"])]


def test_reveal_refuses_files_no_save_wrote(
    test_client: TestClient, tmp_path: Path
) -> None:
    stranger = tmp_path / "stranger.png"
    stranger.write_bytes(b"x")

    response = test_client.post(
        "/api/output-folders/reveal", json={"path": str(stranger)}
    )

    assert response.status_code == 404


def test_a_relative_root_is_refused(test_client: TestClient) -> None:
    response = test_client.patch("/api/output-folders", json={"root": "relative-saves"})

    assert response.status_code == 400
    assert test_client.get("/api/output-folders").json()["custom_root"] == ""


def test_a_file_is_not_accepted_as_the_root(test_client: TestClient, tmp_path: Path) -> None:
    notes = tmp_path / "notes.txt"
    notes.write_text("not a folder", encoding="utf-8")

    response = test_client.patch("/api/output-folders", json={"root": str(notes)})

    assert response.status_code == 400
    assert test_client.get("/api/output-folders").json()["custom_root"] == ""


def test_a_symlinked_root_is_refused(test_client: TestClient, tmp_path: Path) -> None:
    import os

    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    try:
        os.symlink(real, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("this machine cannot create directory symlinks")

    response = test_client.patch("/api/output-folders", json={"root": str(link)})

    assert response.status_code == 400


def test_a_damaged_settings_file_falls_back_to_the_program_folder(test_client: TestClient) -> None:
    import config

    Path(config.APP_SETTINGS_CONFIG_PATH).parent.mkdir(parents=True, exist_ok=True)
    Path(config.APP_SETTINGS_CONFIG_PATH).write_text("{not json", encoding="utf-8")

    body = test_client.get("/api/output-folders").json()

    assert Path(body["root"]) == Path(config.OUTPUT_DIR)
    assert body["custom_root"] == ""


def test_open_folder_still_works_when_publish_skipped_existing_files(
    test_client: TestClient, test_db, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import routers.output_folders as output_folders_router

    source = tmp_path / "again.png"
    Image.new("RGB", (6, 6), (1, 2, 3)).save(source, format="PNG")
    image_id = int(test_db.add_image(path=str(source), filename=source.name, metadata_json="{}"))
    monkeypatch.setattr(output_folders_router, "open_in_file_manager", lambda path: True)
    payload = {"items": [{"image_id": image_id, "use_censored": False}], "output_folder": str(tmp_path / "set")}
    test_client.post("/api/publish/export", json=payload)

    second = test_client.post("/api/publish/export", json=payload).json()

    assert second["exported"] == [] and len(second["skipped_existing"]) == 1
    assert test_client.post("/api/output-folders/reveal", json={"path": second["reveal_path"]}).status_code == 200
