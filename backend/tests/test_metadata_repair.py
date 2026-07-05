"""Tests for metadata L3: raw envelope retention + the re-parse repair job.

Covers migration 023, the raw_metadata_gz write invariants (raw only lives on
missing-prompt rows), the targeted reparse DB update, and the repair service's
raw-replay / file-fallback / missing-source triage.
"""
from __future__ import annotations

import gzip
import json

import pytest

from services import metadata_repair_service as mrs


# A minimal-but-real ComfyUI graph the current parser CAN crack, stored the
# way a scan-time failure would have stored it (raw envelope of text chunks).
RECOVERABLE_GRAPH = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "meinamix_v11.safetensors"}},
    "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "1girl, silver hair, masterpiece", "clip": ["1", 1]}},
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, lowres", "clip": ["1", 1]}},
    "4": {"class_type": "EmptyLatentImage", "inputs": {"width": 832, "height": 1216, "batch_size": 1}},
    "5": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20, "cfg": 7.0, "sampler_name": "euler",
                                                "scheduler": "normal", "denoise": 1.0, "model": ["1", 0],
                                                "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0]}},
}


def _make_envelope(graph: dict) -> bytes:
    envelope = json.dumps({"prompt": json.dumps(graph)}, ensure_ascii=False)
    return gzip.compress(envelope.encode("utf-8"))


def _get_row(db, image_id: int) -> dict:
    with db.get_db() as conn:
        row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    assert row is not None
    return dict(row)


@pytest.fixture
def repair_env(test_db):
    mrs.set_active_job_id(None)
    yield test_db
    mrs.set_active_job_id(None)


class TestMigrationAndColumn:
    def test_migration_023_adds_raw_metadata_gz_column(self, test_db):
        with test_db.get_db() as conn:
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)").fetchall()}
        assert "raw_metadata_gz" in columns


class TestRawWriteInvariants:
    def test_add_image_stores_raw_for_missing_prompt(self, test_db):
        raw = _make_envelope(RECOVERABLE_GRAPH)
        image_id = test_db.add_image(
            path="C:/t/no_prompt.png", filename="no_prompt.png",
            generator="comfyui", prompt=None, raw_metadata_gz=raw,
        )
        assert _get_row(test_db, image_id)["raw_metadata_gz"] == raw

    def test_rescan_with_successful_prompt_clears_stale_raw(self, test_db):
        raw = _make_envelope(RECOVERABLE_GRAPH)
        image_id = test_db.add_image(
            path="C:/t/later_fixed.png", filename="later_fixed.png",
            generator="comfyui", prompt=None, raw_metadata_gz=raw,
        )
        # Same path re-scanned after a parser upgrade: prompt now resolves.
        second_id = test_db.add_image(
            path="C:/t/later_fixed.png", filename="later_fixed.png",
            generator="comfyui", prompt="1girl, solo",
        )
        assert second_id == image_id
        row = _get_row(test_db, image_id)
        assert row["prompt"] == "1girl, solo"
        assert row["raw_metadata_gz"] is None

    def test_rescan_without_raw_keeps_stored_raw(self, test_db):
        raw = _make_envelope(RECOVERABLE_GRAPH)
        image_id = test_db.add_image(
            path="C:/t/still_broken.png", filename="still_broken.png",
            generator="comfyui", prompt=None, raw_metadata_gz=raw,
        )
        # Placeholder-style rescan: still no prompt, no fresh raw supplied.
        test_db.add_image(
            path="C:/t/still_broken.png", filename="still_broken.png",
            generator="comfyui", prompt=None,
        )
        assert _get_row(test_db, image_id)["raw_metadata_gz"] == raw

    def test_update_image_metadata_clears_raw_on_recovered_prompt(self, test_db):
        raw = _make_envelope(RECOVERABLE_GRAPH)
        image_id = test_db.add_image(
            path="C:/t/file_reparse.png", filename="file_reparse.png",
            generator="comfyui", prompt=None, raw_metadata_gz=raw,
        )
        test_db.update_image_metadata(
            image_id=image_id, generator="comfyui", prompt="recovered prompt",
            negative_prompt=None, metadata_json=None, width=512, height=512,
            file_size=1000, checkpoint=None, loras=[],
        )
        assert _get_row(test_db, image_id)["raw_metadata_gz"] is None

    def test_update_image_metadata_keeps_raw_when_prompt_still_missing(self, test_db):
        raw = _make_envelope(RECOVERABLE_GRAPH)
        image_id = test_db.add_image(
            path="C:/t/file_reparse_fail.png", filename="file_reparse_fail.png",
            generator="comfyui", prompt=None, raw_metadata_gz=raw,
        )
        test_db.update_image_metadata(
            image_id=image_id, generator="comfyui", prompt=None,
            negative_prompt=None, metadata_json=None, width=512, height=512,
            file_size=1000, checkpoint=None, loras=[],
        )
        assert _get_row(test_db, image_id)["raw_metadata_gz"] == raw


