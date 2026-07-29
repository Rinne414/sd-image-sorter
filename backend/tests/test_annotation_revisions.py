"""Integration coverage for immutable Dataset Project annotation revisions."""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from utils.source_paths import indexed_image_path_match_key


_SETTINGS_JSON = '{"settings_version":1}'


def _create_library_project(
    db,
    image_path: str,
    project_name: str,
) -> tuple[int, int]:
    source_path = Path(db.DATABASE_PATH).parent / Path(image_path).name
    source_path.write_bytes(f"library source: {image_path}".encode("utf-8"))
    with db.get_db() as conn:
        image_id = int(
            conn.execute(
                "INSERT INTO images (path, filename) VALUES (?, ?)",
                (str(source_path.resolve()), source_path.name),
            ).lastrowid
        )
    project = db.create_dataset_project_record(
        project_name,
        project_name.casefold(),
        [{"item_type": "library", "image_id": image_id}],
        _SETTINGS_JSON,
    )
    return int(project["id"]), image_id


def _create_local_project(
    db,
    local_path: Path,
    project_name: str,
) -> tuple[int, dict[str, object]]:
    resolved = local_path.resolve(strict=True)
    source_stat = resolved.stat()
    local_item: dict[str, object] = {
        "item_type": "local",
        "path": str(resolved),
        "path_key": indexed_image_path_match_key(str(resolved)),
        "size": source_stat.st_size,
        "mtime_ns": str(source_stat.st_mtime_ns),
        "device": str(source_stat.st_dev),
        "inode": str(source_stat.st_ino),
    }
    project = db.create_dataset_project_record(
        project_name,
        project_name.casefold(),
        [local_item],
        _SETTINGS_JSON,
    )
    return int(project["id"]), local_item


def _content(index: int) -> dict[str, object]:
    return {
        "content_version": 1,
        "booru_caption": f"subject_{index}, blue_hair",
        "nl_caption": f"Natural language caption {index}.",
        "caption_type": "both",
    }


def test_create_library_revision_is_canonical_and_immutable(test_db) -> None:
    project_id, image_id = _create_library_project(
        test_db,
        "/library/annotation-library.png",
        "Annotation project",
    )
    content = {
        "content_version": 1,
        "booru_caption": "1girl, blue_hair",
        "nl_caption": "A blue-haired girl.",
        "caption_type": "both",
    }

    created = test_db.create_project_library_training_caption_revision(
        project_id,
        1,
        image_id,
        0,
        content,
        "sidecar_import",
        "user",
        None,
        None,
    )

    expected_json = (
        '{"booru_caption":"1girl, blue_hair","caption_type":"both",'
        '"content_version":1,"nl_caption":"A blue-haired girl."}'
    )
    assert created["revision"]["content_json"] == expected_json
    assert (
        created["revision"]["content_sha256"]
        == hashlib.sha256(expected_json.encode("utf-8")).hexdigest()
    )
    assert created["revision"]["content"] == content
    assert created["head"] == {
        "subject_id": created["subject"]["id"],
        "annotation_kind": "training_caption",
        "active_revision_id": created["revision"]["id"],
        "reviewed_revision_id": None,
        "export_revision_id": None,
        "generation": 1,
    }

    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE annotation_revisions SET content_json = '{}' WHERE id = ?",
                (created["revision"]["id"],),
            )
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE annotation_subjects SET subject_key = 'changed' WHERE id = ?",
                (created["subject"]["id"],),
            )
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        with test_db.get_db() as conn:
            conn.execute(
                "DELETE FROM annotation_revisions WHERE id = ?",
                (created["revision"]["id"],),
            )


