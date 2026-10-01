"""CSD in the Model Center (S5): the optional card, Prepare, bulk list and the
Hugging Face cache matcher that finds the owner's existing copy."""

from __future__ import annotations

import dataclasses
import hashlib

import pytest

import csd_weights
import model_matchers
from services import model_service
from tests.test_model_matchers import (
    hf_root,
    make_file_of_size,
    matches_for,
    rejected_for,
    snapshot_dir,
)
from tests.test_model_service_pins import _base_health


@pytest.fixture
def inventory(monkeypatch):
    def build(csd_health):
        health = _base_health()
        health["csd"] = csd_health
        monkeypatch.setattr(model_service, "get_model_health", lambda: health)
        return {
            card["id"]: card
            for card in model_service.ModelService().build_model_inventory()
        }

    return build


class TestCard:
    def test_the_card_is_optional_and_states_license_source_and_size(self, inventory):
        card = inventory({"available": False, "expected_path": "/m/csd.bin"})["csd"]

        assert card["group_key"] == "models.group.artistId"
        assert card["download_supported"] is True
        assert card["status"] == "missing"
        assert card["external_links"][0]["url"] == csd_weights.CSD_LINK
        text = " ".join(card["setup_steps"]) + " " + card.get("note", "")
        assert "CC-BY-4.0" in text and "2.44 GB" in text and "torch" in text
        assert card["path"] == "/m/csd.bin"

    def test_ready_when_installed_with_its_runtime(self, inventory):
        card = inventory(
            {
                "available": True,
                "model_path": "/m/csd.bin",
                "message_key": "models.csd.ready",
                "message": "CSD is ready.",
            }
        )["csd"]
        assert card["status"] == "ready" and card["path"] == "/m/csd.bin"
        assert card["message_key"] == "models.csd.ready"

    def test_the_card_sits_after_the_artist_card(self, inventory):
        ids = list(inventory({"available": False}))
        assert ids.index("csd") == ids.index("artist") + 1


class TestPrepare:
    def test_prepare_sets_up_the_torch_runtime_then_downloads_the_pinned_file(
        self, monkeypatch
    ):
        order = []
        monkeypatch.setattr(
            model_service,
            "ensure_group",
            lambda group: order.append(("group", group))
            or model_service.DependencyInstallResult((), False),
        )
        monkeypatch.setattr(
            csd_weights,
            "prepare",
            lambda download: order.append(("weights", callable(download)))
            or {"csd_weights_path": "/m/csd.bin"},
        )

        result = model_service.ModelService().prepare_model("csd")

        assert order == [("group", "aesthetic"), ("weights", True)]
        assert result["status"] == "ok" and result["model_id"] == "csd"
        assert result["paths"] == {"csd_weights_path": "/m/csd.bin"}

    def test_a_fresh_runtime_install_asks_for_a_restart_before_downloading(
        self, monkeypatch
    ):
        monkeypatch.setattr(
            model_service,
            "ensure_group",
            lambda group: model_service.DependencyInstallResult(("torch",), True),
        )
        monkeypatch.setattr(
            csd_weights,
            "prepare",
            lambda download: pytest.fail("downloaded before the restart"),
        )

        result = model_service.ModelService().prepare_model("csd")

        assert result["status"] != "ok" or result.get("restart_recommended")

    def test_the_router_knows_the_dependency_group_and_the_bulk_entry(self):
        from routers import models as models_router

        assert models_router.MODEL_DEPENDENCY_GROUPS["csd"] == "aesthetic"
        entry = next(m for m in models_router.BULK_MODEL_BUNDLE if m["id"] == "csd")
        assert entry["size_bytes"] >= 2_438_228_893
        assert entry["recommended"] is False and entry["default_selected"] is False
        assert "csd" not in model_service.RECOMMENDED_MODEL_IDS


class TestMatcher:
    def test_the_owners_hf_cache_copy_is_found_by_the_pinned_sha(
        self, tmp_path, monkeypatch
    ):
        payload = b"csd weights"
        pin = dataclasses.replace(
            csd_weights.CSD_FILE,
            sha256=hashlib.sha256(payload).hexdigest(),
            size_bytes=len(payload),
        )
        monkeypatch.setattr(csd_weights, "CSD_FILE", pin)
        hub = tmp_path / "hub"
        snap = snapshot_dir(hub, pin.repo, pin.revision)
        (snap / pin.remote_path).write_bytes(payload)

        report = model_matchers.match_root(hf_root(hub))

        (match,) = matches_for(report, "csd")
        assert match.verify == "sha"
        assert match.path == str(snap / pin.remote_path)

    def test_a_same_size_file_with_other_bytes_is_rejected_when_hashing_is_allowed(
        self, tmp_path, monkeypatch
    ):
        pin = dataclasses.replace(
            csd_weights.CSD_FILE,
            sha256=hashlib.sha256(b"the real one").hexdigest(),
            size_bytes=12,
        )
        monkeypatch.setattr(csd_weights, "CSD_FILE", pin)
        hub = tmp_path / "hub"
        snap = snapshot_dir(hub, pin.repo, pin.revision)
        (snap / pin.remote_path).write_bytes(b"not the file")

        report = model_matchers.match_root(hf_root(hub))

        assert matches_for(report, "csd") == []
        assert rejected_for(report, "csd")[0].reason == "sha_mismatch"

    def test_the_full_size_file_is_matched_by_revision_and_size_without_hashing(
        self, tmp_path
    ):
        # Same policy as every multi-GB model (SHA_LIMIT_BYTES): the hub's
        # commit-named snapshot folder plus the exact size; the checksum is
        # enforced where the program downloads the file itself.
        pin = csd_weights.CSD_FILE
        hub = tmp_path / "hub"
        snap = snapshot_dir(hub, pin.repo, pin.revision)
        make_file_of_size(snap / pin.remote_path, pin.size_bytes, b"x")

        (match,) = matches_for(model_matchers.match_root(hf_root(hub)), "csd")

        assert "hash_skipped_large" in match.notes

    def test_a_file_of_another_size_is_rejected(self, tmp_path):
        pin = csd_weights.CSD_FILE
        hub = tmp_path / "hub"
        snap = snapshot_dir(hub, pin.repo, pin.revision)
        make_file_of_size(snap / pin.remote_path, pin.size_bytes - 1, b"x")

        report = model_matchers.match_root(hf_root(hub))

        assert matches_for(report, "csd") == []
        assert rejected_for(report, "csd")[0].reason == "size_mismatch"

    def test_another_revision_is_not_the_pinned_model(self, tmp_path):
        hub = tmp_path / "hub"
        snap = snapshot_dir(hub, csd_weights.CSD_FILE.repo, "f" * 40)
        (snap / "pytorch_model.bin").write_bytes(b"x")

        report = model_matchers.match_root(hf_root(hub))

        assert matches_for(report, "csd") == []
        assert rejected_for(report, "csd")[0].reason == "version_mismatch"


class TestHealth:
    def test_the_health_payload_carries_csd(self, monkeypatch, tmp_path):
        import model_health
        from tests.test_model_health_pins import _wire_clean_state

        _wire_clean_state(monkeypatch, tmp_path)
        monkeypatch.setattr(csd_weights, "models_dir", lambda: tmp_path / "csd")

        health = model_health.get_model_health()["csd"]

        assert health["available"] is False
        assert health["message_key"] == "models.csd.missing"
