"""Focused contracts for the Gallery WD14 writer provenance slice."""

from __future__ import annotations

import hashlib
import os
import sqlite3
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image

import db_images_write
import services.tagging.worker as tagging_worker
import tag_writer_provenance as provenance_contract
import migrations
from migrations._schema_common import table_exists
from services.dataset_review_service import (
    CaptionState,
    DatasetReviewRequest,
    ReviewIssueKind,
    build_dataset_review_queue,
)
from tag_writer_provenance import (
    TagWriterProvenance,
    build_wd14_writer_provenance,
    model_file_identity,
)


def _provenance_request(image_ids: list[int], cursor: str | None = None) -> DatasetReviewRequest:
    return DatasetReviewRequest(
        schema_version=1,
        image_ids=image_ids,
        caption_states=[
            CaptionState(image_id=image_id, has_content=True)
            for image_id in image_ids
        ],
        logical_count=len(image_ids),
        local_path_count=0,
        minimum_dimension=None,
        minimum_aesthetic=None,
        include_persisted_duplicates=False,
        issue_kinds=[ReviewIssueKind.METADATA_PROVENANCE_RISK],
        cursor=cursor,
        limit=1,
    )


def _add_image(test_db, path: str) -> int:
    return test_db.add_image(path=path, filename=Path(path).name)


def test_migration_035_is_idempotent_and_creates_the_writer_table(tmp_path: Path) -> None:
    migration = next(item for item in migrations.get_migrations() if item.version == 35)
    connection = sqlite3.connect(tmp_path / "migration.db")
    try:
        connection.execute(
            "CREATE TABLE images (id INTEGER PRIMARY KEY, path TEXT NOT NULL)"
        )
        assert migration.apply(connection) is True
        columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(tag_writer_provenance)")
        }
        assert {
            "image_id",
            "writer_family",
            "provider",
            "model",
            "revision",
            "runtime_provider",
        }.issubset(columns)
        required_columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(tag_writer_provenance)")
            if row[3] == 1
        }
        assert {
            "writer_family",
            "provider",
            "model",
            "revision",
            "runtime_provider",
            "content_fingerprint",
        }.issubset(required_columns)
        assert migration.apply(connection) is False
    finally:
        connection.close()


def test_migration_035_rejects_a_partially_present_writer_schema(
    tmp_path: Path,
) -> None:
    migration = next(item for item in migrations.get_migrations() if item.version == 35)
    connection = sqlite3.connect(tmp_path / "partial-migration.db")
    try:
        connection.execute(
            "CREATE TABLE images (id INTEGER PRIMARY KEY, path TEXT NOT NULL)"
        )
        connection.execute(
            "CREATE TABLE tag_writer_provenance (image_id INTEGER PRIMARY KEY)"
        )

        with pytest.raises(RuntimeError, match="partially present"):
            migration.apply(connection)
    finally:
        connection.close()


def test_migration_035_rejects_same_columns_with_broken_relations(
    tmp_path: Path,
) -> None:
    migration = next(item for item in migrations.get_migrations() if item.version == 35)
    connection = sqlite3.connect(tmp_path / "false-complete-migration.db")
    try:
        connection.execute(
            "CREATE TABLE images (id INTEGER PRIMARY KEY, path TEXT NOT NULL)"
        )
        connection.execute(
            """
            CREATE TABLE tag_writer_provenance (
                image_id TEXT NOT NULL,
                writer_family INTEGER NOT NULL,
                provider INTEGER NOT NULL,
                model INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                runtime_provider INTEGER NOT NULL,
                content_fingerprint INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX idx_tag_writer_provenance_provider_model
            ON tag_writer_provenance(model, provider, writer_family)
            """
        )

        with pytest.raises(RuntimeError, match="partially present"):
            migration.apply(connection)
    finally:
        connection.close()


