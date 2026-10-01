"""MS1b: the loaders' view of the trusted-model index (``model_external``).

A recorded file is used only while it is trusted and still what was recorded;
a stale one is never swapped for another file.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import model_external  # noqa: E402
import model_sources_store  # noqa: E402
from tests._external_helpers import ExternalWorld  # noqa: E402


@pytest.fixture
def world(tmp_path, monkeypatch) -> ExternalWorld:
    return ExternalWorld(tmp_path, monkeypatch)


def test_recorded_file_is_usable_and_reports_its_source(world):
    path = world.add_file("aesthetic-waifu", None, "models/waifu.safetensors")

    found = model_external.lookup("aesthetic-waifu")

    assert found is not None and found.is_ok
    assert found.path == str(path)
    assert found.source_info()["kind"] == "comfyui"
    assert model_external.usable_path("aesthetic-waifu") == str(path)


def test_nothing_recorded_means_none(world):
    assert model_external.lookup("florence2", "base") is None
    assert model_external.usable_path("florence2", "base") is None


def test_variants_are_kept_apart(world):
    world.add_file("wd14", "wd-vit-tagger-v3", "m/vit.onnx")

    assert model_external.usable_path("wd14", "wd-vit-tagger-v3")
    assert model_external.usable_path("wd14", "wd-eva02-large-tagger-v3") is None


def test_deleted_file_is_gone_and_refused(world, caplog):
    path = world.add_file("aesthetic-waifu", None, "w.safetensors")
    path.unlink()

    with caplog.at_level(logging.WARNING):
        assert model_external.usable_path("aesthetic-waifu") is None

    found = model_external.lookup("aesthetic-waifu")
    assert found is not None and found.state == model_external.STATE_GONE
    assert str(path) in found.problem()["message"]
    assert any(str(path) in r.getMessage() for r in caplog.records)


def test_changed_size_is_refused_not_replaced(world):
    path = world.add_file("aesthetic-waifu", None, "w.safetensors", b"a" * 10)
    path.write_bytes(b"b" * 11)

    found = model_external.lookup("aesthetic-waifu")

    assert found.state == model_external.STATE_CHANGED
    assert model_external.usable_path("aesthetic-waifu") is None
    assert "changed" in found.problem()["message"]
    assert found.problem()["message_key"] == "models.external.changed"


def test_same_size_but_newer_mtime_counts_as_changed(world):
    path = world.add_file("aesthetic-waifu", None, "w.safetensors", b"a" * 10)
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))

    assert (
        model_external.lookup("aesthetic-waifu").state == model_external.STATE_CHANGED
    )


def test_companion_that_vanished_makes_the_model_gone_or_changed(world):
    world.add_file(
        "wd14", "wd-vit-tagger-v3", "m/vit.onnx", companions={"m/vit.csv": b"tags"}
    )
    (world.root / "m" / "vit.csv").unlink()

    assert model_external.usable_path("wd14", "wd-vit-tagger-v3") is None


def test_folder_model_is_judged_by_the_sum_of_its_files(world):
    folder = world.add_folder(
        "florence2",
        "base",
        "hub/snap",
        {"config.json": b"{}", "model.safetensors": b"w" * 50},
    )
    assert model_external.usable_path("florence2", "base") == str(folder)

    (folder / "model.safetensors").write_bytes(b"w" * 51)

    assert (
        model_external.lookup("florence2", "base").state == model_external.STATE_CHANGED
    )


def test_untrusted_entry_is_ignored_even_when_the_index_lists_it(world):
    world.add_file("aesthetic-waifu", None, "w.safetensors")
    world.trusted.clear()

    assert model_external.lookup("aesthetic-waifu") is None
    assert model_external.usable_path("aesthetic-waifu") is None
    assert model_external.problem("aesthetic-waifu") is None


def test_hand_edited_index_cannot_widen_trust(world, tmp_path):
    outside = tmp_path / "elsewhere" / "w.safetensors"
    outside.parent.mkdir()
    outside.write_bytes(b"weights")
    stat = outside.stat()
    world.store.save_matches(
        [
            {
                "model_id": "aesthetic-waifu",
                "variant": None,
                "path": str(outside),
                "size_bytes": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
            }
        ]
    )

    assert model_external.usable_path("aesthetic-waifu") is None


def test_network_file_is_not_touched_on_the_request_thread(world, monkeypatch):
    unc = "\\\\nas\\models\\w.safetensors"
    world.trusted.append("\\\\nas\\models")
    world.store.save_matches(
        [{"model_id": "aesthetic-waifu", "variant": None, "path": unc, "size_bytes": 7}]
    )

    def explode(_entry):
        raise AssertionError("a network path was stat'ed")

    monkeypatch.setattr(model_external, "_stat_state", explode)

    found = model_external.lookup("aesthetic-waifu")

    assert found is not None and found.is_network and found.is_ok
    assert model_external.usable_path("aesthetic-waifu") == unc


def test_prefer_own_keeps_the_programs_file_over_a_trusted_copy(world, tmp_path):
    world.add_file("aesthetic-waifu", None, "ext.safetensors")
    own = tmp_path / "own" / "w.safetensors"
    own.parent.mkdir()
    own.write_bytes(b"mine")

    assert model_external.prefer_own(own, "aesthetic-waifu") == own


def test_prefer_own_falls_back_to_the_trusted_copy_then_to_own(world, tmp_path):
    external = world.add_file("aesthetic-waifu", None, "ext.safetensors")
    own = tmp_path / "own" / "w.safetensors"

    assert model_external.prefer_own(own, "aesthetic-waifu") == external

    external.unlink()
    assert model_external.prefer_own(own, "aesthetic-waifu") == own


def test_source_for_path_only_names_the_external_file_in_use(world):
    path = world.add_file("aesthetic-waifu", None, "ext.safetensors")

    assert (
        model_external.source_for_path("aesthetic-waifu", None, str(path))["kind"]
        == "comfyui"
    )
    assert (
        model_external.source_for_path("aesthetic-waifu", None, str(path) + "x") is None
    )
    assert model_external.source_for_path("aesthetic-waifu", None, None) is None


def test_artist_runtime_comes_from_the_recorded_companion(world):
    runtime = world.root / "custom_nodes" / "comfyui-lsnet"
    (runtime / "lsnet_model").mkdir(parents=True)
    world.add_file(
        "artist",
        "kaloscope2.0",
        "models/lsnet/best_checkpoint.pth",
        companions={"models/lsnet/class_mapping.csv": b"a,b"},
    )
    entry = world.entries[0]
    entry["companions"].append(str(runtime))
    world.save()

    assert model_external.artist_runtime_path() == str(runtime)
    assert model_external.usable_companion("artist", "kaloscope2.0", 0).endswith(
        "class_mapping.csv"
    )


def test_store_moves_a_vanished_match_to_lost_and_back(tmp_path):
    store = model_sources_store.ModelSourcesStore(tmp_path / "i.json")
    waifu = {"model_id": "aesthetic-waifu", "variant": None, "path": "w"}
    florence = {"model_id": "florence2", "variant": "base", "path": "f"}
    store.save_matches([waifu, florence])

    store.save_matches([florence])
    assert [m["model_id"] for m in store.lost()] == ["aesthetic-waifu"]

    reloaded = model_sources_store.ModelSourcesStore(tmp_path / "i.json")
    assert [m["model_id"] for m in reloaded.lost()] == ["aesthetic-waifu"]

    store.save_matches([florence, waifu])
    assert store.lost() == []


def test_lost_file_is_reported_with_its_path(world):
    path = world.add_file("aesthetic-waifu", None, "w.safetensors")
    path.unlink()
    world.store.save_matches([])  # what the next detect does

    assert model_external.lookup("aesthetic-waifu") is None
    found = model_external.problem("aesthetic-waifu")
    assert found is not None and found.state == model_external.STATE_GONE
    assert str(path) in found.problem()["message"]


def test_lost_entry_of_a_folder_that_is_no_longer_trusted_is_ignored(world):
    world.add_file("aesthetic-waifu", None, "w.safetensors")
    world.store.save_matches([])
    world.trusted.clear()

    assert model_external.problem("aesthetic-waifu") is None


def test_corrupt_index_rows_do_not_break_lookups(world):
    world.store._data["matches"] = ["junk", 3, None]
    world.store._data["lost"] = ["junk"]

    assert model_external.lookup("aesthetic-waifu") is None
    assert model_external.problem("aesthetic-waifu") is None


def test_a_stale_file_is_logged_once_per_state_not_on_every_refresh(world, caplog):
    path = world.add_file("aesthetic-waifu", None, "w.safetensors")
    path.unlink()
    model_external._warned_state.clear()

    with caplog.at_level(logging.WARNING):
        for _ in range(5):
            assert model_external.usable_path("aesthetic-waifu") is None

    assert len([r for r in caplog.records if str(path) in r.getMessage()]) == 1

    path.write_bytes(b"weights")
    assert model_external.usable_path("aesthetic-waifu") is None  # changed: new state, logs again
    assert len([r for r in caplog.records if str(path) in r.getMessage()]) == 2


def test_require_available_passes_for_a_fresh_install_and_an_intact_file(world):
    model_external.require_available("florence2", "base", "Florence-2")
    world.add_file("aesthetic-waifu", None, "w.safetensors")
    model_external.require_available("aesthetic-waifu", None, "Waifu head")


def test_forget_drops_the_recorded_and_the_lost_entry(world):
    path = world.add_file("aesthetic-waifu", None, "w.safetensors")
    path.unlink()
    with pytest.raises(model_external.ExternalModelUnavailable):
        model_external.require_available("aesthetic-waifu", None, "Waifu head")

    model_external.forget("aesthetic-waifu")

    model_external.require_available("aesthetic-waifu", None, "Waifu head")
    assert world.store.matches() == [] and world.store.lost() == []
