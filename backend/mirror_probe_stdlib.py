"""Stdlib-only PyPI mirror probe runnable before pip install.

The launcher calls this BEFORE ``pip install -r requirements.txt``, so we
cannot import ``httpx`` (it is installed BY that pip install). Uses urllib
and a thread pool from the standard library only.

Mirrors the candidate list and env-override contract from
``mirror_selector.py`` so the two stay in sync. The picked index URL is
printed to stdout (one line, no trailing newline content) so the calling
batch / shell script can capture it and pass it as ``--index-url`` to pip.

Why this matters: ``requirements.txt`` weighs ~1.5 GB on Windows (torch CPU
800 MB plus FastAPI, ONNX, Pillow, OpenCV, etc.). Fastly's ``pypi.org``
typically delivers 500 KB/s–1 MB/s from mainland China; Tuna/Aliyun/USTC
sustain 20–80 MB/s. The probe adds ~1.5 s, the install saves ~25 minutes.
"""

from __future__ import annotations

import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Optional, Tuple

PYPI_OFFICIAL: str = "https://pypi.org/simple"

PYPI_CANDIDATES: Tuple[Tuple[str, str], ...] = (
    ("tuna", "https://pypi.tuna.tsinghua.edu.cn/simple"),
    ("aliyun", "https://mirrors.aliyun.com/pypi/simple"),
    ("ustc", "https://pypi.mirrors.ustc.edu.cn/simple"),
    ("official", PYPI_OFFICIAL),
)

# Hit the real PEP 503 path for a tiny ubiquitous package. Catches portal-page
# mirrors where ``/`` returns 200 but the actual index path 404s.
_PROBE_SUFFIX: str = "/pip/"
_PROBE_TIMEOUT_SEC: float = 1.5
_ENV_OVERRIDE: str = "SD_IMAGE_SORTER_PYPI_MIRROR"


def _probe_one(name: str, base: str) -> Tuple[str, str, Optional[float]]:
    url = f"{base}{_PROBE_SUFFIX}"
    req = urllib.request.Request(url, method="HEAD")
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=_PROBE_TIMEOUT_SEC) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            if status is not None and status < 400:
                return (name, base, (time.monotonic() - start) * 1000.0)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        pass
    return (name, base, None)


def _resolve_env_override() -> Optional[str]:
    value = os.environ.get(_ENV_OVERRIDE, "").strip()
    if not value:
        return None
    by_name = {name: url for name, url in PYPI_CANDIDATES}
    if value in by_name:
        return by_name[value]
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return None


def select_pypi_index_url() -> str:
    """Return the URL of the fastest reachable PyPI mirror.

    Env override (``SD_IMAGE_SORTER_PYPI_MIRROR``) short-circuits the probe.
    On total network failure the official host is returned so pip still has
    a working index.
    """
    override = _resolve_env_override()
    if override:
        return override

    with ThreadPoolExecutor(max_workers=len(PYPI_CANDIDATES)) as executor:
        results = list(executor.map(lambda c: _probe_one(*c), PYPI_CANDIDATES))

    reachable = [r for r in results if r[2] is not None]
    if reachable:
        reachable.sort(key=lambda r: r[2] or 0.0)
        return reachable[0][1]
    return PYPI_CANDIDATES[-1][1]


def main() -> int:
    sys.stdout.write(select_pypi_index_url())
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