def test_migration_036_tightens_nullable_writer_evidence_without_data_loss(
    tmp_path: Path,
) -> None:
    migration = next(item for item in migrations.get_migrations() if item.version == 36)
    connection = sqlite3.connect(tmp_path / "strict-migration.db")
    try:
        connection.execute(
            "CREATE TABLE images (id INTEGER PRIMARY KEY, path TEXT NOT NULL)"
        )
        connection.execute("INSERT INTO images (id, path) VALUES (1, 'image.png')")
        connection.execute(
            """
            CREATE TABLE tag_writer_provenance (
                image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
                writer_family TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                revision TEXT,
                runtime_provider TEXT NOT NULL,
                content_fingerprint TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (image_id, writer_family)
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX idx_tag_writer_provenance_provider_model
            ON tag_writer_provenance(writer_family, provider, model)
            """
        )
        connection.execute(
            """
            INSERT INTO tag_writer_provenance (
                image_id, writer_family, provider, model, revision,
                runtime_provider, content_fingerprint
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                1,
                "wd14",
                "huggingface",
                "SmilingWolf/wd-swinv2-tagger-v3",
                f"sha256:{'a' * 64}",
                "CPUExecutionProvider",
                "b" * 64,
            ),
        )

        assert migration.apply(connection) is True
        required_columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(tag_writer_provenance)")
            if row[3] == 1
        }
        assert required_columns == {
            "image_id",
            "writer_family",
            "provider",
            "model",
            "revision",
            "runtime_provider",
            "content_fingerprint",
            "created_at",
        }
        stored = connection.execute(
            """
            SELECT image_id, revision, content_fingerprint
            FROM tag_writer_provenance
            """
        ).fetchone()
        assert stored == (1, f"sha256:{'a' * 64}", "b" * 64)
        assert migration.apply(connection) is False
    finally:
        connection.close()


def test_migration_036_rejects_incomplete_rows_without_mutation(
    tmp_path: Path,
) -> None:
    migration = next(item for item in migrations.get_migrations() if item.version == 36)
    connection = sqlite3.connect(tmp_path / "invalid-strict-migration.db")
    try:
        connection.execute(
            "CREATE TABLE images (id INTEGER PRIMARY KEY, path TEXT NOT NULL)"
        )
        connection.execute("INSERT INTO images (id, path) VALUES (1, 'image.png')")
        connection.execute(
            """
            CREATE TABLE tag_writer_provenance (
                image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
                writer_family TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                revision TEXT,
                runtime_provider TEXT NOT NULL,
                content_fingerprint TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (image_id, writer_family)
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX idx_tag_writer_provenance_provider_model
            ON tag_writer_provenance(writer_family, provider, model)
            """
        )
        connection.execute(
            """
            INSERT INTO tag_writer_provenance (
                image_id, writer_family, provider, model, revision,
                runtime_provider, content_fingerprint
            ) VALUES (1, 'wd14', 'huggingface', 'model', NULL,
                      'CPUExecutionProvider', NULL)
            """
        )

        with pytest.raises(RuntimeError, match="1 existing row"):
            migration.apply(connection)

        stored = connection.execute(
            "SELECT revision, content_fingerprint FROM tag_writer_provenance"
        ).fetchone()
        assert stored == (None, None)
        assert not table_exists(connection, "tag_writer_provenance_v36")
    finally:
        connection.close()


class _WorkerSession:
    def __init__(self, providers: list[str]) -> None:
        self._providers = providers

    def get_providers(self) -> list[str]:
        return list(self._providers)


class _WorkerTagger:
    def __init__(self, model_path: Path) -> None:
        self._resolved_model_path = str(model_path)
        self.session = _WorkerSession(["CPUExecutionProvider"])
        self.use_gpu = False

    def load(self) -> None:
        self._loaded_model_file_identity = model_file_identity(
            self._resolved_model_path
        )
        self._loaded_model_file_sha256 = hashlib.sha256(
            Path(self._resolved_model_path).read_bytes()
        ).hexdigest()

    def tag_batch(self, image_paths, **_kwargs):
        results = [
            {
                "all_tags": [{"tag": "worker_tag", "confidence": 0.9}],
                "error": None,
            }
            for _path in image_paths
        ]
        runtime_info = {
            "requested_batch_size": 1,
            "effective_batch_size": 1,
            "fallbacks": [],
        }
        return results, runtime_info


class _FallbackWorkerTagger(_WorkerTagger):
    def __init__(self, model_path: Path) -> None:
        super().__init__(model_path)
        self.session = _WorkerSession(
            ["CUDAExecutionProvider", "CPUExecutionProvider"]
        )
        self.use_gpu = True
        self._did_fallback = False
        self.tag_batch_calls = 0

    def tag_batch(self, image_paths, **_kwargs):
        self.tag_batch_calls += 1
        results, runtime_info = super().tag_batch(image_paths, **_kwargs)
        if self._did_fallback:
            return results, runtime_info
        self.session = _WorkerSession(["CPUExecutionProvider"])
        self.use_gpu = False
        self._did_fallback = True
        runtime_info["used_cpu_fallback"] = False
        return results, runtime_info


class _ReplacingSourceWorkerTagger(_WorkerTagger):
    def tag_batch(self, image_paths, **kwargs):
        results, runtime_info = super().tag_batch(image_paths, **kwargs)
        source_stat = os.stat(image_paths[0])
        Image.new("RGB", (8, 8), color=(210, 190, 170)).save(
            image_paths[0],
            format="BMP",
        )
        os.utime(
            image_paths[0],
            ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns),
        )
        return results, runtime_info


class _ReplacingModelWorkerTagger(_WorkerTagger):
    def load(self) -> None:
        model_path = Path(self._resolved_model_path)
        source_stat = model_path.stat()
        self._loaded_model_file_sha256 = hashlib.sha256(
            model_path.read_bytes()
        ).hexdigest()
        self._loaded_model_file_identity = (
            int(source_stat.st_dev),
            int(source_stat.st_ino),
            int(source_stat.st_size),
            int(source_stat.st_mtime_ns),
        )
        model_path.write_bytes(b"modified-model")
        os.utime(
            model_path,
            ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns),
        )


class _ReloadingModelWorkerTagger(_WorkerTagger):
    def tag_batch(self, image_paths, **kwargs):
        results, runtime_info = super().tag_batch(image_paths, **kwargs)
        model_path = Path(self._resolved_model_path)
        model_path.write_bytes(b"worker-nodel")
        self.load()
        return results, runtime_info


class _WorkerQueue:
    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []

    def put(self, value: dict[str, object]) -> None:
        self.messages.append(value)


class _WorkerCancel:
    def is_set(self) -> bool:
        return False


def test_wd14_contract_records_model_hash_and_runtime_provider(tmp_path: Path) -> None:
    model_path = tmp_path / "model.onnx"
    model_bytes = b"wd14-model-fixture"
    model_path.write_bytes(model_bytes)
    expected_hash = hashlib.sha256(model_bytes).hexdigest()

    provenance = build_wd14_writer_provenance(
        effective_model_name="wd-swinv2-tagger-v3",
        requested_model_path=None,
        model_config={
            "runtime_backend": "wd14",
            "writer_family": "wd14",
            "repo_id": "SmilingWolf/wd-swinv2-tagger-v3",
        },
        resolved_model_path=str(model_path),
        runtime_providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        loaded_model_file_identity=model_file_identity(model_path),
        loaded_model_file_sha256=expected_hash,
    )

    assert provenance == TagWriterProvenance(
        writer_family="wd14",
        provider="huggingface",
        model="SmilingWolf/wd-swinv2-tagger-v3",
        revision=f"sha256:{expected_hash}",
        runtime_provider="CUDAExecutionProvider,CPUExecutionProvider",
    )
    custom = build_wd14_writer_provenance(
        effective_model_name="custom",
        requested_model_path=str(model_path),
        model_config={"runtime_backend": "wd14", "writer_family": "wd14"},
        resolved_model_path=str(model_path),
        runtime_providers=["CPUExecutionProvider"],
        loaded_model_file_identity=model_file_identity(model_path),
        loaded_model_file_sha256=expected_hash,
    )
    assert custom is not None
    assert custom.provider == "local_onnx"
    assert custom.model == f"local:{expected_hash}"


@pytest.mark.parametrize(
    "revision",
    [None, "", "sha256:broken", f"sha256:{'A' * 64}"],
)
def test_wd14_contract_rejects_unverifiable_model_revisions(
    revision: str | None,
) -> None:
    with pytest.raises(ValueError):
        TagWriterProvenance(
            writer_family="wd14",
            provider="huggingface",
            model="SmilingWolf/wd-swinv2-tagger-v3",
            revision=revision,
            runtime_provider="CPUExecutionProvider",
        )


@pytest.mark.parametrize(
    ("provider", "model", "runtime_provider"),
    [
        ("local_onnx", "not-a-local-model-hash", "CPUExecutionProvider"),
        ("huggingface", "not-a-repository-identity", "CPUExecutionProvider"),
        (
            "huggingface",
            "SmilingWolf/wd-swinv2-tagger-v3",
            "not-an-onnx-provider",
        ),
    ],
)
def test_wd14_contract_rejects_malformed_provider_model_or_runtime_identity(
    provider: str,
    model: str,
    runtime_provider: str,
) -> None:
    with pytest.raises(ValueError):
        TagWriterProvenance(
            writer_family="wd14",
            provider=provider,
            model=model,
            revision=f"sha256:{'a' * 64}",
            runtime_provider=runtime_provider,
        )


def test_worker_writes_wd14_provenance_in_the_tag_transaction(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "worker.png"
    Image.new("RGB", (8, 8), color=(12, 34, 56)).save(image_path)
    image_id = _add_image(test_db, str(image_path))
    model_path = tmp_path / "worker.onnx"
    model_path.write_bytes(b"worker-model")
    tagger = _WorkerTagger(model_path)
    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tagging_worker, "_e2e_tagger_getter", lambda **_kwargs: tagger)
    monkeypatch.setattr(tagging_worker, "verify_image_readable", lambda _path: (True, None))

    queue = _WorkerQueue()
    tagging_worker._tagging_worker_main(
        {
            "request": {
                "model_name": "wd-swinv2-tagger-v3",
                "image_ids": [image_id],
                "use_gpu": False,
            },
            "model_name": "wd-swinv2-tagger-v3",
            "effective_use_gpu": False,
            "fetch_batch_size": 1,
        },
        queue,
        _WorkerCancel(),
    )

    assert queue.messages[-1]["status"] == "done"
    rows = test_db.get_tag_writer_provenance_map([image_id])[image_id]
    assert rows[0]["provider"] == "huggingface"
    assert rows[0]["model"] == "SmilingWolf/wd-swinv2-tagger-v3"
    assert rows[0]["runtime_provider"] == "CPUExecutionProvider"
    assert rows[0]["revision"] == f"sha256:{hashlib.sha256(b'worker-model').hexdigest()}"


def test_worker_hashes_the_loaded_model_once_instead_of_once_per_batch(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_ids: list[int] = []
    for index in range(2):
        image_path = tmp_path / f"model-hash-{index}.png"
        Image.new("RGB", (8, 8), color=(12 + index, 34, 56)).save(image_path)
        image_ids.append(_add_image(test_db, str(image_path)))

    model_path = tmp_path / "model-hash.onnx"
    model_path.write_bytes(b"model-hash-fixture")
    tagger = _WorkerTagger(model_path)
    snapshot_calls = 0
    original_snapshot = provenance_contract.model_file_snapshot

    def counting_snapshot(path: str | Path):
        nonlocal snapshot_calls
        snapshot_calls += 1
        return original_snapshot(path)

    monkeypatch.setattr(provenance_contract, "model_file_snapshot", counting_snapshot)
    monkeypatch.setattr(
        tagging_worker,
        "model_file_snapshot",
        counting_snapshot,
        raising=False,
    )
    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tagging_worker, "_e2e_tagger_getter", lambda **_kwargs: tagger)
    monkeypatch.setattr(tagging_worker, "verify_image_readable", lambda _path: (True, None))

    queue = _WorkerQueue()
    tagging_worker._tagging_worker_main(
        {
            "request": {
                "model_name": "wd-swinv2-tagger-v3",
                "image_ids": image_ids,
                "use_gpu": False,
            },
            "model_name": "wd-swinv2-tagger-v3",
            "effective_use_gpu": False,
            "fetch_batch_size": 1,
        },
        queue,
        _WorkerCancel(),
    )

    assert queue.messages[-1]["status"] == "done"
    assert snapshot_calls == 1


@pytest.mark.parametrize("model_name", ["camie-tagger-v2", "pixai-tagger-v0.9"])
def test_worker_clears_wd14_identity_for_non_wd14_onnx_writers(
    model_name: str,
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / f"{model_name}.png"
    Image.new("RGB", (8, 8), color=(12, 34, 56)).save(image_path)
    image_id = _add_image(test_db, str(image_path))
    previous = TagWriterProvenance(
        writer_family="wd14",
        provider="huggingface",
        model="SmilingWolf/wd-swinv2-tagger-v3",
        revision=f"sha256:{'a' * 64}",
        runtime_provider="CPUExecutionProvider",
    )
    test_db.add_tags_batch(
        [
            {
                "image_id": image_id,
                "tags": [{"tag": "old_wd14_tag", "confidence": 0.9}],
                "content_fingerprint": "b" * 64,
                "writer_provenance": previous.model_dump(mode="python"),
            }
        ],
        default_source="tagger",
        replace_scope="pipeline",
    )
    model_path = tmp_path / f"{model_name}.onnx"
    model_path.write_bytes(b"non-wd14-model")
    tagger = _WorkerTagger(model_path)
    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tagging_worker, "_e2e_tagger_getter", lambda **_kwargs: tagger)
    monkeypatch.setattr(tagging_worker, "verify_image_readable", lambda _path: (True, None))

    queue = _WorkerQueue()
    tagging_worker._tagging_worker_main(
        {
            "request": {
                "model_name": model_name,
                "image_ids": [image_id],
                "use_gpu": False,
            },
            "model_name": model_name,
            "effective_use_gpu": False,
            "fetch_batch_size": 1,
        },
        queue,
        _WorkerCancel(),
    )

    assert queue.messages[-1]["status"] == "done"
    assert queue.messages[-1]["tagged"] == 1
    assert test_db.get_tag_writer_provenance_map([image_id]) == {}


def test_worker_rejects_wd14_success_without_runtime_provider_evidence(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "missing-provider.png"
    Image.new("RGB", (8, 8), color=(12, 34, 56)).save(image_path)
    image_id = _add_image(test_db, str(image_path))
    model_path = tmp_path / "missing-provider.onnx"
    model_path.write_bytes(b"worker-model")
    tagger = _WorkerTagger(model_path)
    tagger.session = None
    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tagging_worker, "_e2e_tagger_getter", lambda **_kwargs: tagger)

    queue = _WorkerQueue()
    tagging_worker._tagging_worker_main(
        {
            "request": {
                "model_name": "wd-swinv2-tagger-v3",
                "image_ids": [image_id],
                "use_gpu": False,
            },
            "model_name": "wd-swinv2-tagger-v3",
            "effective_use_gpu": False,
            "fetch_batch_size": 1,
        },
        queue,
        _WorkerCancel(),
    )

    assert queue.messages[-1]["status"] == "error"
    assert "runtime provider" in str(queue.messages[-1]["message"]).lower()
    assert test_db.get_image_tags(image_id) == []
    assert test_db.get_tag_writer_provenance_map([image_id]) == {}


def test_worker_rejects_a_model_file_replaced_after_session_load(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "model-replaced.png"
    Image.new("RGB", (8, 8), color=(12, 34, 56)).save(image_path)
    image_id = _add_image(test_db, str(image_path))
    model_path = tmp_path / "model-replaced.onnx"
    model_path.write_bytes(b"original-model")
    tagger = _ReplacingModelWorkerTagger(model_path)
    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tagging_worker, "_e2e_tagger_getter", lambda **_kwargs: tagger)
    monkeypatch.setattr(tagging_worker, "verify_image_readable", lambda _path: (True, None))

    queue = _WorkerQueue()
    tagging_worker._tagging_worker_main(
        {
            "request": {
                "model_name": "wd-swinv2-tagger-v3",
                "image_ids": [image_id],
                "use_gpu": False,
            },
            "model_name": "wd-swinv2-tagger-v3",
            "effective_use_gpu": False,
            "fetch_batch_size": 1,
        },
        queue,
        _WorkerCancel(),
    )

    assert queue.messages[-1]["status"] == "error"
    assert "model file changed" in str(queue.messages[-1]["message"]).lower()
    assert test_db.get_image_tags(image_id) == []
    assert test_db.get_tag_writer_provenance_map([image_id]) == {}


def test_worker_rejects_a_model_revision_changed_during_inference(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "model-reloaded.png"
    Image.new("RGB", (8, 8), color=(12, 34, 56)).save(image_path)
    image_id = _add_image(test_db, str(image_path))
    model_path = tmp_path / "model-reloaded.onnx"
    model_path.write_bytes(b"worker-model")
    tagger = _ReloadingModelWorkerTagger(model_path)
    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tagging_worker, "_e2e_tagger_getter", lambda **_kwargs: tagger)
    monkeypatch.setattr(tagging_worker, "verify_image_readable", lambda _path: (True, None))

    queue = _WorkerQueue()
    tagging_worker._tagging_worker_main(
        {
            "request": {
                "model_name": "wd-swinv2-tagger-v3",
                "image_ids": [image_id],
                "use_gpu": False,
            },
            "model_name": "wd-swinv2-tagger-v3",
            "effective_use_gpu": False,
            "fetch_batch_size": 1,
        },
        queue,
        _WorkerCancel(),
    )

    assert queue.messages[-1]["status"] == "done"
    assert queue.messages[-1]["tagged"] == 0
    assert queue.messages[-1]["errors"] == 1
    assert test_db.get_image_tags(image_id) == []
    assert test_db.get_tag_writer_provenance_map([image_id]) == {}


def test_worker_records_the_provider_chain_that_completed_inference(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_ids = []
    for index in range(2):
        image_path = tmp_path / f"provider-fallback-{index}.png"
        Image.new("RGB", (8, 8), color=(12, 34, 56)).save(image_path)
        image_ids.append(_add_image(test_db, str(image_path)))
    model_path = tmp_path / "provider-fallback.onnx"
    model_path.write_bytes(b"worker-model")
    tagger = _FallbackWorkerTagger(model_path)
    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tagging_worker, "_e2e_tagger_getter", lambda **_kwargs: tagger)
    monkeypatch.setattr(tagging_worker, "verify_image_readable", lambda _path: (True, None))

    queue = _WorkerQueue()
    tagging_worker._tagging_worker_main(
        {
            "request": {
                "model_name": "wd-swinv2-tagger-v3",
                "image_ids": image_ids,
                "use_gpu": True,
            },
            "model_name": "wd-swinv2-tagger-v3",
            "effective_use_gpu": True,
            "fetch_batch_size": 2,
        },
        queue,
        _WorkerCancel(),
    )

    assert queue.messages[-1]["status"] == "done"
    assert tagger.tag_batch_calls == 2
    stored = test_db.get_tag_writer_provenance_map(image_ids)
    assert set(stored) == set(image_ids)
    assert {
        rows[0]["runtime_provider"]
        for rows in stored.values()
    } == {"CPUExecutionProvider"}


def test_worker_does_not_publish_wd14_tags_without_an_image_fingerprint(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "missing-fingerprint.png"
    Image.new("RGB", (8, 8), color=(12, 34, 56)).save(image_path)
    image_id = _add_image(test_db, str(image_path))
    model_path = tmp_path / "missing-fingerprint.onnx"
    model_path.write_bytes(b"worker-model")
    tagger = _WorkerTagger(model_path)
    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tagging_worker, "_e2e_tagger_getter", lambda **_kwargs: tagger)
    monkeypatch.setattr(tagging_worker, "verify_image_readable", lambda _path: (True, None))
    monkeypatch.setattr(
        tagging_worker,
        "compute_image_content_fingerprint",
        lambda _path: (_ for _ in ()).throw(RuntimeError("fingerprint unavailable")),
    )

    queue = _WorkerQueue()
    tagging_worker._tagging_worker_main(
        {
            "request": {
                "model_name": "wd-swinv2-tagger-v3",
                "image_ids": [image_id],
                "use_gpu": False,
            },
            "model_name": "wd-swinv2-tagger-v3",
            "effective_use_gpu": False,
            "fetch_batch_size": 1,
        },
        queue,
        _WorkerCancel(),
    )

    assert queue.messages[-1]["status"] == "done"
    assert queue.messages[-1]["tagged"] == 0
    assert queue.messages[-1]["errors"] == 1
    assert test_db.get_image_tags(image_id) == []
    assert test_db.get_tag_writer_provenance_map([image_id]) == {}


def test_worker_does_not_bind_old_tags_to_a_replaced_source_image(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "replaced-during-inference.bmp"
    Image.new("RGB", (8, 8), color=(12, 34, 56)).save(image_path, format="BMP")
    image_id = _add_image(test_db, str(image_path))
    model_path = tmp_path / "replaced-during-inference.onnx"
    model_path.write_bytes(b"worker-model")
    tagger = _ReplacingSourceWorkerTagger(model_path)
    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tagging_worker, "_e2e_tagger_getter", lambda **_kwargs: tagger)
    monkeypatch.setattr(tagging_worker, "verify_image_readable", lambda _path: (True, None))

    queue = _WorkerQueue()
    tagging_worker._tagging_worker_main(
        {
            "request": {
                "model_name": "wd-swinv2-tagger-v3",
                "image_ids": [image_id],
                "use_gpu": False,
            },
            "model_name": "wd-swinv2-tagger-v3",
            "effective_use_gpu": False,
            "fetch_batch_size": 1,
        },
        queue,
        _WorkerCancel(),
    )

    assert queue.messages[-1]["status"] == "done"
    assert queue.messages[-1]["tagged"] == 0
    assert queue.messages[-1]["errors"] == 1
    assert test_db.get_image_tags(image_id) == []
    assert test_db.get_tag_writer_provenance_map([image_id]) == {}


def test_worker_accepts_a_filtered_zero_tag_result_without_orphaned_identity(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "filtered-empty.png"
    Image.new("RGB", (8, 8), color=(12, 34, 56)).save(image_path)
    image_id = _add_image(test_db, str(image_path))
    model_path = tmp_path / "filtered-empty.onnx"
    model_path.write_bytes(b"worker-model")
    tagger = _WorkerTagger(model_path)
    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tagging_worker, "_e2e_tagger_getter", lambda **_kwargs: tagger)
    monkeypatch.setattr(tagging_worker, "verify_image_readable", lambda _path: (True, None))
    monkeypatch.setattr(tagging_worker, "_apply_pre_tag_filters", lambda *_args, **_kwargs: [])

    queue = _WorkerQueue()
    tagging_worker._tagging_worker_main(
        {
            "request": {
                "model_name": "wd-swinv2-tagger-v3",
                "image_ids": [image_id],
                "use_gpu": False,
            },
            "model_name": "wd-swinv2-tagger-v3",
            "effective_use_gpu": False,
            "fetch_batch_size": 1,
        },
        queue,
        _WorkerCancel(),
    )

    assert queue.messages[-1]["status"] == "done"
    assert queue.messages[-1]["tagged"] == 1
    assert queue.messages[-1]["errors"] == 0
    assert image_id in test_db.get_image_ids_already_tagged([image_id])
    assert test_db.get_image_tags(image_id) == []
    assert test_db.get_tag_writer_provenance_map([image_id]) == {}


def test_tag_writer_provenance_is_atomic_and_legacy_rows_stay_unknown(
    test_db,
    tmp_path: Path,
) -> None:
    image_id = _add_image(test_db, str(tmp_path / "atomic.png"))
    model_path = tmp_path / "model.onnx"
    model_path.write_bytes(b"model")
    provenance = build_wd14_writer_provenance(
        effective_model_name="wd-swinv2-tagger-v3",
        requested_model_path=None,
        model_config={
            "runtime_backend": "wd14",
            "writer_family": "wd14",
            "repo_id": "SmilingWolf/wd-swinv2-tagger-v3",
        },
        resolved_model_path=str(model_path),
        runtime_providers=["CPUExecutionProvider"],
        loaded_model_file_identity=model_file_identity(model_path),
        loaded_model_file_sha256=hashlib.sha256(model_path.read_bytes()).hexdigest(),
    )
    assert provenance is not None

    test_db.add_tags_batch(
        [
            {
                "image_id": image_id,
                "tags": [{"tag": "generated", "confidence": 0.9}],
                "content_fingerprint": "1" * 64,
                "writer_provenance": provenance.model_dump(mode="python"),
            }
        ],
        default_source="tagger",
        replace_scope="pipeline",
    )
    stored = test_db.get_tag_writer_provenance_map([image_id])[image_id][0]
    assert stored["provider"] == "huggingface"
    assert stored["runtime_provider"] == "CPUExecutionProvider"
    assert stored["revision"].startswith("sha256:")

    with pytest.raises(ValueError, match="Invalid tag writer provenance"):
        test_db.add_tags_batch(
            [
                {
                    "image_id": image_id,
                    "tags": [{"tag": "should-not-commit", "confidence": 0.9}],
                    "writer_provenance": {
                        "writer_family": "wd14",
                        "provider": "huggingface",
                        "model": "SmilingWolf/wd-swinv2-tagger-v3",
                        "revision": "sha256:broken",
                    },
                }
            ],
            default_source="tagger",
            replace_scope="pipeline",
        )
    assert [row["tag"] for row in test_db.get_image_tags(image_id)] == ["generated"]
    assert test_db.get_tag_writer_provenance_map([image_id])[image_id][0]["revision"].startswith("sha256:")

    test_db.add_tags_batch(
        [
            {
                "image_id": image_id,
                "tags": [{"tag": "legacy", "confidence": 0.8}],
                "writer_provenance": None,
            }
        ],
        default_source="tagger",
        replace_scope="pipeline",
    )
    assert test_db.get_tag_writer_provenance_map([image_id]) == {}


def test_writer_provenance_requires_an_image_fingerprint_and_survives_non_writer_merges(
    test_db,
    tmp_path: Path,
) -> None:
    image_id = _add_image(test_db, str(tmp_path / "lifecycle.png"))
    model_path = tmp_path / "lifecycle.onnx"
    model_path.write_bytes(b"lifecycle-model")
    provenance = build_wd14_writer_provenance(
        effective_model_name="wd-swinv2-tagger-v3",
        requested_model_path=None,
        model_config={
            "runtime_backend": "wd14",
            "writer_family": "wd14",
            "repo_id": "SmilingWolf/wd-swinv2-tagger-v3",
        },
        resolved_model_path=str(model_path),
        runtime_providers=["CPUExecutionProvider"],
        loaded_model_file_identity=model_file_identity(model_path),
        loaded_model_file_sha256=hashlib.sha256(model_path.read_bytes()).hexdigest(),
    )
    assert provenance is not None

    with pytest.raises(ValueError, match="content fingerprint"):
        test_db.add_tags_batch(
            [
                {
                    "image_id": image_id,
                    "tags": [{"tag": "uncommitted", "confidence": 0.9}],
                    "writer_provenance": provenance.model_dump(mode="python"),
                }
            ],
            default_source="tagger",
            replace_scope="pipeline",
        )
    assert test_db.get_image_tags(image_id) == []
    assert test_db.get_tag_writer_provenance_map([image_id]) == {}

    fingerprint = "a" * 64
    test_db.add_tags_batch(
        [
            {
                "image_id": image_id,
                "tags": [
                    {"tag": "wd14_tag", "confidence": 0.9, "source": "tagger"}
                ],
                "content_fingerprint": fingerprint,
                "writer_provenance": provenance.model_dump(mode="python"),
            }
        ],
        default_source="tagger",
        replace_scope="pipeline",
    )
    test_db.add_tags_batch(
        [
            {
                "image_id": image_id,
                "tags": [
                    {"tag": "wd14_tag", "confidence": 0.9, "source": "tagger"},
                    {"tag": "vlm_tag", "confidence": 0.8, "source": "vlm"},
                ],
            }
        ],
        default_source=None,
        replace_scope="all",
    )
    stored = test_db.get_tag_writer_provenance_map([image_id])[image_id][0]
    assert stored["content_fingerprint"] == fingerprint


def test_manual_replace_clears_writer_identity_when_no_tagger_rows_remain(
    test_db,
    tmp_path: Path,
) -> None:
    image_id = _add_image(test_db, str(tmp_path / "manual-replace.png"))
    model_path = tmp_path / "manual-replace.onnx"
    model_path.write_bytes(b"manual-replace-model")
    provenance = build_wd14_writer_provenance(
        effective_model_name="wd-swinv2-tagger-v3",
        requested_model_path=None,
        model_config={
            "runtime_backend": "wd14",
            "writer_family": "wd14",
            "repo_id": "SmilingWolf/wd-swinv2-tagger-v3",
        },
        resolved_model_path=str(model_path),
        runtime_providers=["CPUExecutionProvider"],
        loaded_model_file_identity=model_file_identity(model_path),
        loaded_model_file_sha256=hashlib.sha256(model_path.read_bytes()).hexdigest(),
    )
    assert provenance is not None
    test_db.add_tags_batch(
        [
            {
                "image_id": image_id,
                "tags": [{"tag": "wd14_tag", "confidence": 0.9}],
                "content_fingerprint": "f" * 64,
                "writer_provenance": provenance.model_dump(mode="python"),
            }
        ],
        default_source="tagger",
        replace_scope="pipeline",
    )

    test_db.add_tags(
        image_id,
        [{"tag": "manual_only", "confidence": 1.0, "source": "manual"}],
        replace_scope="all",
    )

    assert test_db.get_tag_writer_provenance_map([image_id]) == {}


def test_source_change_clears_writer_provenance(
    test_db,
    tmp_path: Path,
) -> None:
    image_id = _add_image(test_db, str(tmp_path / "changed.png"))
    model_path = tmp_path / "changed.onnx"
    model_path.write_bytes(b"changed-model")
    provenance = build_wd14_writer_provenance(
        effective_model_name="wd-swinv2-tagger-v3",
        requested_model_path=None,
        model_config={
            "runtime_backend": "wd14",
            "writer_family": "wd14",
            "repo_id": "SmilingWolf/wd-swinv2-tagger-v3",
        },
        resolved_model_path=str(model_path),
        runtime_providers=["CPUExecutionProvider"],
        loaded_model_file_identity=model_file_identity(model_path),
        loaded_model_file_sha256=hashlib.sha256(model_path.read_bytes()).hexdigest(),
    )
    assert provenance is not None
    test_db.add_tags_batch(
        [
            {
                "image_id": image_id,
                "tags": [{"tag": "before_change", "confidence": 0.9}],
                "content_fingerprint": "b" * 64,
                "writer_provenance": provenance.model_dump(mode="python"),
            }
        ],
        default_source="tagger",
        replace_scope="pipeline",
    )

    with test_db.get_db() as connection:
        db_images_write._clear_image_derived_state(connection.cursor(), image_id)

    assert test_db.get_tag_writer_provenance_map([image_id]) == {}


def test_review_discloses_writer_identity_and_invalidates_cursor(
    test_db,
    tmp_path: Path,
) -> None:
    image_ids = [
        _add_image(test_db, str(tmp_path / "known.png")),
        _add_image(test_db, str(tmp_path / "legacy.png")),
    ]
    model_path = tmp_path / "model.onnx"
    model_path.write_bytes(b"review-model")
    provenance = build_wd14_writer_provenance(
        effective_model_name="wd-swinv2-tagger-v3",
        requested_model_path=None,
        model_config={
            "runtime_backend": "wd14",
            "writer_family": "wd14",
            "repo_id": "SmilingWolf/wd-swinv2-tagger-v3",
        },
        resolved_model_path=str(model_path),
        runtime_providers=["CPUExecutionProvider"],
        loaded_model_file_identity=model_file_identity(model_path),
        loaded_model_file_sha256=hashlib.sha256(model_path.read_bytes()).hexdigest(),
    )
    assert provenance is not None
    test_db.add_tags_batch(
        [
            {
                "image_id": image_ids[0],
                "tags": [{"tag": "known", "confidence": 0.9}],
                "content_fingerprint": "2" * 64,
                "writer_provenance": provenance.model_dump(mode="python"),
            },
            {
                "image_id": image_ids[1],
                "tags": [{"tag": "legacy", "confidence": 0.9}],
            },
        ],
        default_source="tagger",
        replace_scope="pipeline",
    )

    first = build_dataset_review_queue(_provenance_request(image_ids))
    known_issue = next(issue for issue in first.issues if issue.subjects[0].image_id == image_ids[0])
    assert any(
        "SmilingWolf/wd-swinv2-tagger-v3" in evidence.value_en
        for evidence in known_issue.evidence
    )
    state = next(item for item in first.provider_states if item.provider == "metadata_provenance")
    assert "SmilingWolf/wd-swinv2-tagger-v3" in state.reason_en
    legacy_response = build_dataset_review_queue(_provenance_request([image_ids[1]]))
    legacy_issue = legacy_response.issues[0]
    legacy_values = [evidence.value_en for evidence in legacy_issue.evidence]
    assert "Legacy/unknown tag-writer identity" in legacy_values
    assert all("Legacy/unknown WD14" not in value for value in legacy_values)
    assert first.next_cursor is not None

    with test_db.get_db() as connection:
        connection.execute(
            "UPDATE tag_writer_provenance SET revision = ? WHERE image_id = ?",
            (f"sha256:{'c' * 64}", image_ids[0]),
        )
    with pytest.raises(HTTPException) as error:
        build_dataset_review_queue(_provenance_request(image_ids, first.next_cursor))
    assert error.value.status_code == 409


def test_review_treats_mismatched_writer_fingerprint_as_stale(
    test_db,
    tmp_path: Path,
) -> None:
    image_id = _add_image(test_db, str(tmp_path / "stale.png"))
    model_path = tmp_path / "stale.onnx"
    model_path.write_bytes(b"stale-model")
    provenance = build_wd14_writer_provenance(
        effective_model_name="wd-swinv2-tagger-v3",
        requested_model_path=None,
        model_config={
            "runtime_backend": "wd14",
            "writer_family": "wd14",
            "repo_id": "SmilingWolf/wd-swinv2-tagger-v3",
        },
        resolved_model_path=str(model_path),
        runtime_providers=["CPUExecutionProvider"],
        loaded_model_file_identity=model_file_identity(model_path),
        loaded_model_file_sha256=hashlib.sha256(model_path.read_bytes()).hexdigest(),
    )
    assert provenance is not None
    test_db.add_tags_batch(
        [
            {
                "image_id": image_id,
                "tags": [{"tag": "stale_tag", "confidence": 0.9}],
                "content_fingerprint": "d" * 64,
                "writer_provenance": provenance.model_dump(mode="python"),
            }
        ],
        default_source="tagger",
        replace_scope="pipeline",
    )
    with test_db.get_db() as connection:
        connection.execute(
            "UPDATE images SET content_fingerprint = ? WHERE id = ?",
            ("e" * 64, image_id),
        )

    response = build_dataset_review_queue(_provenance_request([image_id]))
    issue_values = [evidence.value_en for evidence in response.issues[0].evidence]
    assert "Writer evidence fingerprint does not match the current image" in issue_values
    assert all(provenance.model not in value for value in issue_values)
    assert all(provenance.runtime_provider not in value for value in issue_values)
    state = next(
        item for item in response.provider_states if item.provider == "metadata_provenance"
    )
    assert "available for 0 image(s)" in state.reason_en
    assert "1 tagger image(s) remain legacy/unknown" in state.reason_en


def test_review_rejects_malformed_writer_provenance_and_skips_unrequested_reads(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_id = _add_image(test_db, str(tmp_path / "malformed.png"))
    test_db.add_tags_batch(
        [{"image_id": image_id, "tags": [{"tag": "legacy", "confidence": 0.9}]}],
        default_source="tagger",
        replace_scope="pipeline",
    )
    with test_db.get_db() as connection:
        connection.execute(
            "INSERT INTO tag_writer_provenance (image_id, writer_family, provider, model, revision, runtime_provider, content_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                image_id,
                "wd14",
                "bad-provider",
                "model",
                "sha256:x",
                "CPUExecutionProvider",
                "1" * 64,
            ),
        )
    with pytest.raises(ValueError, match="Invalid tag writer provenance"):
        build_dataset_review_queue(_provenance_request([image_id]))

    with test_db.get_db() as connection:
        connection.execute("DELETE FROM tag_writer_provenance WHERE image_id = ?", (image_id,))
        connection.execute(
            "INSERT INTO tag_writer_provenance (image_id, writer_family, provider, model, revision, runtime_provider, content_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                image_id,
                "wd14",
                "huggingface",
                "model",
                "sha256:broken",
                "CPUExecutionProvider",
                "1" * 64,
            ),
        )
    with pytest.raises(ValueError, match="Invalid tag writer provenance"):
        build_dataset_review_queue(_provenance_request([image_id]))

    with test_db.get_db() as connection:
        connection.execute("DELETE FROM tag_writer_provenance WHERE image_id = ?", (image_id,))
        connection.execute(
            "INSERT INTO tag_writer_provenance (image_id, writer_family, provider, model, revision, runtime_provider, content_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                image_id,
                "wd14",
                "local_onnx",
                "not-a-local-model-hash",
                f"sha256:{'a' * 64}",
                "CPUExecutionProvider",
                "1" * 64,
            ),
        )
    with pytest.raises(ValueError, match="Invalid tag writer provenance"):
        build_dataset_review_queue(_provenance_request([image_id]))

    def fail_if_read(_image_ids):
        raise AssertionError("writer provenance must not be read when the issue is omitted")

    monkeypatch.setattr(test_db, "get_tag_writer_provenance_map", fail_if_read)
    request = _provenance_request([image_id]).model_copy(
        update={"issue_kinds": [ReviewIssueKind.RATING_CONFLICT]}
    )
    build_dataset_review_queue(request)
