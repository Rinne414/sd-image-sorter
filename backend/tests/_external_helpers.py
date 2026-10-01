"""A fake ComfyUI tree plus the trusted-model index that records it (MS1b tests)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

import model_external
import model_roots
import model_sources_store

GGUF = b"GGUF" + b"\0" * 64


class ExternalWorld:
    """Files under ``root`` (trusted) recorded the way ``detect`` records them."""

    def __init__(self, tmp_path: Path, monkeypatch) -> None:
        self.root = tmp_path / "comfy"
        self.root.mkdir()
        self.store = model_sources_store.ModelSourcesStore(tmp_path / "index.json")
        self.entries: List[Dict[str, Any]] = []
        self.trusted: List[str] = [str(self.root)]
        monkeypatch.setattr(model_external, "_store_provider", lambda: self.store)
        monkeypatch.setattr(
            model_roots, "is_under_allowed_model_root", self._is_trusted
        )

    def _is_trusted(self, path: object, **_kwargs: Any) -> bool:
        key = os.path.normcase(os.path.normpath(str(path)))
        return any(
            key == os.path.normcase(os.path.normpath(root))
            or key.startswith(os.path.normcase(os.path.normpath(root)) + os.sep)
            for root in self.trusted
        )

    def write(self, rel: str, data: bytes = b"weights") -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def _entry(
        self,
        model_id: str,
        variant: Optional[str],
        path: Path,
        companions: Sequence[Path | str],
        size: int,
        mtime_ns: int,
        kind: str,
        verify: str,
    ) -> Dict[str, Any]:
        entry = {
            "model_id": model_id,
            "variant": variant,
            "path": str(path),
            "source": str(self.root),
            "folder": str(self.root),
            "source_kind": kind,
            "origin": "trusted",
            "verify": verify,
            "size_bytes": size,
            "mtime_ns": mtime_ns,
            "companions": [str(c) for c in companions],
            "notes": [],
            "trusted_rank": 0,
            "is_network": False,
            "total_bytes": size,
            "trusted": True,
        }
        self.entries.append(entry)
        return entry

    def add_file(
        self,
        model_id: str,
        variant: Optional[str],
        rel: str,
        data: bytes = b"weights",
        *,
        companions: Mapping[str, bytes] | None = None,
        kind: str = "comfyui",
        verify: str = "size",
    ) -> Path:
        path = self.write(rel, data)
        extra = [self.write(r, d) for r, d in (companions or {}).items()]
        stat = path.stat()
        self._entry(
            model_id, variant, path, extra, stat.st_size, stat.st_mtime_ns, kind, verify
        )
        self.save()
        return path

    def add_folder(
        self,
        model_id: str,
        variant: Optional[str],
        rel: str,
        files: Mapping[str, bytes],
        *,
        kind: str = "hf_cache",
        verify: str = "revision",
    ) -> Path:
        folder = self.root / rel
        written = [self.write(f"{rel}/{name}", data) for name, data in files.items()]
        stats = [p.stat() for p in written]
        self._entry(
            model_id,
            variant,
            folder,
            written,
            sum(s.st_size for s in stats),
            max(s.st_mtime_ns for s in stats),
            kind,
            verify,
        )
        self.save()
        return folder

    def save(self) -> None:
        self.store.save_matches(self.entries)