def test_deleting_project_cascades_complete_annotation_history(test_db) -> None:
    project_id, image_id = _create_library_project(
        test_db,
        "/library/annotation-delete.png",
        "Delete ledger project",
    )
    first = test_db.create_project_library_training_caption_revision(
        project_id,
        1,
        image_id,
        0,
        _content(1),
        "manual",
        "user",
        None,
        None,
    )
    second = test_db.create_project_library_training_caption_revision(
        project_id,
        1,
        image_id,
        1,
        _content(2),
        "manual",
        "user",
        None,
        None,
    )
    test_db.select_project_training_caption_head(
        project_id,
        1,
        first["subject"]["id"],
        "reviewed",
        first["revision"]["id"],
        2,
    )
    test_db.select_project_training_caption_head(
        project_id,
        1,
        first["subject"]["id"],
        "export",
        second["revision"]["id"],
        3,
    )

    test_db.delete_dataset_project_record(project_id, 1)

    with test_db.get_db() as conn:
        assert (
            conn.execute("SELECT COUNT(*) FROM annotation_subjects").fetchone()[0] == 0
        )
        assert (
            conn.execute("SELECT COUNT(*) FROM annotation_revisions").fetchone()[0] == 0
        )
        assert conn.execute("SELECT COUNT(*) FROM annotation_heads").fetchone()[0] == 0


def test_resolve_library_head_before_and_after_first_revision(test_db) -> None:
    project_id, image_id = _create_library_project(
        test_db,
        "/library/annotation-resolve.png",
        "Resolve project",
    )

    unresolved = test_db.resolve_project_library_training_caption_head(
        project_id,
        1,
        image_id,
    )
    subject_key = unresolved["subject_key"]
    assert unresolved == {
        "subject_key": subject_key,
        "subject": None,
        "head": None,
        "active_revision": None,
        "generation": 0,
    }
    assert subject_key.startswith(f"project_library:{image_id}:")

    created = test_db.create_project_library_training_caption_revision(
        project_id,
        1,
        image_id,
        0,
        _content(1),
        "manual",
        "user",
        None,
        None,
    )
    resolved = test_db.resolve_project_library_training_caption_head(
        project_id,
        1,
        image_id,
    )
    assert resolved["subject_key"] == subject_key
    assert resolved["subject"] == created["subject"]
    assert resolved["head"] == created["head"]
    assert resolved["active_revision"] == created["revision"]
    assert resolved["generation"] == 1


def test_replaced_library_file_gets_new_subject_without_inheriting_old_head(
    test_db,
) -> None:
    project_id, image_id = _create_library_project(
        test_db,
        "/library/annotation-replaced.png",
        "Replaced Library source",
    )
    first = test_db.create_project_library_training_caption_revision(
        project_id,
        1,
        image_id,
        0,
        _content(1),
        "manual",
        "user",
        None,
        None,
    )
    with test_db.get_db() as conn:
        source_path = Path(
            str(
                conn.execute(
                    "SELECT path FROM images WHERE id = ?",
                    (image_id,),
                ).fetchone()[0]
            )
        )
    source_path.write_bytes(b"replacement library source with a new identity")

    unresolved = test_db.resolve_project_library_training_caption_head(
        project_id,
        1,
        image_id,
    )
    assert unresolved["subject"] is None
    assert unresolved["active_revision"] is None
    assert unresolved["generation"] == 0
    assert unresolved["subject_key"] != first["subject"]["subject_key"]
    with pytest.raises(test_db.AnnotationSubjectIdentityConflictError):
        test_db.validate_project_training_caption_subject(
            project_id,
            1,
            first["subject"]["id"],
        )

    second = test_db.create_project_library_training_caption_revision(
        project_id,
        1,
        image_id,
        0,
        _content(2),
        "manual",
        "user",
        None,
        None,
    )
    assert second["subject"]["id"] != first["subject"]["id"]
    page = test_db.list_project_training_caption_heads(project_id, 1, None, 20)
    assert [item["subject"]["id"] for item in page["items"]] == [
        second["subject"]["id"]
    ]
    old_history = test_db.list_project_training_caption_revisions(
        project_id,
        1,
        first["subject"]["id"],
        None,
        20,
    )
    assert [revision["id"] for revision in old_history["items"]] == [
        first["revision"]["id"]
    ]