class TestTargetedReparseUpdate:
    def test_updates_prompt_fields_only(self, test_db):
        raw = _make_envelope(RECOVERABLE_GRAPH)
        image_id = test_db.add_image(
            path="C:/t/targeted.png", filename="targeted.png",
            generator="unknown", prompt=None, width=832, height=1216,
            file_size=4321, checkpoint="scan_time_ckpt.safetensors",
            raw_metadata_gz=raw,
        )
        test_db.update_reparsed_prompt_fields(
            image_id,
            prompt="1girl, silver hair",
            negative_prompt="lowres",
            generator="comfyui",
        )
        row = _get_row(test_db, image_id)
        assert row["prompt"] == "1girl, silver hair"
        assert row["negative_prompt"] == "lowres"
        assert row["generator"] == "comfyui"
        # Untouched bookkeeping survives; scan-time checkpoint is preserved.
        assert row["width"] == 832 and row["height"] == 1216
        assert row["file_size"] == 4321
        assert row["checkpoint"] == "scan_time_ckpt.safetensors"
        assert row["raw_metadata_gz"] is None

    def test_prompt_tokens_follow_reparsed_prompt(self, test_db):
        image_id = test_db.add_image(
            path="C:/t/tokens.png", filename="tokens.png",
            generator="comfyui", prompt=None,
        )
        test_db.update_reparsed_prompt_fields(image_id, prompt="silver hair, red eyes")
        with test_db.get_db() as conn:
            tokens = {
                row["token"]
                for row in conn.execute(
                    "SELECT token FROM image_prompt_tokens WHERE image_id = ?",
                    (image_id,),
                ).fetchall()
            }
        assert "silver hair" in tokens and "red eyes" in tokens


class TestRepairService:
    def test_raw_replay_recovers_prompt(self, repair_env):
        db = repair_env
        raw = _make_envelope(RECOVERABLE_GRAPH)
        image_id = db.add_image(
            path="C:/t/replay_me.png", filename="replay_me.png",
            generator="comfyui", prompt=None, raw_metadata_gz=raw,
        )

        outcome = mrs._process_chunk([image_id])

        assert outcome["result_delta"]["recovered"] == 1
        assert outcome["result_delta"]["used_raw"] == 1
        assert outcome["result_delta"]["missing_source"] == 0
        row = _get_row(db, image_id)
        assert "silver hair" in row["prompt"]
        assert "worst quality" in row["negative_prompt"]
        assert row["checkpoint"] == "meinamix_v11.safetensors"
        assert row["raw_metadata_gz"] is None

    def test_row_without_raw_or_file_counts_missing_source(self, repair_env):
        db = repair_env
        image_id = db.add_image(
            path="C:/t/definitely/not/a/file.png", filename="gone.png",
            generator="comfyui", prompt=None,
        )
        outcome = mrs._process_chunk([image_id])
        delta = outcome["result_delta"]
        assert delta["missing_source"] == 1
        assert delta["recovered"] == 0

    def test_uncrackable_raw_without_file_stays_still_missing(self, repair_env):
        db = repair_env
        # An envelope whose graph carries no text at all — raw replay fails,
        # the file is gone, but the raw stays stored for future parsers.
        empty_graph = {"1": {"class_type": "CheckpointLoaderSimple",
                              "inputs": {"ckpt_name": "m.safetensors"}}}
        raw = _make_envelope(empty_graph)
        image_id = db.add_image(
            path="C:/t/definitely/not/a/file2.png", filename="gone2.png",
            generator="comfyui", prompt=None, raw_metadata_gz=raw,
        )
        outcome = mrs._process_chunk([image_id])
        delta = outcome["result_delta"]
        assert delta["still_missing"] == 1
        assert delta["missing_source"] == 0
        assert _get_row(db, image_id)["raw_metadata_gz"] == raw

    def test_snapshot_targets_only_readable_missing_prompt_rows(self, repair_env):
        db = repair_env
        missing_id = db.add_image(path="C:/t/m1.png", filename="m1.png", prompt=None)
        db.add_image(path="C:/t/ok.png", filename="ok.png", prompt="fine prompt")
        unreadable_id = db.add_image(path="C:/t/bad.png", filename="bad.png",
                                     prompt=None, is_readable=False, read_error="boom")
        ids = mrs.snapshot_missing_prompt_ids()
        assert missing_id in ids
        assert unreadable_id not in ids
        assert len(ids) == 1

    def test_active_job_slot_single_flight(self, repair_env):
        from services.bulk_job_service import JOB_KIND_REPARSE_METADATA, get_bulk_job_service

        service = get_bulk_job_service()
        first = service.create_job(JOB_KIND_REPARSE_METADATA)
        second = service.create_job(JOB_KIND_REPARSE_METADATA)
        assert mrs.set_active_job_id(first) is True
        # first is still queued -> the slot is taken.
        assert mrs.set_active_job_id(second) is False
        service.cancel_job(first)
        service.run_job(first, lambda handle: None)  # settles to cancelled
        assert mrs.set_active_job_id(second) is True


