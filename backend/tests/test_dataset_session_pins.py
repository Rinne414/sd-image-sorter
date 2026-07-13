"""Characterization pins for ``services/dataset_session_service.py`` (TIER-2 step 0).

The 1,076-line Dataset-Maker "small gallery" service is scheduled for a
behavior-neutral decomposition. These pins lock the load-bearing contracts the
existing reader suite (``test_dataset_session_service.py``) leaves uncovered so a
later split can be proven verbatim:

  * Module config constants (page-size cap, thumbnail size, TTLs, archive bomb
    guards, session-cache bound) — a split must carry these unchanged.
  * The ``ds:<sha1[:16]>`` id algorithm and its cross-producer coupling
    (``_ds_id_for_path`` / ``_manifest_item_for_path`` / ``_session_item_for_path`` /
    ``virtual_image_record_for_path`` must agree for the same resolved path).
  * IDENTITY SEAMS — the #1 decomposition hazard. ``dataset_export.planning`` and
    the ``dataset_export_service`` facade origin-import ``count_scan_manifest_paths``
    / ``iter_scan_manifest_paths`` / ``virtual_image_record_for_path``; ``engine`` and
    ``routers.dataset`` re-bind more. A split that re-homes any of these must keep
    ``other_module.X is dataset_session_service.X`` or those readers silently
    freeze a stale binding.
  * Scan-token manifest lifecycle: build (atomic NDJSON + JSON meta), load
    (expired / corrupt / invalid error contracts), iterate (NDJSON + legacy
    JSON-array back-compat), count (fast ``total_files_seen`` path vs slow
    exclude path).
  * The in-memory session-path allowlist that gates ``/api/dataset/local-thumbnail``
    against arbitrary-host-file reads: register/membership round trip, TTL
    eviction, refresh-on-access, the bounded LRU, and the SECURITY contract that
    ``resolve_paths_for_dataset`` does NOT grant membership.
  * ``purge_expired_scan_manifests`` TTL sweep + its "only touch <32hex> token
    files" safety contract.

No product code, existing test, or pyproject is modified. Every pin runs on a
scratch scan/upload dir (``_get_scan_dir`` / ``_UPLOAD_DIR`` seams patched to
tmp_path) and clears the module-global session cache, so nothing touches the
real ``data/dataset-scans`` / ``data/dataset-uploads`` trees or the main DB.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import time
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import services.dataset_session_service as dss  # noqa: E402
import services.dataset_export.planning as planning  # noqa: E402
import services.dataset_export_service as facade  # noqa: E402
import services.dataset_export.engine as export_engine  # noqa: E402
import routers.dataset as dataset_router  # noqa: E402

# --------------------------------------------------------------------------- #
# fixtures / helpers
# --------------------------------------------------------------------------- #


@pytest.fixture
def scan_dir(tmp_path, monkeypatch):
    """Redirect the scan-manifest dir to a per-test scratch dir.

    ``_get_scan_dir`` is the single seam every manifest read/write/purge routes
    through; patching it keeps NDJSON manifests out of the real
    ``backend/data/dataset-scans`` tree (the similarity-index isolation pattern).
    """
    d = tmp_path / "dataset-scans"
    d.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(dss, "_get_scan_dir", lambda: d)
    return d


@pytest.fixture(autouse=True)
def _isolate_session_state(scan_dir, tmp_path, monkeypatch):
    """Isolate every mutable module global touched by these pins.

    The session-path allowlist is a process-wide dict shared with the live
    endpoint; the upload dir is a lazily-cached module global. Clear/redirect
    both so pins never leak into each other or the real data tree.
    """
    monkeypatch.setattr(dss, "_UPLOAD_DIR", tmp_path / "dataset-uploads")
    dss._session_path_cache.clear()
    yield
    dss._session_path_cache.clear()


def _make_image(path: Path, color=(90, 140, 190)) -> Path:
    Image.new("RGB", (48, 32), color=color).save(path)
    return path


def _make_folder(
    root: Path, valid: int = 3, *, broken: bool = True, txt: bool = True
) -> Path:
    """A scan folder with ``valid`` readable images (+ optional broken PNG / txt)."""
    root.mkdir(parents=True, exist_ok=True)
    for i in range(valid):
        _make_image(root / f"img{i}.png", color=(i * 20, 100, 100))
    if broken:
        (root / "broken.png").write_bytes(b"not a real png")
    if txt:
        (root / "notes.txt").write_text("skip me", encoding="utf-8")
    return root


class _FakeUploadFile:
    def __init__(self, filename: str, content: bytes):
        self.filename = filename
        self._content = content
        self.file = BytesIO(content)

    async def read(self) -> bytes:
        return self._content


def _image_bytes(fmt: str = "PNG") -> bytes:
    buf = BytesIO()
    Image.new("RGB", (40, 32), color=(120, 80, 40)).save(buf, format=fmt)
    return buf.getvalue()


# =========================================================================== #
# 1. Module config constants — a split must carry these verbatim.
# =========================================================================== #


class TestConstants:
    def test_scan_and_thumbnail_sizing_pinned(self):
        assert dss.MAX_SCAN_RESULTS == 5_000
        assert dss.THUMBNAIL_MAX_PX == 256
        assert dss.THUMBNAIL_JPEG_QUALITY == 70
        # worker pool is clamped to [4, 16] regardless of CPU count
        assert 4 <= dss.SCAN_THUMB_WORKERS <= 16

    def test_ttl_archive_and_cache_bounds_pinned(self):
        assert dss.SCAN_TOKEN_TTL_SECONDS == 7 * 24 * 60 * 60  # 604800
        assert dss._MAX_ARCHIVE_ENTRIES == 20000
        assert dss._MAX_ARCHIVE_UNCOMPRESSED_BYTES == 2 * 1024 * 1024 * 1024
        assert dss._SESSION_PATH_TTL_SECONDS == 6 * 60 * 60  # 21600
        assert dss._SESSION_PATH_CACHE_MAX == 200_000

    def test_scan_token_regex_shape(self):
        assert dss._SCAN_TOKEN_RE.fullmatch("a" * 32)
        assert dss._SCAN_TOKEN_RE.fullmatch("f0" * 16)
        assert dss._SCAN_TOKEN_RE.fullmatch("A" * 32) is None  # lowercase hex only
        assert dss._SCAN_TOKEN_RE.fullmatch("a" * 31) is None
        assert dss._SCAN_TOKEN_RE.fullmatch("g" * 32) is None


# =========================================================================== #
# 2. ds_id algorithm + cross-producer coupling.
# =========================================================================== #


class TestDsIdAlgorithm:
    def test_ds_id_is_sha1_utf8_prefix16(self):
        p = r"C:\foo\bar.png"
        expected = (
            "ds:" + hashlib.sha1(p.encode("utf-8", errors="replace")).hexdigest()[:16]
        )
        assert dss._ds_id_for_path(p) == expected
        assert dss._ds_id_for_path(p).startswith("ds:")
        assert len(dss._ds_id_for_path(p)) == 19  # "ds:" + 16 hex

    def test_ds_id_coupled_across_all_producers(self, tmp_path):
        """Every item producer must stamp the same ds_id for the same resolved
        path — a split that re-homes one producer must not drift the id."""
        p = _make_image(tmp_path / "coupled.png")
        resolved = str(p.resolve())
        gold = dss._ds_id_for_path(resolved)

        assert dss._manifest_item_for_path(resolved, 0)["ds_id"] == gold
        assert dss._session_item_for_path(Path(resolved))["ds_id"] == gold
        assert dss.virtual_image_record_for_path(resolved)["ds_id"] == gold

    def test_is_image_path_uses_allowed_extension_set(self, tmp_path):
        assert dss._is_image_path(Path("x.PNG")) is True
        assert dss._is_image_path(Path("x.jpg")) is True
        assert dss._is_image_path(Path("x.txt")) is False
        assert dss._is_image_path(Path("noext")) is False


# =========================================================================== #
# 3. IDENTITY SEAMS — the dominant decomposition hazard.
# =========================================================================== #


class TestIdentitySeams:
    def test_planning_origin_imports_are_same_objects(self):
        # dataset_export/planning.py origin-imports these two; the export pin
        # suite patches nothing here, so a bare re-import in a split would
        # silently desync count/iter used by the export planner.
        assert planning.count_scan_manifest_paths is dss.count_scan_manifest_paths
        assert planning.iter_scan_manifest_paths is dss.iter_scan_manifest_paths

    def test_facade_reexports_are_same_objects(self):
        assert facade.count_scan_manifest_paths is dss.count_scan_manifest_paths
        assert facade.iter_scan_manifest_paths is dss.iter_scan_manifest_paths
        assert facade.virtual_image_record_for_path is dss.virtual_image_record_for_path

    def test_engine_and_router_bindings_are_same_objects(self):
        assert (
            export_engine.virtual_image_record_for_path
            is dss.virtual_image_record_for_path
        )
        assert dataset_router.iter_scan_manifest_paths is dss.iter_scan_manifest_paths
        assert dataset_router.scan_folder_for_dataset is dss.scan_folder_for_dataset
        assert (
            dataset_router.is_path_in_dataset_session is dss.is_path_in_dataset_session
        )
        assert dataset_router.resolve_paths_for_dataset is dss.resolve_paths_for_dataset
        assert dataset_router.upload_files_for_dataset is dss.upload_files_for_dataset
        assert dataset_router.MAX_SCAN_RESULTS == dss.MAX_SCAN_RESULTS


# =========================================================================== #
# 4. Scan-token path helpers + validation.
# =========================================================================== #


class TestTokenPathHelpers:
    def test_manifest_path_helpers_reject_bad_token(self):
        for bad in ("", "nope", "A" * 32, "a" * 31):
            with pytest.raises(ValueError, match="Invalid folder scan token"):
                dss._scan_manifest_path(bad)
            with pytest.raises(ValueError, match="Invalid folder scan token"):
                dss._scan_manifest_paths_path(bad)

    def test_manifest_path_helpers_build_expected_names(self, scan_dir):
        token = "ab" * 16
        assert dss._scan_manifest_path(token) == scan_dir / f"{token}.json"
        assert dss._scan_manifest_paths_path(token) == scan_dir / f"{token}.paths.jsonl"


# =========================================================================== #
# 5. Build + load manifest lifecycle (on scratch dir).
# =========================================================================== #


class TestManifestLifecycle:
    def test_build_writes_jsonl_paths_and_json_meta_atomically(
        self, scan_dir, tmp_path
    ):
        folder = _make_folder(tmp_path / "src")
        token, manifest = dss._build_scan_manifest(folder.resolve(), recursive=False)

        assert dss._SCAN_TOKEN_RE.fullmatch(token)
        assert manifest["manifest_format"] == "jsonl-items-v2"
        assert manifest["total_files_seen"] == 4  # 3 valid + broken.png, .txt excluded
        assert manifest["recursive"] is False
        assert manifest["paths_file"] == f"{token}.paths.jsonl"

        assert (scan_dir / f"{token}.json").exists()
        paths_file = scan_dir / f"{token}.paths.jsonl"
        assert paths_file.exists()
        lines = [
            ln
            for ln in paths_file.read_text(encoding="utf-8").splitlines()
            if ln.strip()
        ]
        assert len(lines) == 4
        assert all(isinstance(json.loads(ln), dict) for ln in lines)
        # no ".tmp" scratch file survives an atomic build
        assert not list(scan_dir.glob("*.tmp"))

    def test_load_missing_token_raises_expired(self, scan_dir):
        with pytest.raises(ValueError, match="expired"):
            dss._load_scan_manifest("bc" * 16)

    def test_load_corrupt_json_raises(self, scan_dir):
        token = "cd" * 16
        (scan_dir / f"{token}.json").write_text("{ not json", encoding="utf-8")
        with pytest.raises(ValueError, match="corrupt"):
            dss._load_scan_manifest(token)

    def test_load_non_dict_or_missing_paths_file_raises(self, scan_dir):
        non_dict = "de" * 16
        (scan_dir / f"{non_dict}.json").write_text("[1, 2, 3]", encoding="utf-8")
        with pytest.raises(ValueError, match="invalid"):
            dss._load_scan_manifest(non_dict)

        missing_paths = "ef" * 16
        (scan_dir / f"{missing_paths}.json").write_text(
            json.dumps(
                {
                    "folder_path": "/x",
                    "paths_file": "ffffffffffffffffffffffffffffffff.paths.jsonl",
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="expired"):
            dss._load_scan_manifest(missing_paths)


# =========================================================================== #
# 6. Manifest iteration / count contracts (the planning seams' behavior).
# =========================================================================== #


class TestManifestIteration:
    def test_iter_get_and_count_agree(self, scan_dir, tmp_path):
        folder = _make_folder(tmp_path / "src")
        result = dss.scan_folder_for_dataset(str(folder), limit=10)
        token = result["scan_token"]

        paths_iter = list(dss.iter_scan_manifest_paths(token))
        paths_get = dss.get_scan_manifest_paths(token)
        assert paths_iter == paths_get
        assert len(paths_iter) == 4  # manifest counts every image-ext file
        # fast path: no excludes -> reads total_files_seen straight from meta
        assert dss.count_scan_manifest_paths(token) == 4

    def test_count_with_excludes_takes_slow_path(self, scan_dir, tmp_path):
        folder = _make_folder(tmp_path / "src")
        token = dss.scan_folder_for_dataset(str(folder), limit=10)["scan_token"]
        all_paths = dss.get_scan_manifest_paths(token)

        assert dss.count_scan_manifest_paths(token, exclude_paths=[all_paths[0]]) == 3
        # an exclude that matches nothing still counts everyone
        assert (
            dss.count_scan_manifest_paths(token, exclude_paths=["/nope/none.png"]) == 4
        )

    def test_legacy_json_array_manifest_still_iterable(self, scan_dir):
        token = "1a" * 16
        legacy = {
            "folder_path": "/old",
            "paths": [r"C:\a\one.png", r"C:\a\two.png", ""],
        }
        (scan_dir / f"{token}.json").write_text(json.dumps(legacy), encoding="utf-8")

        # blank entries are dropped; order preserved
        assert dss.get_scan_manifest_paths(token) == [r"C:\a\one.png", r"C:\a\two.png"]
        # legacy manifests have no total_files_seen -> count falls to the walk
        assert dss.count_scan_manifest_paths(token) == 2

    def test_iter_entries_shape_and_registers_session_paths(self, scan_dir, tmp_path):
        folder = _make_folder(tmp_path / "src", valid=2, broken=False)
        token = dss.scan_folder_for_dataset(
            str(folder), limit=10, include_thumbnails=False
        )["scan_token"]

        dss._session_path_cache.clear()  # prove iter_entries itself registers
        entries = list(dss.iter_scan_manifest_entries(token))
        assert len(entries) == 2
        for entry in entries:
            assert set(entry) >= {"path", "filename", "scan_index", "size", "mtime"}
            assert dss.is_path_in_dataset_session(entry["path"]) is True


# =========================================================================== #
# 7. scan_folder_for_dataset behaviors beyond the reader suite.
# =========================================================================== #


class TestScanFolderExtras:
    def test_limit_is_clamped_to_max_scan_results(self, scan_dir, tmp_path):
        folder = _make_folder(tmp_path / "src", valid=2, broken=False, txt=False)
        over = dss.scan_folder_for_dataset(str(folder), limit=10_000)
        assert over["page_size"] == dss.MAX_SCAN_RESULTS  # > MAX clamps down
        zero = dss.scan_folder_for_dataset(str(folder), limit=0)
        assert zero["page_size"] == dss.MAX_SCAN_RESULTS  # 0 -> MAX default

    def test_scan_registers_surfaced_paths_only(self, scan_dir, tmp_path):
        folder = _make_folder(tmp_path / "src", valid=2, broken=False, txt=False)
        unscanned = _make_image(tmp_path / "outside.png")
        dss._session_path_cache.clear()

        result = dss.scan_folder_for_dataset(str(folder), limit=10)
        for item in result["items"]:
            assert dss.is_path_in_dataset_session(item["abs_path"]) is True
        # a real image never surfaced by this scan stays un-trusted (the gate
        # that stops /local-thumbnail becoming an arbitrary-file oracle)
        assert dss.is_path_in_dataset_session(str(unscanned)) is False

    def test_scan_token_reuses_manifest_without_folder_path(self, scan_dir, tmp_path):
        folder = _make_folder(tmp_path / "src", valid=5, broken=False, txt=False)
        first = dss.scan_folder_for_dataset(str(folder), limit=2)
        token = first["scan_token"]

        # empty folder_path is legal when a token is supplied: base + total come
        # from the cached manifest, not a fresh walk.
        second = dss.scan_folder_for_dataset(
            "", limit=2, offset=first["next_offset"], scan_token=token
        )
        assert second["scan_token"] == token
        assert second["total_files_seen"] == 5
        assert second["offset"] == 2
        assert second["next_offset"] == 4
        assert second["has_more"] is True
        assert {i["abs_path"] for i in first["items"]}.isdisjoint(
            {i["abs_path"] for i in second["items"]}
        )


# =========================================================================== #
# 8. Session-path allowlist — the /local-thumbnail security gate.
# =========================================================================== #


class TestSessionPathAllowlist:
    def test_register_then_membership_round_trip(self, tmp_path):
        p = _make_image(tmp_path / "member.png")
        assert dss.is_path_in_dataset_session(str(p)) is False
        dss._register_session_paths([str(p)])
        assert dss.is_path_in_dataset_session(str(p)) is True
        # empty / garbage never grants membership
        assert dss.is_path_in_dataset_session("") is False
        assert dss.is_path_in_dataset_session(str(tmp_path / "ghost.png")) is False

    def test_membership_normalizes_dot_segments(self, tmp_path):
        p = _make_image(tmp_path / "dotted.png")
        dss._register_session_paths([str(p.resolve())])
        messy = os.path.join(str(p.parent), ".", p.name)
        assert dss.is_path_in_dataset_session(messy) is True

    def test_expired_entry_is_evicted_on_access(self, tmp_path):
        p = _make_image(tmp_path / "stale.png")
        dss._register_session_paths([str(p)])
        key = dss._normalize_session_path(str(p))
        assert key in dss._session_path_cache

        dss._session_path_cache[key] = time.monotonic() - 1.0  # force-expire
        assert dss.is_path_in_dataset_session(str(p)) is False
        assert key not in dss._session_path_cache  # expired entry popped

    def test_access_refreshes_ttl(self, tmp_path):
        p = _make_image(tmp_path / "warm.png")
        dss._register_session_paths([str(p)])
        key = dss._normalize_session_path(str(p))
        before = dss._session_path_cache[key]
        assert dss.is_path_in_dataset_session(str(p)) is True
        assert dss._session_path_cache[key] >= before  # expiry bumped on hit

    def test_cache_is_bounded_by_max(self, tmp_path, monkeypatch):
        monkeypatch.setattr(dss, "_SESSION_PATH_CACHE_MAX", 2)
        dss._register_session_paths([str(tmp_path / f"p{i}.png") for i in range(6)])
        assert len(dss._session_path_cache) <= 2

    def test_register_scan_manifest_paths_for_session(self, scan_dir, tmp_path):
        folder = _make_folder(tmp_path / "src", valid=3, broken=False, txt=False)
        token = dss.scan_folder_for_dataset(
            str(folder), limit=10, include_thumbnails=False
        )["scan_token"]
        dss._session_path_cache.clear()

        registered = dss.register_scan_manifest_paths_for_session(token)
        assert registered == 3
        for path in dss.get_scan_manifest_paths(token):
            assert dss.is_path_in_dataset_session(path) is True
        # an invalid token swallows the ValueError and registers nothing
        assert dss.register_scan_manifest_paths_for_session("00" * 16) == 0

    def test_resolve_paths_does_not_grant_membership(self, tmp_path):
        """SECURITY: resolve_paths_for_dataset is the permissive helper; it must
        NOT put paths in the allowlist. Only scan/upload/manifest paths get
        trusted, so the thumbnail endpoint stays gated."""
        p = _make_image(tmp_path / "loose.png")
        out = dss.resolve_paths_for_dataset([str(p)])
        assert out == [str(p.resolve())]
        assert dss.is_path_in_dataset_session(str(p)) is False


# =========================================================================== #
# 9. resolve_paths_for_dataset / virtual_image_record_for_path shapes.
# =========================================================================== #


class TestResolveAndVirtualRecord:
    def test_resolve_paths_preserves_order_and_skips_dirs(self, tmp_path):
        a = _make_image(tmp_path / "a.png")
        b = _make_image(tmp_path / "b.png")
        out = dss.resolve_paths_for_dataset(
            [str(b), str(tmp_path), str(a), str(tmp_path / "ghost.png")]
        )
        assert out == [
            str(b.resolve()),
            str(a.resolve()),
        ]  # order kept, dir + missing dropped

    def test_virtual_record_key_set_and_sentinels(self, tmp_path):
        p = _make_image(tmp_path / "vr.png")
        rec = dss.virtual_image_record_for_path(str(p))
        assert set(rec) == {
            "id",
            "path",
            "filename",
            "ai_caption",
            "rating",
            "prompt",
            "negative_prompt",
            "checkpoint",
            "metadata",
            "metadata_json",
            "loras",
            "model_hash",
            "width",
            "height",
            "ds_id",
        }
        assert rec["id"] == 0  # sentinel, never stored
        assert rec["ai_caption"] is None and rec["rating"] is None

    def test_virtual_record_skip_dimensions_and_unreadable_leave_none(self, tmp_path):
        rec = dss.virtual_image_record_for_path(
            str(tmp_path / "x.png"), read_dimensions=False
        )
        assert rec["width"] is None and rec["height"] is None
        assert rec["filename"] == "x.png"
        # read_dimensions=True on a non-image swallows the open error -> None dims
        ghost = dss.virtual_image_record_for_path(str(tmp_path / "ghost.png"))
        assert ghost["width"] is None and ghost["height"] is None


# =========================================================================== #
# 10. Upload helpers + registration.
# =========================================================================== #


class TestUploadHelpers:
    def test_safe_uploaded_name_sanitization(self):
        assert dss._safe_uploaded_name("../../etc/passwd") == "passwd"
        assert dss._safe_uploaded_name("a b!@#.png") == "a b___.png"
        assert dss._safe_uploaded_name("", fallback="fb") == "fb"
        assert dss._safe_uploaded_name("   ", fallback="fb") == "fb"

    def test_archive_extract_result_defaults_zero(self):
        assert dss._ArchiveExtractResult().skipped == 0
        assert dss._ArchiveExtractResult(skipped=4).skipped == 4

    def test_try_import_rarfile_is_none_or_module(self):
        # env-dependent, but must never raise: soft-import returns module or None
        assert dss._try_import_rarfile() is None or hasattr(
            dss._try_import_rarfile(), "RarFile"
        )

    def test_upload_direct_image_registers_membership(self, tmp_path):
        result = asyncio.run(
            dss.upload_files_for_dataset([_FakeUploadFile("loose.png", _image_bytes())])
        )
        assert len(result["items"]) == 1
        abs_path = result["items"][0]["abs_path"]
        assert dss.is_path_in_dataset_session(abs_path) is True

    def test_upload_all_invalid_raises_valueerror(self, tmp_path):
        with pytest.raises(ValueError, match="No valid image files"):
            asyncio.run(
                dss.upload_files_for_dataset([_FakeUploadFile("readme.txt", b"nope")])
            )


# =========================================================================== #
# 11. purge_expired_scan_manifests — TTL sweep + safety contract.
# =========================================================================== #


class TestPurge:
    def test_purge_removes_old_token_files_keeps_fresh(self, scan_dir):
        old_json = scan_dir / ("a" * 32 + ".json")
        old_paths = scan_dir / ("b" * 32 + ".paths.jsonl")
        old_tmp = scan_dir / ("c" * 32 + ".tmp")
        fresh = scan_dir / ("d" * 32 + ".json")
        for f in (old_json, old_paths, old_tmp, fresh):
            f.write_text("{}", encoding="utf-8")

        aged = time.time() - 8 * 24 * 60 * 60  # older than the 7-day TTL
        for f in (old_json, old_paths, old_tmp):
            os.utime(f, (aged, aged))

        removed = dss.purge_expired_scan_manifests()
        assert removed == 3
        assert not old_json.exists() and not old_paths.exists() and not old_tmp.exists()
        assert fresh.exists()

    def test_purge_leaves_non_token_files_untouched(self, scan_dir):
        """SAFETY: only ``<32-hex>.json/.paths.jsonl/.tmp`` are eligible; anything
        else under the scan dir is left alone even when stale."""
        keepers = [
            scan_dir / "notes.txt",
            scan_dir / "short.json",  # not 32 hex
            scan_dir / ("A" * 32 + ".json"),  # uppercase -> not [a-f0-9]
        ]
        for f in keepers:
            f.write_text("x", encoding="utf-8")
        aged = time.time() - 8 * 24 * 60 * 60
        for f in keepers:
            os.utime(f, (aged, aged))

        assert dss.purge_expired_scan_manifests() == 0
        assert all(f.exists() for f in keepers)