def test_head_cas_is_atomic_and_all_named_heads_are_selectable(test_db) -> None:
    project_id, image_id = _create_library_project(
        test_db,
        "/library/annotation-cas.png",
        "CAS project",
    )
    first = test_db.create_project_library_training_caption_revision(
        project_id,
        1,
        image_id,
        0,
        _content(1),
        "manual",
        "user",
        None,
        None,
    )

    with pytest.raises(test_db.AnnotationHeadConflictError) as conflict:
        test_db.create_project_library_training_caption_revision(
            project_id,
            1,
            image_id,
            0,
            _content(2),
            "manual",
            "user",
            None,
            None,
        )
    assert conflict.value.expected_generation == 0
    assert conflict.value.current_generation == 1
    with test_db.get_db() as conn:
        assert (
            conn.execute("SELECT COUNT(*) FROM annotation_revisions").fetchone()[0] == 1
        )

    second = test_db.create_project_library_training_caption_revision(
        project_id,
        1,
        image_id,
        1,
        _content(2),
        "manual",
        "user",
        None,
        None,
    )
    reviewed = test_db.select_project_training_caption_head(
        project_id,
        1,
        first["subject"]["id"],
        "reviewed",
        second["revision"]["id"],
        2,
    )
    exported = test_db.select_project_training_caption_head(
        project_id,
        1,
        first["subject"]["id"],
        "export",
        first["revision"]["id"],
        3,
    )
    assert reviewed["reviewed_revision_id"] == second["revision"]["id"]
    assert exported == {
        "subject_id": first["subject"]["id"],
        "annotation_kind": "training_caption",
        "active_revision_id": second["revision"]["id"],
        "reviewed_revision_id": second["revision"]["id"],
        "export_revision_id": first["revision"]["id"],
        "generation": 4,
    }


def test_project_heads_are_listed_with_active_revisions_in_stable_pages(
    test_db,
) -> None:
    source_paths = [
        Path(test_db.DATABASE_PATH).parent / f"annotation-page-{index}.png"
        for index in range(3)
    ]
    for index, source_path in enumerate(source_paths):
        source_path.write_bytes(f"page source {index}".encode("utf-8"))
    with test_db.get_db() as conn:
        image_ids = [
            int(
                conn.execute(
                    "INSERT INTO images (path, filename) VALUES (?, ?)",
                    (str(source_path.resolve()), source_path.name),
                ).lastrowid
            )
            for source_path in source_paths
        ]
    project = test_db.create_dataset_project_record(
        "Paged heads project",
        "paged heads project",
        [{"item_type": "library", "image_id": image_id} for image_id in image_ids],
        _SETTINGS_JSON,
    )
    project_id = int(project["id"])
    created = [
        test_db.create_project_library_training_caption_revision(
            project_id,
            1,
            image_id,
            0,
            _content(index),
            "manual",
            "user",
            None,
            None,
        )
        for index, image_id in enumerate(image_ids, start=1)
    ]

    first_page = test_db.list_project_training_caption_heads(
        project_id,
        1,
        None,
        2,
    )
    assert [item["subject"]["id"] for item in first_page["items"]] == [
        created[0]["subject"]["id"],
        created[1]["subject"]["id"],
    ]
    assert [item["head"] for item in first_page["items"]] == [
        created[0]["head"],
        created[1]["head"],
    ]
    assert [item["active_revision"] for item in first_page["items"]] == [
        created[0]["revision"],
        created[1]["revision"],
    ]
    assert first_page["has_more"] is True
    assert first_page["next_after_subject_id"] == created[1]["subject"]["id"]

    second_page = test_db.list_project_training_caption_heads(
        project_id,
        1,
        first_page["next_after_subject_id"],
        2,
    )
    assert [item["subject"]["id"] for item in second_page["items"]] == [
        created[2]["subject"]["id"],
    ]
    assert second_page["has_more"] is False
    assert second_page["next_after_subject_id"] is None

    with pytest.raises(test_db.AnnotationProjectNotFoundError):
        test_db.list_project_training_caption_heads(project_id + 999, 1, None, 2)
    with pytest.raises(test_db.AnnotationContentValidationError):
        test_db.list_project_training_caption_heads(project_id, 1, None, 201)


