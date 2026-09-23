"""Multi-library isolation: clear/delete must not leak across workspaces."""

from __future__ import annotations

import queue
import threading
from pathlib import Path

from PIL import Image

import database as db
from library_context import (
    MAIN_LIBRARY_ID,
    get_current_library_id,
    reset_current_library_id,
    set_current_library_id,
)
import db_libraries as libdb


def _insert_image(path: str, library_id: str = MAIN_LIBRARY_ID) -> int:
    token = set_current_library_id(library_id)
    try:
        filename = path.replace("\\", "/").rsplit("/", 1)[-1]
        image_id = db.add_image(
            path=path,
            filename=filename,
            generator="unknown",
            width=64,
            height=64,
            file_size=100,
            is_readable=True,
        )
        return int(image_id)
    finally:
        reset_current_library_id(token)


def test_main_library_seeded_and_default_isolation(test_db):
    libdb.ensure_default_library()
    libs = libdb.list_libraries()
    assert any(item["id"] == MAIN_LIBRARY_ID and item["is_default"] for item in libs)

    a = _insert_image("/tmp/lib-main-a.png", MAIN_LIBRARY_ID)
    assert a > 0

    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        rows = db.get_images(limit=50)
    finally:
        reset_current_library_id(token)
    ids = {int(r["id"]) for r in rows}
    assert a in ids


