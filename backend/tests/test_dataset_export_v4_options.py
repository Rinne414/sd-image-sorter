"""V4 dataset export options: the ``_nl.txt`` twin and implication dedup.

Both reuse the tag export implementation (``services.tag_export``), both
default off, and off must leave every exported file and every Readiness
fingerprint exactly as before.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest
from PIL import Image

from services.dataset_export.engine import export_dataset, preview_dataset_export
from services.dataset_export.models import (
    DatasetExportPreviewRequest,
    DatasetExportRequest,
    DatasetReadinessRequest,
)
from services.dataset_export.readiness import (
    dataset_readiness_fingerprint,
    run_dataset_readiness,
)


DEFAULT_SETTINGS_JSON_V1 = importlib.import_module(
    "migrations.033_dataset_project_settings"
).DEFAULT_SETTINGS_JSON_V1

TEMPLATE = "{trigger}, {tags:filtered}, {append}"


def _library_image(
    test_db, folder: Path, name: str, tags: list[str], nl: str = ""
) -> int:
    folder.mkdir(parents=True, exist_ok=True)
    source = folder / name
    Image.new("RGB", (16, 16), color=(40, 80, 120)).save(source)
    image_id = int(test_db.add_image(path=str(source), filename=source.name))
    test_db.add_tags(image_id, [{"tag": tag, "confidence": 0.9} for tag in tags])
    if nl:
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE images SET nl_caption = ? WHERE id = ?", (nl, image_id)
            )
            conn.commit()
    return image_id


def _payload(image_ids: list[int], output: Path, **extra: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "image_ids": image_ids,
        "output_folder": str(output),
        "naming_pattern": "{filename}",
        "trigger": "hero",
        "content_mode": "template",
        "template_options": {
            "preset_id": "custom",
            "template_override": TEMPLATE,
            "trigger": "hero",
            "max_tags": 0,
        },
    }
    payload.update(extra)
    return payload


def _ready(payload: dict[str, object], report_id: str = "v4-options"):
    return run_dataset_readiness(
        DatasetReadinessRequest.model_validate(payload),
        readiness_report_id=report_id,
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )


def _files(folder: Path) -> dict[str, bytes]:
    return {
        path.name: path.read_bytes()
        for path in sorted(folder.iterdir())
        if path.is_file() and path.name != "export_manifest.json"
    }


def test_both_options_off_write_the_same_files_and_fingerprint(
    test_db, tmp_path: Path
) -> None:
    image_id = _library_image(
        test_db,
        tmp_path / "src",
        "a.png",
        ["cat_ears", "animal_ears", "1girl"],
        nl="A girl smiles.",
    )
    plain = _payload([image_id], tmp_path / "plain")
    explicit = _payload(
        [image_id], tmp_path / "explicit", nl_sidecar=False, dedupe_implications=False
    )

    assert export_dataset(DatasetExportRequest.model_validate(plain)).status == "ok"
    assert export_dataset(DatasetExportRequest.model_validate(explicit)).status == "ok"

    assert _files(tmp_path / "plain") == _files(tmp_path / "explicit")
    assert sorted(_files(tmp_path / "plain")) == ["a.png", "a.txt"]
    caption = (tmp_path / "plain" / "a.txt").read_text(encoding="utf-8")
    assert "animal ears" in caption and "cat ears" in caption
    # Off is not part of the checked request: V3.5 proofs keep their fingerprints.
    assert dataset_readiness_fingerprint(
        DatasetReadinessRequest.model_validate(
            plain | {"output_folder": str(tmp_path / "x")}
        )
    ) == dataset_readiness_fingerprint(
        DatasetReadinessRequest.model_validate(
            explicit | {"output_folder": str(tmp_path / "x")}
        )
    )


def test_dedupe_implications_drops_parents_in_preview_readiness_and_export(
    test_db, tmp_path: Path
) -> None:
    image_id = _library_image(
        test_db, tmp_path / "src", "b.png", ["cat_ears", "animal_ears", "1girl"]
    )
    payload = _payload([image_id], tmp_path / "out", dedupe_implications=True)

    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload)
    )
    report = _ready(payload)
    result = export_dataset(DatasetExportRequest.model_validate(payload))

    written = (tmp_path / "out" / "b.txt").read_text(encoding="utf-8")
    assert result.status == "ok"
    assert report.summary.status in {"ready", "warnings"}
    assert written.startswith("hero, ")
    assert "cat ears" in written and "animal ears" not in written
    assert preview["items"][0]["caption"] == written
    # Turning it on changes what is checked, so an old proof cannot authorize it.
    assert dataset_readiness_fingerprint(
        DatasetReadinessRequest.model_validate(payload)
    ) != dataset_readiness_fingerprint(
        DatasetReadinessRequest.model_validate(payload | {"dedupe_implications": False})
    )


def _project_with_revision(
    test_client, test_db, image_id: int, content: dict[str, object]
) -> tuple[int, int]:
    project = test_client.post(
        "/api/dataset/projects",
        json={
            "name": f"V4 options {image_id}",
            "items": [{"item_type": "library", "image_id": image_id}],
            "settings": json.loads(DEFAULT_SETTINGS_JSON_V1),
        },
    )
    assert project.status_code == 201, project.text
    project_id = int(project.json()["id"])
    mutation = test_db.create_project_library_training_caption_revision(
        project_id, 1, image_id, 0, content, "manual", "user", None, None
    )
    return project_id, int(mutation["revision"]["id"])


def test_dedupe_and_nl_twin_use_an_edited_caption(
    test_client, test_db, tmp_path: Path
) -> None:
    image_id = _library_image(
        test_db, tmp_path / "src", "c.png", ["solo"], nl="stored sentence"
    )
    content = {
        "content_version": 1,
        "booru_caption": "cat ears, animal ears, smile",
        "nl_caption": "A girl with cat ears\nsmiles.",
        "caption_type": "booru",
    }
    project_id, revision_id = _project_with_revision(
        test_client, test_db, image_id, content
    )
    payload = _payload(
        [image_id],
        tmp_path / "out",
        dedupe_implications=True,
        nl_sidecar=True,
        dataset_project_id=project_id,
        dataset_project_revision=1,
        caption_transforms={"prepend": ["hero"], "remove": [], "remove_categories": []},
        annotation_selections={
            str(image_id): {"kind": "revision_ref", "revision_id": revision_id}
        },
    )

    preview = preview_dataset_export(
        DatasetExportPreviewRequest.model_validate(payload)
    )
    report = _ready(payload)
    result = export_dataset(DatasetExportRequest.model_validate(payload))

    assert result.status == "ok"
    assert report.summary.blocker_count == 0
    assert (tmp_path / "out" / "c.txt").read_text(
        encoding="utf-8"
    ) == "hero, cat ears, smile"
    assert preview["items"][0]["caption"] == "hero, cat ears, smile"
    # The twin holds the edited sentence on one line, trigger first (tag export's rule).
    assert (tmp_path / "out" / "c_nl.txt").read_text(
        encoding="utf-8"
    ) == "hero, A girl with cat ears smiles."


def test_nl_twin_for_a_rendered_caption_and_beside_the_original(
    test_db, tmp_path: Path
) -> None:
    image_id = _library_image(
        test_db, tmp_path / "src", "d.png", ["1girl"], nl="A girl waves."
    )
    folder = _payload([image_id], tmp_path / "out", nl_sidecar=True)
    beside = _payload(
        [image_id],
        tmp_path / "unused",
        nl_sidecar=True,
        output_mode="beside_image",
        output_folder="",
    )

    assert export_dataset(DatasetExportRequest.model_validate(folder)).status == "ok"
    assert export_dataset(DatasetExportRequest.model_validate(beside)).status == "ok"

    assert sorted(_files(tmp_path / "out")) == ["d.png", "d.txt", "d_nl.txt"]
    assert (tmp_path / "out" / "d_nl.txt").read_text(
        encoding="utf-8"
    ) == "hero, A girl waves."
    assert (tmp_path / "src" / "d_nl.txt").read_text(
        encoding="utf-8"
    ) == "hero, A girl waves."
    assert not (tmp_path / "unused").exists()


def test_nl_twin_follows_the_name_collision_rule(test_db, tmp_path: Path) -> None:
    image_id = _library_image(
        test_db, tmp_path / "src", "e.png", ["1girl"], nl="New sentence."
    )
    out = tmp_path / "out"
    out.mkdir()
    (out / "e_nl.txt").write_text("old twin", encoding="utf-8")

    unique = export_dataset(
        DatasetExportRequest.model_validate(_payload([image_id], out, nl_sidecar=True))
    )
    assert unique.status == "failed"
    assert unique.error_count == 1
    assert "e_nl.txt" in unique.error_messages[0]
    # Nothing of the pair is written when its twin cannot be.
    assert sorted(_files(out)) == ["e_nl.txt"]

    skip = export_dataset(
        DatasetExportRequest.model_validate(
            _payload([image_id], out, nl_sidecar=True, overwrite_policy="skip")
        )
    )
    assert skip.status == "ok"
    assert (out / "e_nl.txt").read_text(encoding="utf-8") == "old twin"

    overwrite = export_dataset(
        DatasetExportRequest.model_validate(
            _payload([image_id], out, nl_sidecar=True, overwrite_policy="overwrite")
        )
    )
    assert overwrite.status == "ok"
    assert (out / "e_nl.txt").read_text(encoding="utf-8") == "hero, New sentence."


@pytest.mark.parametrize("trainer", ["kohya_toml", "anima_lora_toml"])
def test_nl_twin_is_refused_for_verified_trainer_packages(
    test_client, test_db, tmp_path: Path, trainer: str
) -> None:
    image_id = _library_image(test_db, tmp_path / "src", "f.png", ["1girl"])
    payload = _payload(
        [image_id], tmp_path / "out", nl_sidecar=True, trainer_config=trainer
    )

    response = test_client.post("/api/dataset/readiness/start", json=payload)

    assert response.status_code == 400
    assert "nl_sidecar" in response.text
    assert not (tmp_path / "out").exists()


def test_nl_twin_needs_a_tag_caption_mode(test_client, test_db, tmp_path: Path) -> None:
    image_id = _library_image(test_db, tmp_path / "src", "g.png", ["1girl"])
    payload = _payload(
        [image_id], tmp_path / "out", nl_sidecar=True, content_mode="nl_caption"
    )
    payload.pop("template_options")

    response = test_client.post("/api/dataset/readiness/start", json=payload)

    assert response.status_code == 400
    assert "nl_sidecar" in response.text