def test_restore_appends_history_and_pagination_is_stable(test_db) -> None:
    project_id, image_id = _create_library_project(
        test_db,
        "/library/annotation-history.png",
        "History project",
    )
    mutations = []
    for index in range(1, 4):
        mutations.append(
            test_db.create_project_library_training_caption_revision(
                project_id,
                1,
                image_id,
                index - 1,
                _content(index),
                "manual",
                "user",
                None,
                None,
            )
        )

    restored = test_db.restore_project_training_caption_revision(
        project_id,
        1,
        mutations[0]["subject"]["id"],
        mutations[0]["revision"]["id"],
        3,
    )
    assert restored["revision"]["id"] > mutations[-1]["revision"]["id"]
    assert restored["revision"]["parent_revision_id"] == mutations[-1]["revision"]["id"]
    assert (
        restored["revision"]["restored_from_revision_id"]
        == mutations[0]["revision"]["id"]
    )
    assert restored["revision"]["source_kind"] == "restore"
    assert restored["revision"]["content"] == mutations[0]["revision"]["content"]

    first_page = test_db.list_project_training_caption_revisions(
        project_id,
        1,
        mutations[0]["subject"]["id"],
        None,
        2,
    )
    assert [item["id"] for item in first_page["items"]] == [
        restored["revision"]["id"],
        mutations[2]["revision"]["id"],
    ]
    assert first_page["has_more"] is True
    assert first_page["next_before_revision_id"] == mutations[2]["revision"]["id"]

    second_page = test_db.list_project_training_caption_revisions(
        project_id,
        1,
        mutations[0]["subject"]["id"],
        first_page["next_before_revision_id"],
        2,
    )
    assert [item["id"] for item in second_page["items"]] == [
        mutations[1]["revision"]["id"],
        mutations[0]["revision"]["id"],
    ]
    assert second_page["has_more"] is False
    assert second_page["next_before_revision_id"] is None


def test_local_subject_survives_project_row_rebuild_and_rejects_changed_file(
    test_db,
    tmp_path: Path,
) -> None:
    local_path = tmp_path / "local.png"
    local_path.write_bytes(b"stable-local-source")
    project_id, local_item = _create_local_project(
        test_db,
        local_path,
        "Local project",
    )

    unresolved = test_db.resolve_project_local_training_caption_head(
        project_id,
        1,
        str(local_path.resolve()),
    )
    assert unresolved["subject"] is None
    assert unresolved["active_revision"] is None
    assert unresolved["generation"] == 0
    created = test_db.create_project_local_training_caption_revision(
        project_id,
        1,
        str(local_path.resolve()),
        0,
        _content(1),
        "manual",
        "user",
        None,
        None,
    )
    assert (
        test_db.validate_project_training_caption_subject(
            project_id,
            1,
            created["subject"]["id"],
        )
        == created["subject"]
    )

    updated = test_db.update_dataset_project_record(
        project_id,
        1,
        "Local project",
        "local project",
        [local_item],
        _SETTINGS_JSON,
    )
    assert updated["revision"] == 2
    resolved = test_db.resolve_project_local_training_caption_head(
        project_id,
        2,
        str(local_path.resolve()),
    )
    assert resolved["subject"]["id"] == created["subject"]["id"]
    assert resolved["active_revision"] == created["revision"]

    other_project_id, _other_image_id = _create_library_project(
        test_db,
        "/library/annotation-local-other-project.png",
        "Other local project",
    )
    with pytest.raises(test_db.AnnotationSubjectNotInProjectError):
        test_db.resolve_project_local_training_caption_head(
            other_project_id,
            1,
            str(local_path.resolve()),
        )

    local_path.write_bytes(b"replaced-local-source-with-different-size")
    with pytest.raises(test_db.AnnotationSubjectIdentityConflictError):
        test_db.resolve_project_local_training_caption_head(
            project_id,
            2,
            str(local_path.resolve()),
        )
    with pytest.raises(test_db.AnnotationSubjectIdentityConflictError):
        test_db.restore_project_training_caption_revision(
            project_id,
            2,
            created["subject"]["id"],
            created["revision"]["id"],
            1,
        )
    with pytest.raises(test_db.AnnotationSubjectIdentityConflictError):
        test_db.validate_project_training_caption_subject(
            project_id,
            2,
            created["subject"]["id"],
        )

    test_db.update_dataset_project_record(
        project_id,
        2,
        "Local project",
        "local project",
        [],
        _SETTINGS_JSON,
    )
    with pytest.raises(test_db.AnnotationSubjectNotInProjectError):
        test_db.validate_project_training_caption_subject(
            project_id,
            3,
            created["subject"]["id"],
        )