def test_clear_current_library_keeps_other_libraries(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Training set")
    other_id = other["id"]

    main_id = _insert_image("/tmp/lib-clear-main.png", MAIN_LIBRARY_ID)
    other_img = _insert_image("/tmp/lib-clear-other.png", other_id)

    removed = libdb.clear_library_images(MAIN_LIBRARY_ID)
    assert removed >= 1

    with db.get_db() as conn:
        main_left = conn.execute(
            "SELECT COUNT(*) AS c FROM images WHERE COALESCE(library_id,'main') = ?",
            (MAIN_LIBRARY_ID,),
        ).fetchone()["c"]
        other_left = conn.execute(
            "SELECT COUNT(*) AS c FROM images WHERE COALESCE(library_id,'main') = ?",
            (other_id,),
        ).fetchone()["c"]
        still_other = conn.execute(
            "SELECT id FROM images WHERE id = ?",
            (other_img,),
        ).fetchone()

    assert int(main_left) == 0
    assert int(other_left) >= 1
    assert still_other is not None
    assert int(still_other["id"]) == other_img
    # main image gone
    with db.get_db() as conn:
        assert conn.execute("SELECT 1 FROM images WHERE id = ?", (main_id,)).fetchone() is None


def test_delete_library_protects_main_and_removes_images(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Temp pack")
    other_id = other["id"]
    img = _insert_image("/tmp/lib-del-other.png", other_id)

    try:
        libdb.delete_library(MAIN_LIBRARY_ID)
        assert False, "expected PermissionError"
    except PermissionError:
        pass

    result = libdb.delete_library(other_id)
    assert result["id"] == other_id
    assert result["removed_images"] >= 1
    assert libdb.get_library(other_id) is None
    with db.get_db() as conn:
        assert conn.execute("SELECT 1 FROM images WHERE id = ?", (img,)).fetchone() is None


def test_list_query_does_not_cross_libraries(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Isolated")
    other_id = other["id"]
    main_img = _insert_image("/tmp/lib-iso-main.png", MAIN_LIBRARY_ID)
    other_img = _insert_image("/tmp/lib-iso-other.png", other_id)

    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        main_rows = db.get_images(limit=100)
    finally:
        reset_current_library_id(token)
    main_ids = {int(r["id"]) for r in main_rows}
    assert main_img in main_ids
    assert other_img not in main_ids

    token = set_current_library_id(other_id)
    try:
        other_rows = db.get_images(limit=100)
    finally:
        reset_current_library_id(token)
    other_ids = {int(r["id"]) for r in other_rows}
    assert other_img in other_ids
    assert main_img not in other_ids


def test_path_conflict_does_not_steal_across_libraries(test_db):
    """Same disk path is unique — scanning into library B must not reassign A's row."""
    libdb.ensure_default_library()
    other = libdb.create_library("Training pack")
    other_id = other["id"]
    shared_path = "/tmp/lib-path-conflict-shared.png"

    main_id = _insert_image(shared_path, MAIN_LIBRARY_ID)
    with db.get_db() as conn:
        before = conn.execute(
            "SELECT id, COALESCE(library_id,'main') AS library_id FROM images WHERE id = ?",
            (main_id,),
        ).fetchone()
    assert before is not None
    assert str(before["library_id"]) == MAIN_LIBRARY_ID

    token = set_current_library_id(other_id)
    try:
        result_id, status = db.add_image(
            path=shared_path,
            filename="lib-path-conflict-shared.png",
            generator="unknown",
            width=64,
            height=64,
            file_size=100,
            is_readable=True,
            return_status=True,
        )
    finally:
        reset_current_library_id(token)

    assert int(result_id) == main_id
    assert status == "skipped_other_library"

    with db.get_db() as conn:
        after = conn.execute(
            "SELECT id, COALESCE(library_id,'main') AS library_id, COUNT(*) AS c FROM images WHERE path = ?",
            (shared_path,),
        ).fetchone()
        # path still one row, still owned by main
        row = conn.execute(
            "SELECT COALESCE(library_id,'main') AS library_id FROM images WHERE id = ?",
            (main_id,),
        ).fetchone()
        other_count = conn.execute(
            "SELECT COUNT(*) AS c FROM images WHERE COALESCE(library_id,'main') = ?",
            (other_id,),
        ).fetchone()["c"]

    assert str(row["library_id"]) == MAIN_LIBRARY_ID
    assert int(other_count) == 0

    token = set_current_library_id(other_id)
    try:
        other_rows = db.get_images(limit=100)
    finally:
        reset_current_library_id(token)
    assert all(int(r["id"]) != main_id for r in other_rows)


def test_claim_paths_and_move_images_between_libraries(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Claim target")
    other_id = other["id"]
    path = "/tmp/lib-claim-move.png"
    img_id = _insert_image(path, MAIN_LIBRARY_ID)

    claimed = libdb.claim_paths_to_library([path], other_id)
    assert claimed["moved"] == 1
    with db.get_db() as conn:
        row = conn.execute(
            "SELECT COALESCE(library_id,'main') AS library_id FROM images WHERE id = ?",
            (img_id,),
        ).fetchone()
    assert str(row["library_id"]) == other_id

    moved = libdb.move_images_to_library([img_id], MAIN_LIBRARY_ID)
    assert moved["moved"] == 1
    with db.get_db() as conn:
        row = conn.execute(
            "SELECT COALESCE(library_id,'main') AS library_id FROM images WHERE id = ?",
            (img_id,),
        ).fetchone()
    assert str(row["library_id"]) == MAIN_LIBRARY_ID


def test_export_library_index_contains_images_and_roots(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Export me")
    other_id = other["id"]
    _insert_image("/tmp/lib-export-a.png", other_id)
    token = set_current_library_id(other_id)
    try:
        db.add_library_root("/tmp/lib-export-root", label="Root")
        payload = libdb.export_library_index(other_id)
    finally:
        reset_current_library_id(token)
    assert payload["format"] == "sd-image-sorter-library-export-v1"
    assert payload["library"]["id"] == other_id
    assert payload["image_count"] >= 1
    assert any(img["path"].endswith("lib-export-a.png") for img in payload["images"])
    assert any((r.get("path") or "").endswith("lib-export-root") for r in payload["roots"])


def test_library_roots_are_scoped_per_library(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Roots B")
    other_id = other["id"]

    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        db.add_library_root("L:/Pics/MainOnly", label="Main")
    finally:
        reset_current_library_id(token)

    token = set_current_library_id(other_id)
    try:
        db.add_library_root("L:/Pics/OtherOnly", label="Other")
        # Same path can exist in two libraries after multi-library roots.
        db.add_library_root("L:/Pics/Shared", label="Shared B")
        other_roots = db.list_library_roots()
    finally:
        reset_current_library_id(token)

    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        db.add_library_root("L:/Pics/Shared", label="Shared A")
        main_roots = db.list_library_roots()
    finally:
        reset_current_library_id(token)

    main_paths = {r["path"] for r in main_roots}
    other_paths = {r["path"] for r in other_roots}
    assert "L:/Pics/MainOnly" in main_paths
    assert "L:/Pics/OtherOnly" not in main_paths
    assert "L:/Pics/OtherOnly" in other_paths
    assert "L:/Pics/MainOnly" not in other_paths
    assert "L:/Pics/Shared" in main_paths
    assert "L:/Pics/Shared" in other_paths


def _with_library(library_id: str):
    token = set_current_library_id(library_id)
    return token


def test_stats_counts_do_not_mix_libraries(test_db):
    """Empty library B must not inherit library A's All/generator/tag counts."""
    libdb.ensure_default_library()
    other = libdb.create_library("Empty workspace")
    other_id = other["id"]

    token = _with_library(MAIN_LIBRARY_ID)
    try:
        image_id = db.add_image(
            path="/tmp/lib-stats-main.png",
            filename="lib-stats-main.png",
            generator="comfyui",
            checkpoint="ponyXLV6.safetensors",
            width=64,
            height=64,
            file_size=100,
            is_readable=True,
            metadata_json="{}",
        )
        db.add_tags(int(image_id), [{"tag": "from_main", "confidence": 0.9}])
        main_count = db.get_image_count()
        main_gens = {row["generator"]: int(row["count"]) for row in db.get_all_generators()}
        main_tags = {row["tag"]: int(row["count"]) for row in db.get_all_tags()}
        main_folders = db.get_library_folders()
    finally:
        reset_current_library_id(token)

    assert main_count >= 1
    assert main_gens.get("comfyui", 0) >= 1
    assert main_tags.get("from_main", 0) >= 1
    assert "/tmp" in main_folders

    token = _with_library(other_id)
    try:
        assert db.get_image_count() == 0
        assert db.get_all_generators() == []
        assert db.get_all_tags() == []
        assert db.get_library_folders() == []
        assert db.get_untagged_image_ids() == []
        assert db.get_all_image_ids() == []
        assert db.get_metadata_status_counts() == {}
        assert db.get_all_checkpoints() == []
    finally:
        reset_current_library_id(token)


def test_generator_and_tag_caches_are_per_library(test_db):
    """A 60s cache primed on library A must not be served to library B."""
    libdb.ensure_default_library()
    other = libdb.create_library("Cache isolation")
    other_id = other["id"]

    token = _with_library(MAIN_LIBRARY_ID)
    try:
        image_id = _insert_image("/tmp/lib-cache-main.png", MAIN_LIBRARY_ID)
        db.add_tags(image_id, [{"tag": "cached_main", "confidence": 0.9}])
        primed_gens = db.get_all_generators()
        primed_tags = db.get_all_tags()
    finally:
        reset_current_library_id(token)

    assert primed_gens
    assert any(row["tag"] == "cached_main" for row in primed_tags)

    token = _with_library(other_id)
    try:
        assert db.get_all_generators() == []
        assert db.get_all_tags() == []
    finally:
        reset_current_library_id(token)


def test_mass_tag_iterators_stay_inside_current_library(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Tag target")
    other_id = other["id"]
    main_img = _insert_image("/tmp/lib-tag-main.png", MAIN_LIBRARY_ID)

    token = _with_library(other_id)
    try:
        assert main_img not in db.get_all_image_ids()
        assert main_img not in db.get_untagged_image_ids()
        assert all(main_img not in chunk for chunk in db.iter_all_image_id_chunks(chunk_size=10))
        assert all(main_img not in chunk for chunk in db.iter_untagged_image_id_chunks(chunk_size=10))
    finally:
        reset_current_library_id(token)


def test_stats_http_header_scopes_empty_library(test_client):
    libdb.ensure_default_library()
    other = libdb.create_library("HTTP empty")
    _insert_image("/tmp/lib-http-main.png", MAIN_LIBRARY_ID)

    main_stats = test_client.get("/api/stats").json()
    other_stats = test_client.get(
        "/api/stats",
        headers={"X-SD-Library-Id": other["id"]},
    ).json()
    other_folders = test_client.get(
        "/api/folders",
        headers={"X-SD-Library-Id": other["id"]},
    ).json()

    assert int(main_stats["total_images"]) >= 1
    assert int(other_stats["total_images"]) == 0
    assert other_stats["generators"] == []
    assert other_folders["folders"] == []


def test_favorites_and_collections_are_scoped_to_library(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Collection B")
    other_id = other["id"]

    token = _with_library(MAIN_LIBRARY_ID)
    try:
        image_id = _insert_image("/tmp/lib-fav-main.png", MAIN_LIBRARY_ID)
        db.set_favorite(image_id, True)
        created = db.create_collection("Main only set")
        db.set_collection_membership(created["id"], image_id, True)
        main_favs = db.get_favorites_count()
        main_names = {row["name"] for row in db.list_collections()}
    finally:
        reset_current_library_id(token)

    assert main_favs >= 1
    assert "Main only set" in main_names

    token = _with_library(other_id)
    try:
        assert db.get_favorites_count() == 0
        other_names = {row["name"] for row in db.list_collections()}
        assert "Main only set" not in other_names
        assert db.get_favorite_source_ids() == []
    finally:
        reset_current_library_id(token)


def test_dataset_projects_are_scoped_to_library(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Dataset B")
    other_id = other["id"]

    token = _with_library(MAIN_LIBRARY_ID)
    try:
        image_id = _insert_image("/tmp/lib-ds-main.png", MAIN_LIBRARY_ID)
        project = db.create_dataset_project_record(
            "Main dataset",
            "main dataset",
            [{"item_type": "library", "image_id": int(image_id)}],
            "{}",
        )
        main_names = {row["name"] for row in db.list_dataset_project_records(False)}
    finally:
        reset_current_library_id(token)

    assert "Main dataset" in main_names

    token = _with_library(other_id)
    try:
        other_names = {row["name"] for row in db.list_dataset_project_records(False)}
        assert "Main dataset" not in other_names
        try:
            db.get_dataset_project_record(project["id"])
            assert False, "expected DatasetProjectNotFoundError"
        except Exception as exc:
            assert "not found" in str(exc).lower() or exc.__class__.__name__.endswith("NotFoundError")
    finally:
        reset_current_library_id(token)


def test_entry_and_job_counts_are_scoped_to_library(test_db):
    from services.entry_stats_service import get_entry_summary
    from services.aesthetic_service import AestheticService

    libdb.ensure_default_library()
    other = libdb.create_library("Jobs B")
    other_id = other["id"]
    _insert_image("/tmp/lib-entry-main.png", MAIN_LIBRARY_ID)

    token = _with_library(MAIN_LIBRARY_ID)
    try:
        main_summary = get_entry_summary()
        main_color = db.count_images_missing_color_data()
        main_score = AestheticService().count_images_to_score(force=True)
    finally:
        reset_current_library_id(token)

    assert int(main_summary["library_total"]) >= 1
    assert main_color >= 1
    assert main_score >= 1

    token = _with_library(other_id)
    try:
        other_summary = get_entry_summary()
        assert int(other_summary["library_total"]) == 0
        assert db.count_images_missing_color_data() == 0
        assert AestheticService().count_images_to_score(force=True) == 0
        assert db.get_images_missing_color_data() == []
    finally:
        reset_current_library_id(token)


class _RecorderQueue:
    def __init__(self) -> None:
        self.messages = []

    def put(self, item) -> None:
        self.messages.append(item)


class _UnsetEvent:
    def is_set(self) -> bool:
        return False


def _insert_real_image(tmp_path: Path, name: str, library_id: str) -> int:
    path = tmp_path / name
    Image.new("RGB", (16, 16), color=(90, 60, 30)).save(path)
    return _insert_image(str(path), library_id)


def test_mass_tag_worker_entry_only_tags_its_library(test_db, monkeypatch, tmp_path):
    """The spawn worker must bind the plan's library before it lists images.

    Runs the real worker entry in-process with the deterministic stub tagger.
    Before the fix the child used the contextvar default and tagged main.
    """
    import services.tagging.worker as tagging_worker

    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    libdb.ensure_default_library()
    other_id = libdb.create_library("Worker target")["id"]
    main_img = _insert_real_image(tmp_path, "worker-main.png", MAIN_LIBRARY_ID)
    other_img = _insert_real_image(tmp_path, "worker-other.png", other_id)
    payload = {
        "request": {"model_name": "wd-swinv2-tagger-v3", "use_gpu": False},
        "model_name": "wd-swinv2-tagger-v3",
        "effective_use_gpu": False,
        "fetch_batch_size": 4,
        "library_id": other_id,
    }
    recorder = _RecorderQueue()

    tagging_worker._tagging_worker_main(payload, recorder, _UnsetEvent())

    assert recorder.messages[-1]["status"] == "done"
    assert recorder.messages[-1]["total"] == 1
    assert db.get_image_tags(other_img) != []
    assert db.get_image_tags(main_img) == []
    assert get_current_library_id() == MAIN_LIBRARY_ID


class _CapturingSpawnContext:
    """Records the worker's spawn args, then stops the run at process setup."""

    def __init__(self) -> None:
        self.plans = []

    def Queue(self):
        return queue.Queue()

    def Event(self):
        return threading.Event()

    def Process(self, target, args, daemon):
        self.plans.append(args[0])
        raise RuntimeError("stop after capturing the spawn args")


def test_mass_tag_job_hands_its_library_to_the_spawn_worker(test_db):
    """start_tagging captures the library; the job runs where none is bound."""
    from unittest.mock import patch

    from fastapi import BackgroundTasks

    from services.tagging_service import TaggingService, TagRequest

    libdb.ensure_default_library()
    other_id = libdb.create_library("Spawn target")["id"]
    service = TaggingService()
    service.set_tagger_getter(lambda **kwargs: object())
    background_tasks = BackgroundTasks()
    token = set_current_library_id(other_id)
    try:
        service.start_tagging(
            TagRequest(model_name="wd-swinv2-tagger-v3", use_gpu=False),
            background_tasks,
        )
    finally:
        reset_current_library_id(token)
    context = _CapturingSpawnContext()
    task = background_tasks.tasks[0]

    with patch.object(
        service, "_build_runtime_plan", return_value={"model_name": "wd-swinv2-tagger-v3"}
    ), patch(
        "services.tagging_service.multiprocessing.get_context", return_value=context
    ):
        # A fresh thread starts with an empty context, like the queue dispatcher.
        runner = threading.Thread(target=task.func, args=task.args, kwargs=task.kwargs)
        runner.start()
        runner.join(timeout=30)

    assert len(context.plans) == 1
    assert context.plans[0]["library_id"] == other_id


def test_queued_mass_tag_starts_in_the_library_it_was_queued_in(test_db):
    """The queue dispatcher thread has no library bound; the entry carries it."""
    from services._tagging_pipeline_persistence import _serialize_queue_entry
    from services.tagging_pipeline_service import (
        KIND_GALLERY,
        TaggingPipelineService,
        _QueuedPipelineJob,
    )
    from services.tagging_service import TagRequest

    seen = []

    class _Legacy:
        def start_tagging(self, request, background_tasks):
            seen.append(get_current_library_id())

    service = TaggingPipelineService(auto_dispatch=False)
    token = set_current_library_id("lib_queued")
    try:
        service._enqueue_locked(kind=KIND_GALLERY, payload=TagRequest(image_ids=[1]))
    finally:
        reset_current_library_id(token)
    queued = service._queue[0]
    restored, _seq = service._deserialize_persisted_entry(
        _serialize_queue_entry(queued, running=False)
    )
    entry = _QueuedPipelineJob(
        queue_id="q9", kind=KIND_GALLERY, payload=None, legacy_service=_Legacy(),
        library_id=restored.library_id,
    )

    service._start_queued_entry(entry)

    assert queued.library_id == "lib_queued"
    assert restored.library_id == "lib_queued"
    assert seen == ["lib_queued"]
    assert get_current_library_id() == MAIN_LIBRARY_ID


def test_prompt_stats_stay_inside_current_library(test_db):
    from services.prompt_service import PromptService

    libdb.ensure_default_library()
    other_id = libdb.create_library("Prompt B")["id"]
    image_id = _insert_image("/tmp/lib-prompt-main.png", MAIN_LIBRARY_ID)
    db.add_tags(image_id, [{"tag": "main_only", "confidence": 0.9}])
    with db.get_db() as conn:
        conn.execute("UPDATE images SET aesthetic_score = 8.0 WHERE id = ?", (image_id,))
    limits = dict(
        tag_limit=10, high_tag_limit=10, checkpoint_limit=10,
        leader_limit=10, recipe_limit=5, scored_limit=10,
    )

    main_stats = PromptService().get_prompt_stats(**limits)
    token = set_current_library_id(other_id)
    try:
        other_stats = PromptService().get_prompt_stats(**limits)
    finally:
        reset_current_library_id(token)

    assert main_stats["usable_images"] == 1
    assert [row["tag"] for row in main_stats["top_tags"]] == ["main_only"]
    assert other_stats["total_images"] == 0
    assert other_stats["usable_images"] == 0
    assert other_stats["top_tags"] == []
    assert other_stats["top_scored_images"] == []
