#!/usr/bin/env python3
"""One-command release QA for lazy SD Image Sorter developers.

This is intentionally not a replacement for full manual exploratory QA. It is a
fast, repeatable gate that catches broken release archives, startup failures,
scan/import regressions, selection/export problems, file operation issues,
path-validation mistakes, and a small set of optional-model status failures.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
ARTIFACT_ROOT = ROOT / "artifacts" / "release"
DEFAULT_WORK_ROOT = ROOT / ".tmp" / "lazy-release-qa"

PACKAGE_FORBIDDEN_PREFIXES = (
    ".git/",
    ".plans/",
    ".tmp/",
    "artifacts/",
    "backend/tests/",
    "backend/venv/",
    "data/",
    "node_modules/",
    "tests/",
    "update/backups/",
    "update/downloads/",
    "update/logs/",
    "update/state/",
    "update/worker/",
)

PACKAGE_REQUIRED_COMMON_APP_FILES = (
    "backend/main.py",
    "backend/config.py",
    "backend/services/service_provider.py",
    "frontend/index.html",
    "frontend/js/app.js",
    "frontend/js/gallery.js",
    "update/package-manifest.json",
)

PACKAGE_REQUIRED_FILES_BY_KIND = {
    "windows-portable": (
        "run.bat",
        "run.sh",
        "run-portable.bat",
    ),
    "app-patch": (
        "run.bat",
        "run.sh",
        "run-portable.bat",
    ),
    "linux": (
        "run.sh",
    ),
    "linux-portable": (
        "run.sh",
        "run-portable.sh",
    ),
}

OPTIONAL_STATUS_ENDPOINTS = (
    "/api/models/status",
    "/api/censor/models",
    "/api/aesthetic/status",
    "/api/artists/diagnostics",
    "/api/similarity/model-status",
    "/api/prompts/stats",
    "/api/updates/status",
)


@dataclass
class CheckResult:
    name: str
    elapsed: float


class LazyQaError(RuntimeError):
    pass


class LazyQa:
    def __init__(self, *, base_url: str, verbose: bool = False) -> None:
        self.base_url = base_url.rstrip("/")
        self.verbose = verbose
        self.results: list[CheckResult] = []

    def step(self, name: str, fn, *args, **kwargs):
        started = time.monotonic()
        print(f"[qa] RUN  {name}", flush=True)
        try:
            result = fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - this is a user-facing QA runner
            print(f"[qa] FAIL {name}: {exc}", flush=True)
            raise
        elapsed = time.monotonic() - started
        self.results.append(CheckResult(name=name, elapsed=elapsed))
        print(f"[qa] OK   {name} ({elapsed:.1f}s)", flush=True)
        return result

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any | None = None,
        expected: Iterable[int] = (200,),
        timeout: int = 30,
        raw: bool = False,
    ) -> Any:
        url = f"{self.base_url}{path}"
        data = None
        headers: dict[str, str] = {}
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        expected_set = set(expected)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                if response.status not in expected_set:
                    raise LazyQaError(f"{method} {path} returned {response.status}, expected {sorted(expected_set)}")
                if raw:
                    return body
                content_type = response.headers.get("Content-Type", "")
                if body and "json" in content_type:
                    return json.loads(body.decode("utf-8"))
                if not body:
                    return None
                return body.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:1000]
            if exc.code in expected_set:
                try:
                    return json.loads(body) if body else None
                except json.JSONDecodeError:
                    return body
            raise LazyQaError(f"{method} {path} returned {exc.code}, expected {sorted(expected_set)}; body={body}") from exc
        except urllib.error.URLError as exc:
            raise LazyQaError(f"{method} {path} failed: {exc}") from exc

    def wait_for_server(self, timeout_seconds: int) -> None:
        deadline = time.monotonic() + timeout_seconds
        last_error = "server did not respond"
        while time.monotonic() < deadline:
            try:
                self.request("GET", "/", timeout=3, raw=True)
                return
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                time.sleep(0.5)
        raise LazyQaError(last_error)

    def summary(self) -> None:
        total = sum(item.elapsed for item in self.results)
        print("\n[qa] Summary")
        for item in self.results:
            print(f"  PASS {item.name} ({item.elapsed:.1f}s)")
        print(f"[qa] All checks passed in {total:.1f}s")


def sha256sum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_archive_name(name: str) -> str:
    normalized = name.replace("\\", "/").lstrip("/")
    if normalized.startswith("sd-image-sorter/"):
        normalized = normalized[len("sd-image-sorter/") :]
    return normalized


def assert_archive_contents(names: Iterable[str], *, package_kind: str) -> None:
    normalized_names = {normalize_archive_name(name) for name in names if normalize_archive_name(name)}
    required_for_kind = PACKAGE_REQUIRED_FILES_BY_KIND.get(package_kind)
    if required_for_kind is None:
        raise LazyQaError(f"Unknown package kind: {package_kind}")

    for required in (*PACKAGE_REQUIRED_COMMON_APP_FILES, *required_for_kind):
        if required not in normalized_names:
            raise LazyQaError(f"{package_kind} archive missing required file: {required}")

    forbidden_hits = [
        name
        for name in sorted(normalized_names)
        if any(name == prefix.rstrip("/") or name.startswith(prefix) for prefix in PACKAGE_FORBIDDEN_PREFIXES)
    ]
    if forbidden_hits:
        preview = ", ".join(forbidden_hits[:10])
        raise LazyQaError(f"{package_kind} archive contains forbidden runtime/dev paths: {preview}")

    has_python = any(name.startswith("python/") for name in normalized_names)
    if package_kind == "windows-portable" and not has_python:
        raise LazyQaError("windows-portable archive does not include embedded python/")
    if package_kind == "linux-portable" and not has_python:
        raise LazyQaError("linux-portable archive does not include embedded python/")
    if package_kind == "app-patch" and has_python:
        raise LazyQaError("app-patch archive must not include embedded python/")
    if package_kind == "linux" and has_python:
        raise LazyQaError("linux archive must not include embedded python/")


def find_manifest(artifact_root: Path, version: str | None) -> Path:
    pattern = f"sd-image-sorter-v{version}-release-manifest.json" if version else "sd-image-sorter-v*-release-manifest.json"
    candidates = sorted(artifact_root.glob(pattern), key=lambda path: path.stat().st_mtime, reverse=True)
    if not candidates:
        raise LazyQaError(f"No release manifest found in {artifact_root} matching {pattern}")
    return candidates[0]


def check_release_packages(artifact_root: Path, version: str | None) -> None:
    manifest_path = find_manifest(artifact_root, version)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = manifest.get("assets") or []
    if len(entries) < 3:
        raise LazyQaError(f"Manifest has too few assets: {manifest_path}")

    seen_names = {entry.get("name", "") for entry in entries}
    required_suffixes = (
        "windows-portable.zip",
        "app-patch.zip",
        "linux.tar.gz",
        "linux-portable-x86_64.tar.gz",
        "linux-portable-aarch64.tar.gz",
    )
    for suffix in required_suffixes:
        if not any(name.endswith(suffix) for name in seen_names):
            raise LazyQaError(f"Manifest missing asset ending with {suffix}")

    for entry in entries:
        name = entry["name"]
        asset = artifact_root / name
        if not asset.exists():
            raise LazyQaError(f"Manifest asset missing on disk: {asset}")
        actual_size = asset.stat().st_size
        if actual_size != entry.get("size_bytes"):
            raise LazyQaError(f"Size mismatch for {name}: {actual_size} != {entry.get('size_bytes')}")
        actual_hash = sha256sum(asset)
        if actual_hash != entry.get("sha256"):
            raise LazyQaError(f"SHA256 mismatch for {name}: {actual_hash} != {entry.get('sha256')}")

        if name.endswith(".zip"):
            with zipfile.ZipFile(asset) as archive:
                bad_member = archive.testzip()
                if bad_member:
                    raise LazyQaError(f"Corrupt zip member in {name}: {bad_member}")
                if name.endswith("windows-portable.zip"):
                    assert_archive_contents(archive.namelist(), package_kind="windows-portable")
                elif name.endswith("app-patch.zip"):
                    assert_archive_contents(archive.namelist(), package_kind="app-patch")
        elif name.endswith(".tar.gz"):
            with tarfile.open(asset, "r:gz") as archive:
                package_kind = "linux-portable" if "-linux-portable-" in name else "linux"
                assert_archive_contents(archive.getnames(), package_kind=package_kind)


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def require_pillow() -> None:
    try:
        import PIL  # noqa: F401
    except ImportError as exc:
        raise LazyQaError(
            "Pillow is required for synthetic QA images. Run inside the backend venv or install backend requirements."
        ) from exc


def make_png(path: Path, *, prompt: str, kind: str, width: int, height: int, color: tuple[int, int, int]) -> None:
    from PIL import Image, PngImagePlugin

    image = Image.new("RGB", (width, height), color=color)
    pnginfo = PngImagePlugin.PngInfo()
    if kind == "webui":
        pnginfo.add_text(
            "parameters",
            f"{prompt}\nNegative prompt: lowres, bad anatomy\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 123, Size: {width}x{height}, Model: qa_webui_model, Model hash: abc123",
        )
    elif kind == "forge":
        pnginfo.add_text(
            "parameters",
            f"{prompt}\nNegative prompt: blurry\nSteps: 18, Sampler: DPM++ 2M, CFG scale: 6, Seed: 456, Size: {width}x{height}, Model: qa_forge_model, Version: f2.0.1v1.10.1-previous-634-g37301b22",
        )
    elif kind == "nai":
        pnginfo.add_text(
            "Comment",
            json.dumps(
                {
                    "prompt": prompt,
                    "uc": "lowres, bad anatomy",
                    "steps": 28,
                    "sampler": "k_euler",
                    "seed": 789,
                    "source": "NovelAI",
                }
            ),
        )
    elif kind == "comfyui":
        pnginfo.add_text(
            "prompt",
            json.dumps(
                {
                    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "qa_comfy_model.safetensors"}},
                    "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt}},
                    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "lowres"}},
                }
            ),
        )
    image.save(path, pnginfo=pnginfo)


def generate_dataset(work_root: Path, image_count: int) -> dict[str, Path]:
    require_pillow()
    from PIL import Image

    source = work_root / "images"
    nested = source / "nested" / "深い folder 🔥"
    move_dest = work_root / "move_dest"
    copy_dest = work_root / "copy_dest"
    obfuscate_dest = work_root / "obfuscate_dest"
    for folder in (nested, move_dest, copy_dest, obfuscate_dest):
        folder.mkdir(parents=True, exist_ok=True)

    kinds = ("webui", "forge", "nai", "comfyui", "plain")
    for index in range(image_count):
        kind = kinds[index % len(kinds)]
        folder = nested if index % 7 == 0 else source / f"bucket_{index % 5}"
        folder.mkdir(parents=True, exist_ok=True)
        width = 64 + (index % 5) * 16
        height = 64 + (index % 7) * 12
        prompt = f"qa_prompt_{index}, lazy release qa, tag_{index % 11}"
        if index % 17 == 0:
            prompt += ", " + "very_long_prompt_token " * 80
        safe_name = f"qa_{index:05d}_{kind}_中文 space.png"
        path = folder / safe_name
        color = ((index * 37) % 255, (index * 67) % 255, (index * 97) % 255)
        if kind == "plain" and index % 2 == 0:
            image = Image.new("RGB", (width, height), color=color)
            path = path.with_suffix(".jpg")
            image.save(path, quality=90)
        else:
            make_png(path, prompt=prompt, kind=kind, width=width, height=height, color=color)

    (source / "zero_byte.png").write_bytes(b"")
    (source / "fake_image.png").write_text("not an image", encoding="utf-8")
    return {
        "source": source,
        "move_dest": move_dest,
        "copy_dest": copy_dest,
        "obfuscate_dest": obfuscate_dest,
    }


def start_backend(work_root: Path, port: int, python_executable: str) -> tuple[subprocess.Popen, Path]:
    data_dir = work_root / "runtime-data"
    update_dir = work_root / "runtime-update"
    data_dir.mkdir(parents=True, exist_ok=True)
    update_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update(
        {
            "SD_IMAGE_SORTER_HOST": "127.0.0.1",
            "SD_IMAGE_SORTER_PORT": str(port),
            "SD_IMAGE_SORTER_DATA_DIR": str(data_dir),
            "SD_IMAGE_SORTER_UPDATE_DIR": str(update_dir),
            "SD_IMAGE_SORTER_DB_PATH": str(data_dir / "images.db"),
            "HF_HOME": str(data_dir / "hf"),
            "TRANSFORMERS_CACHE": str(data_dir / "hf" / "transformers"),
            "TORCH_HOME": str(data_dir / "torch"),
            "PIP_CACHE_DIR": str(data_dir / "pip-cache"),
            "PYTHONUNBUFFERED": "1",
        }
    )
    log_path = work_root / "backend.log"
    log_handle = log_path.open("w", encoding="utf-8", errors="replace")
    process = subprocess.Popen(
        [python_executable, str(ROOT / "backend" / "main.py"), "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(ROOT),
        env=env,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
    )
    # Keep the handle alive by attaching it; close during cleanup.
    process._lazy_qa_log_handle = log_handle  # type: ignore[attr-defined]
    return process, log_path


def stop_backend(process: subprocess.Popen | None) -> None:
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    log_handle = getattr(process, "_lazy_qa_log_handle", None)
    if log_handle:
        log_handle.close()


def poll_scan_done(qa: LazyQa, timeout_seconds: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_progress: dict[str, Any] = {}
    while time.monotonic() < deadline:
        progress = qa.request("GET", "/api/scan/progress") or {}
        last_progress = progress
        status = str(progress.get("status") or "").lower()
        running = bool(progress.get("running"))
        if status in {"done", "completed", "cancelled", "error", "idle"} and not running:
            if status in {"error", "cancelled"}:
                raise LazyQaError(f"Scan ended unexpectedly: {progress}")
            return progress
        time.sleep(0.5)
    raise LazyQaError(f"Scan did not finish in {timeout_seconds}s; last_progress={last_progress}")


def extract_images(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        images = payload.get("images") or payload.get("items") or []
        if isinstance(images, list):
            return images
    raise LazyQaError(f"Unexpected /api/images payload shape: {payload}")


def run_api_checks(qa: LazyQa, folders: dict[str, Path], image_count: int, scan_timeout: int) -> dict[str, Any]:
    qa.step("server root", lambda: qa.request("GET", "/", raw=True))
    qa.step("swagger docs", lambda: qa.request("GET", "/docs", raw=True))
    qa.step("stats empty", lambda: qa.request("GET", "/api/stats"))

    for endpoint in OPTIONAL_STATUS_ENDPOINTS:
        qa.step(f"status {endpoint}", lambda endpoint=endpoint: qa.request("GET", endpoint, expected=(200, 404, 503)))

    qa.step(
        "validate source path",
        lambda: qa.request("POST", "/api/validate-path", json_body={"path": str(folders["source"])}),
    )
    qa.step(
        "validate traversal is not accepted as valid input",
        lambda: qa.request("POST", "/api/validate-path", json_body={"path": "..%2f..%2f"}, expected=(200, 400, 422)),
    )
    qa.step(
        "browse source folder",
        lambda: qa.request("POST", "/api/browse-folder", json_body={"path": str(folders["source"])}),
    )

    qa.step(
        "start scan",
        lambda: qa.request(
            "POST",
            "/api/scan",
            json_body={"folder_path": str(folders["source"]), "recursive": True, "quick_import": False},
            expected=(200,),
        ),
    )
    qa.step("poll scan", lambda: poll_scan_done(qa, scan_timeout))

    payload = qa.step("gallery first page", lambda: qa.request("GET", "/api/images?limit=100&sort_by=newest"))
    images = extract_images(payload)
    minimum_expected = max(1, image_count - 5)
    if len(images) < min(100, minimum_expected):
        raise LazyQaError(f"Too few images returned after scan: {len(images)} from image_count={image_count}")
    first = images[0]
    first_id = int(first["id"])
    first_path = Path(first["path"])

    qa.step("image details", lambda: qa.request("GET", f"/api/images/{first_id}"))
    qa.step("image file", lambda: qa.request("GET", f"/api/image-file/{first_id}", raw=True))
    qa.step("thumbnail", lambda: qa.request("GET", f"/api/image-thumbnail/{first_id}?size=128", raw=True))
    qa.step("thumbnail stats", lambda: qa.request("GET", "/api/thumbnail-cache/stats"))

    qa.step("generator filter", lambda: qa.request("GET", "/api/images?limit=20&generators=webui,forge"))
    qa.step("search filter", lambda: qa.request("GET", "/api/images?limit=20&search=qa_prompt"))
    qa.step("dimension filter", lambda: qa.request("GET", "/api/images?limit=20&min_width=64&max_width=256"))
    qa.step("sort file size", lambda: qa.request("GET", "/api/images?limit=20&sort_by=file_size"))

    token_payload = qa.step(
        "selection token",
        lambda: qa.request("POST", "/api/images/selection-token", json_body={"search": "qa_prompt", "sortBy": "newest", "chunkSize": 50}),
    )
    token = token_payload.get("selection_token")
    if not token:
        raise LazyQaError(f"No selection token returned: {token_payload}")
    encoded_token = urllib.parse.quote(token)
    chunk = qa.step(
        "selection chunk",
        lambda: qa.request("GET", f"/api/images/selection-chunk?selection_token={encoded_token}&offset=0&limit=50"),
    )
    if not chunk.get("image_ids"):
        raise LazyQaError(f"Selection chunk returned no IDs: {chunk}")
    qa.step(
        "export token data",
        lambda: qa.request("POST", "/api/images/export-data", json_body={"selection_token": token, "offset": 0, "limit": 10}),
    )
    qa.step(
        "selection ids legacy",
        lambda: qa.request("POST", "/api/images/selection-ids", json_body={"search": "qa_prompt", "sortBy": "newest"}),
    )

    qa.step(
        "copy one image",
        lambda: qa.request(
            "POST",
            "/api/move",
            json_body={"image_ids": [first_id], "destination_folder": str(folders["copy_dest"]), "operation": "copy"},
        ),
    )
    copied_files = [path for path in folders["copy_dest"].iterdir() if path.is_file()]
    if not copied_files:
        raise LazyQaError("Copy operation reported success but no file appeared in copy_dest")

    qa.step(
        "obfuscate encode",
        lambda: qa.request(
            "POST",
            "/api/obfuscate/encode",
            json_body={
                "image_path": str(first_path),
                "output_path": str(folders["obfuscate_dest"] / "encoded.png"),
                "password": "lazy-qa",
                "preserve_metadata": True,
                "allow_overwrite": False,
            },
        ),
    )
    encoded_path = folders["obfuscate_dest"] / "encoded.png"
    if not encoded_path.exists():
        raise LazyQaError("Obfuscation encode did not create output file")
    qa.step(
        "obfuscate decode",
        lambda: qa.request(
            "POST",
            "/api/obfuscate/decode",
            json_body={
                "image_path": str(encoded_path),
                "output_path": str(folders["obfuscate_dest"] / "decoded.png"),
                "password": "lazy-qa",
                "preserve_metadata": True,
                "allow_overwrite": False,
            },
        ),
    )

    qa.step("tag library", lambda: qa.request("GET", "/api/tags/library"))
    qa.step("tag progress", lambda: qa.request("GET", "/api/tag/progress"))
    qa.step("tagger models", lambda: qa.request("GET", "/api/tagger/models"))
    qa.step("prompt stats", lambda: qa.request("GET", "/api/prompts/stats"))
    qa.step("thumbnail cleanup", lambda: qa.request("POST", "/api/thumbnail-cache/cleanup?max_age_days=1"))
    return {"first_id": first_id, "first_path": str(first_path)}


def _first_executable(*candidates: str | Path) -> str:
    for candidate in candidates:
        if isinstance(candidate, Path):
            if candidate.exists():
                return str(candidate)
        else:
            found = shutil.which(candidate)
            if found:
                return found
    return str(candidates[0])


def _node_executable(python_executable: str) -> str:
    windows_node = Path("/mnt/c/Program Files/nodejs/node.exe")
    if python_executable.lower().endswith(".exe"):
        return _first_executable(windows_node, Path("C:/Program Files/nodejs/node.exe"), "node")
    return _first_executable("node", Path("/usr/bin/node"), Path("/usr/local/bin/node"), windows_node)


def _path_for_browser(path_value: str, node_executable: str) -> str:
    if not path_value or not (node_executable.lower().endswith(".exe") and os.name != "nt"):
        return path_value
    try:
        result = subprocess.run(
            ["wslpath", "-w", path_value],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        return result.stdout.strip() or path_value
    except Exception:
        return path_value


def _playwright_command(node_executable: str, script: str, cli_args: list[str], env_values: dict[str, str]) -> list[str]:
    if node_executable.lower().endswith(".exe") and os.name != "nt":
        env_assignments = "; ".join(
            f"process.env[{json.dumps(key)}]={json.dumps(value)}"
            for key, value in env_values.items()
        )
        argv = ", ".join(json.dumps(arg) for arg in cli_args)
        return [
            node_executable,
            "-e",
            (
                f"{env_assignments}; "
                "const path = require('path'); "
                "const { pathToFileURL } = require('url'); "
                f"const script = {json.dumps(script)}; "
                f"process.argv = [process.execPath, script, {argv}]; "
                "(async () => { "
                "await import(pathToFileURL(path.resolve(script)).href); "
                "})().catch((error) => { console.error(error); process.exit(1); });"
            ),
        ]
    return [node_executable, script, *cli_args]


def run_frontend_checks(
    qa: LazyQa,
    *,
    port: int,
    folders: dict[str, Path],
    api_context: dict[str, Any],
    python_executable: str,
) -> None:
    e2e_root = ROOT / "tests" / "e2e"
    wrapper = e2e_root / "scripts" / "run-playwright.mjs"
    if not wrapper.exists():
        raise LazyQaError(f"Playwright wrapper not found: {wrapper}")

    node = _node_executable(python_executable)
    first_image_for_browser = _path_for_browser(str(api_context.get("first_path") or ""), node)
    env_values = {
        "BASE_URL": qa.base_url,
        "PW_REUSE_SERVER": "1",
        "PW_WEB_SERVER_PORT": str(port),
        "PW_BACKEND_PYTHON": python_executable,
        "SD_LAZY_QA_FRONTEND": "1",
        "SD_LAZY_QA_FIRST_IMAGE": first_image_for_browser,
        "SD_LAZY_QA_COPY_DEST": str(folders["copy_dest"]),
    }
    env = os.environ.copy()
    env.update(env_values)
    command = _playwright_command(
        node,
        "./scripts/run-playwright.mjs",
        ["test", "specs/lazy-human.spec.ts", "--reporter=list"],
        env_values,
    )
    result = subprocess.run(command, cwd=e2e_root, env=env)
    if result.returncode != 0:
        raise LazyQaError(f"Frontend Playwright QA failed with exit code {result.returncode}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", type=Path, default=ARTIFACT_ROOT, help="Release artifact folder")
    parser.add_argument("--version", default=None, help="Exact release version to validate, e.g. 3.1.0-techdebt.48793ff")
    parser.add_argument("--work-root", type=Path, default=DEFAULT_WORK_ROOT, help="Temporary QA workspace")
    parser.add_argument("--image-count", type=int, default=120, help="Synthetic valid image count; use 10000 for large smoke")
    parser.add_argument("--scan-timeout", type=int, default=180, help="Seconds to wait for scan completion")
    parser.add_argument("--startup-timeout", type=int, default=90, help="Seconds to wait for backend startup")
    parser.add_argument("--python", default=sys.executable, help="Python executable used to start backend/main.py")
    parser.add_argument("--skip-package", action="store_true", help="Skip release archive validation")
    parser.add_argument("--skip-server", action="store_true", help="Skip backend/API smoke checks")
    parser.add_argument("--frontend", action="store_true", help="Also run real browser UI clicks with Playwright")
    parser.add_argument("--keep-workdir", action="store_true", help="Do not delete the QA workspace before running")
    parser.add_argument("--verbose", action="store_true", help="Print extra diagnostics")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.image_count < 1:
        raise SystemExit("--image-count must be >= 1")

    qa = LazyQa(base_url="http://127.0.0.1:0", verbose=args.verbose)
    process: subprocess.Popen | None = None
    log_path: Path | None = None
    work_root = args.work_root.resolve()

    try:
        if not args.keep_workdir and work_root.exists():
            shutil.rmtree(work_root)
        work_root.mkdir(parents=True, exist_ok=True)

        if not args.skip_package:
            qa.step("release package integrity", check_release_packages, args.artifact_root.resolve(), args.version)

        if not args.skip_server:
            folders = qa.step("generate synthetic dataset", generate_dataset, work_root, args.image_count)
            port = find_free_port()
            qa.base_url = f"http://127.0.0.1:{port}"
            process, log_path = start_backend(work_root, port, args.python)
            try:
                qa.step("backend startup", qa.wait_for_server, args.startup_timeout)
                if process.poll() is not None:
                    raise LazyQaError(f"Backend exited early with code {process.returncode}; log={log_path}")
                api_context = run_api_checks(qa, folders, args.image_count, args.scan_timeout)
                if args.frontend:
                    qa.step(
                        "frontend human Playwright",
                        run_frontend_checks,
                        qa,
                        port=port,
                        folders=folders,
                        api_context=api_context,
                        python_executable=args.python,
                    )
            finally:
                stop_backend(process)
                process = None

        qa.summary()
        print(f"[qa] Workspace: {work_root}")
        if log_path:
            print(f"[qa] Backend log: {log_path}")
        return 0
    except Exception as exc:  # noqa: BLE001
        stop_backend(process)
        print(f"\n[qa] FAILED: {exc}", file=sys.stderr)
        if log_path and log_path.exists():
            print(f"[qa] Backend log: {log_path}", file=sys.stderr)
            try:
                tail = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-80:]
                print("[qa] Backend log tail:", file=sys.stderr)
                for line in tail:
                    print(line, file=sys.stderr)
            except Exception:
                pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