def test_strict_content_and_cross_project_subjects_fail_without_writes(test_db) -> None:
    first_project_id, first_image_id = _create_library_project(
        test_db,
        "/library/annotation-first-project.png",
        "First strict project",
    )
    second_project_id, second_image_id = _create_library_project(
        test_db,
        "/library/annotation-second-project.png",
        "Second strict project",
    )
    first = test_db.create_project_library_training_caption_revision(
        first_project_id,
        1,
        first_image_id,
        0,
        _content(1),
        "manual",
        "user",
        None,
        None,
    )
    second = test_db.create_project_library_training_caption_revision(
        second_project_id,
        1,
        second_image_id,
        0,
        _content(2),
        "metadata",
        "user",
        None,
        None,
    )
    assert second["revision"]["source_kind"] == "metadata"

    invalid_content: dict[str, object] = {
        **_content(3),
        "unexpected": "field",
    }
    with pytest.raises(test_db.AnnotationContentValidationError):
        test_db.create_project_library_training_caption_revision(
            first_project_id,
            1,
            first_image_id,
            1,
            invalid_content,
            "manual",
            "user",
            None,
            None,
        )
    unsupported_content_version = {
        **_content(3),
        "content_version": 2,
    }
    with pytest.raises(test_db.AnnotationContentValidationError):
        test_db.create_project_library_training_caption_revision(
            first_project_id,
            1,
            first_image_id,
            1,
            unsupported_content_version,
            "manual",
            "user",
            None,
            None,
        )
    with pytest.raises(test_db.AnnotationSubjectProjectConflictError):
        test_db.list_project_training_caption_revisions(
            second_project_id,
            1,
            first["subject"]["id"],
            None,
            20,
        )
    with pytest.raises(test_db.AnnotationRevisionSubjectConflictError):
        test_db.select_project_training_caption_head(
            first_project_id,
            1,
            first["subject"]["id"],
            "export",
            second["revision"]["id"],
            1,
        )
    with pytest.raises(test_db.AnnotationProjectRevisionConflictError):
        test_db.resolve_project_library_training_caption_head(
            first_project_id,
            99,
            first_image_id,
        )
    with test_db.get_db() as conn:
        assert (
            conn.execute("SELECT COUNT(*) FROM annotation_revisions").fetchone()[0] == 2
        )


def test_stale_project_revision_rejects_all_subject_operations_without_writes(
    test_db,
) -> None:
    project_id, image_id = _create_library_project(
        test_db,
        "/library/annotation-stale-project.png",
        "Stale project revision",
    )
    created = test_db.create_project_library_training_caption_revision(
        project_id,
        1,
        image_id,
        0,
        _content(1),
        "manual",
        "user",
        None,
        None,
    )
    test_db.update_dataset_project_record(
        project_id,
        1,
        "Stale project revision",
        "stale project revision",
        [{"item_type": "library", "image_id": image_id}],
        _SETTINGS_JSON,
    )

    with pytest.raises(test_db.AnnotationProjectRevisionConflictError):
        test_db.list_project_training_caption_revisions(
            project_id,
            1,
            created["subject"]["id"],
            None,
            20,
        )
    with pytest.raises(test_db.AnnotationProjectRevisionConflictError):
        test_db.list_project_training_caption_heads(project_id, 1, None, 20)
    with pytest.raises(test_db.AnnotationProjectRevisionConflictError):
        test_db.validate_project_training_caption_subject(
            project_id,
            1,
            created["subject"]["id"],
        )
    with pytest.raises(test_db.AnnotationProjectRevisionConflictError):
        test_db.restore_project_training_caption_revision(
            project_id,
            1,
            created["subject"]["id"],
            created["revision"]["id"],
            1,
        )
    with pytest.raises(test_db.AnnotationProjectRevisionConflictError):
        test_db.select_project_training_caption_head(
            project_id,
            1,
            created["subject"]["id"],
            "reviewed",
            created["revision"]["id"],
            1,
        )
    with test_db.get_db() as conn:
        assert (
            conn.execute("SELECT COUNT(*) FROM annotation_revisions").fetchone()[0] == 1
        )
        assert (
            conn.execute("SELECT generation FROM annotation_heads").fetchone()[0] == 1
        )
