#!/usr/bin/env python3
"""Verify compiled lock files were refreshed after their source inputs changed."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT / "backend"
LOCK_INPUT_HASH_PREFIX = "# lock-input-sha256: "
LOCK_TARGETS = {
    "requirements-core.txt": ("requirements-core.in",),
    "requirements.txt": ("requirements.in",),
    "requirements-dev.txt": ("requirements-core.in", "requirements-core.txt", "requirements-dev.in"),
}


def _compute_input_hash(input_names: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    for name in input_names:
        path = BACKEND_DIR / name
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        # Normalize line endings before hashing so the stamp matches across
        # platforms. Windows checkouts have CRLF in the working tree while
        # Linux CI has LF; hashing raw bytes would otherwise produce a stamp
        # that only validates on the platform where it was written.
        text = path.read_text(encoding="utf-8")
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        digest.update(normalized.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def _read_lockfile(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _extract_embedded_hash(text: str) -> str:
    for line in text.splitlines():
        if line.startswith(LOCK_INPUT_HASH_PREFIX):
            return line[len(LOCK_INPUT_HASH_PREFIX):].strip().lower()
    return ""


def _stamp_lockfile(text: str, expected_hash: str) -> str:
    lines = text.splitlines()
    hash_line = f"{LOCK_INPUT_HASH_PREFIX}{expected_hash}"

    for index, line in enumerate(lines):
        if line.startswith(LOCK_INPUT_HASH_PREFIX):
            lines[index] = hash_line
            return "\n".join(lines) + "\n"

    insert_at = len(lines)
    for index, line in enumerate(lines):
        if line and not line.startswith("#"):
            insert_at = index
            break

    lines.insert(insert_at, hash_line)
    lines.insert(insert_at + 1, "#")
    return "\n".join(lines) + "\n"


def _check_lockfile(lock_name: str, *, write: bool) -> bool:
    lock_path = BACKEND_DIR / lock_name
    current_text = _read_lockfile(lock_path)
    expected_hash = _compute_input_hash(LOCK_TARGETS[lock_name])
    embedded_hash = _extract_embedded_hash(current_text)

    if write:
        stamped_text = _stamp_lockfile(current_text, expected_hash)
        if stamped_text != current_text:
            lock_path.write_text(stamped_text, encoding="utf-8")
        print(f"[lock] Stamped backend/{lock_name}")
        return True

    if embedded_hash == expected_hash:
        print(f"[lock] Fresh: backend/{lock_name}")
        return True

    print(
        f"[lock] Stale: backend/{lock_name} is out of sync with "
        f"{', '.join(f'backend/{name}' for name in LOCK_TARGETS[lock_name])}"
    )
    print(
        "[lock] Re-run the uv universal compile command recorded at the top of "
        "each lock file, then refresh embedded lock hashes with:\n"
        "  python scripts/check_lockfiles.py --write"
    )
    return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write",
        action="store_true",
        help="Update embedded input hashes in the compiled lock files instead of checking them.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    all_ok = True
    for lock_name in LOCK_TARGETS:
        if not _check_lockfile(lock_name, write=args.write):
            all_ok = False
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