class TestScanCaptureChain:
    def test_scan_stores_raw_envelope_for_unparseable_comfyui_png(self, repair_env, tmp_path):
        """End-to-end capture: PNG whose graph has no text -> raw lands in DB."""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        import image_manager

        db = repair_env
        no_text_graph = {
            "1": {"class_type": "CheckpointLoaderSimple",
                  "inputs": {"ckpt_name": "m.safetensors"}},
            "2": {"class_type": "KSampler",
                  "inputs": {"seed": 1, "steps": 20, "cfg": 7.0,
                              "sampler_name": "euler", "scheduler": "normal",
                              "denoise": 1.0, "model": ["1", 0]}},
        }
        png_path = tmp_path / "unparseable.png"
        info = PngInfo()
        info.add_text("prompt", json.dumps(no_text_graph))
        Image.new("RGB", (64, 64), color=(120, 40, 200)).save(png_path, pnginfo=info)

        job_result = image_manager._parse_metadata_job({
            "path": str(png_path),
            "filename": png_path.name,
            "validate_image_data": False,
        })
        record = job_result["record"]
        assert record["prompt"] in (None, "")
        assert record["raw_metadata_gz"], "scan record must carry the gzipped envelope"

        envelope = json.loads(gzip.decompress(record["raw_metadata_gz"]).decode("utf-8"))
        assert json.loads(envelope["prompt"]) == no_text_graph

        db.add_images_batch([record])
        with db.get_db() as conn:
            row = conn.execute(
                "SELECT raw_metadata_gz FROM images WHERE filename = ?",
                (png_path.name,),
            ).fetchone()
        assert row is not None and row["raw_metadata_gz"] == record["raw_metadata_gz"]

    def test_scan_stores_no_raw_when_prompt_parses(self, repair_env, tmp_path):
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        import image_manager

        png_path = tmp_path / "parses_fine.png"
        info = PngInfo()
        info.add_text("prompt", json.dumps(RECOVERABLE_GRAPH))
        Image.new("RGB", (64, 64), color=(10, 90, 30)).save(png_path, pnginfo=info)

        job_result = image_manager._parse_metadata_job({
            "path": str(png_path),
            "filename": png_path.name,
            "validate_image_data": False,
        })
        record = job_result["record"]
        assert record["prompt"] and "silver hair" in record["prompt"]
        assert record["raw_metadata_gz"] is None


class TestMetadataHealth:
    def test_counts_by_generator(self, repair_env):
        db = repair_env
        raw = _make_envelope(RECOVERABLE_GRAPH)
        db.add_image(path="C:/t/h1.png", filename="h1.png", generator="comfyui",
                     prompt="has prompt")
        db.add_image(path="C:/t/h2.png", filename="h2.png", generator="comfyui",
                     prompt=None, raw_metadata_gz=raw)
        db.add_image(path="C:/t/h3.png", filename="h3.png", generator="webui",
                     prompt=None)

        health = mrs.get_metadata_health()

        assert health["totals"]["total"] == 3
        assert health["totals"]["missing_prompt"] == 2
        assert health["totals"]["with_raw"] == 1
        by_gen = {item["generator"]: item for item in health["generators"]}
        assert by_gen["comfyui"]["total"] == 2
        assert by_gen["comfyui"]["missing_prompt"] == 1
        assert by_gen["comfyui"]["with_raw"] == 1
        assert by_gen["webui"]["missing_prompt"] == 1
        assert by_gen["webui"]["with_raw"] == 0
