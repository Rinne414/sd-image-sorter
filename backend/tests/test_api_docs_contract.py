"""Contract tests keeping API docs aligned with FastAPI routes."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path


HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
DOC_ENDPOINT_RE = re.compile(r"^####\s+(GET|POST|PUT|PATCH|DELETE)\s+(/api/\S+)\s*$")


ROOT = Path(__file__).resolve().parents[2]
DOCS_API = ROOT / "docs" / "API.md"
EXPORT_OPENAPI = ROOT / "scripts" / "export_openapi.py"
APP_INFO = ROOT / "backend" / "app_info.py"


def _load_openapi_endpoints() -> set[tuple[str, str]]:
    sys.path.insert(0, str(ROOT / "backend"))
    from main import app  # pylint: disable=import-outside-toplevel

    endpoints: set[tuple[str, str]] = set()
    for path, operations in app.openapi()["paths"].items():
        if not path.startswith("/api"):
            continue
        for method in operations:
            normalized_method = method.upper()
            if normalized_method in HTTP_METHODS:
                endpoints.add((normalized_method, path))
    return endpoints


def _load_documented_endpoints() -> set[tuple[str, str]]:
    endpoints: set[tuple[str, str]] = set()
    for line in DOCS_API.read_text(encoding="utf-8").splitlines():
        match = DOC_ENDPOINT_RE.match(line.strip())
        if match:
            endpoints.add((match.group(1), match.group(2)))
    return endpoints


def _format_endpoint_list(endpoints: set[tuple[str, str]]) -> str:
    return "\n".join(f"- {method} {path}" for method, path in sorted(endpoints))


def _load_exported_openapi_schema() -> dict:
    result = subprocess.run(
        [sys.executable, str(EXPORT_OPENAPI)],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(result.stdout)


def test_export_openapi_script_outputs_schema_without_server() -> None:
    schema = _load_exported_openapi_schema()
    assert schema["openapi"]
    assert "/api/images" in schema["paths"]
    assert "get" in schema["paths"]["/api/images"]


def test_docs_api_endpoint_headings_match_fastapi_routes() -> None:
    """Every public /api route should have a matching docs/API.md endpoint heading."""
    openapi_endpoints = _load_openapi_endpoints()
    documented_endpoints = _load_documented_endpoints()

    undocumented = openapi_endpoints - documented_endpoints
    stale_docs = documented_endpoints - openapi_endpoints

    assert not undocumented, (
        "FastAPI exposes endpoint(s) missing from docs/API.md headings:\n"
        + _format_endpoint_list(undocumented)
    )
    assert not stale_docs, (
        "docs/API.md documents endpoint(s) not exposed by FastAPI:\n"
        + _format_endpoint_list(stale_docs)
    )


def test_docs_api_version_matches_app_info() -> None:
    docs_text = DOCS_API.read_text(encoding="utf-8")
    docs_match = re.search(r"^\*\*Version:\*\*\s+(.+)$", docs_text, re.MULTILINE)
    app_match = re.search(
        r'^APP_VERSION\s*=\s*["\']([^"\']+)["\']',
        APP_INFO.read_text(encoding="utf-8"),
        re.MULTILINE,
    )

    assert docs_match is not None
    assert app_match is not None
    assert docs_match.group(1).strip() == app_match.group(1)


def test_exported_openapi_schema_is_stably_sorted() -> None:
    schema = _load_exported_openapi_schema()

    assert list(schema["paths"]) == sorted(schema["paths"])
    for path_item in schema["paths"].values():
        assert list(path_item) == sorted(path_item)


def test_update_api_docs_describe_contract_fields() -> None:
    docs_text = DOCS_API.read_text(encoding="utf-8")
    required_terms = {
        "updater_enabled",
        "package_root",
        "data_root",
        "update_root",
        "current_version",
        "latest_version",
        "has_update",
        "update_unavailable_reason",
        "channel_api_url",
        "channel_web_url",
        "download_url_prefix",
        "pending_manifest",
        "restart_required",
    }

    missing_terms = [term for term in sorted(required_terms) if f"`{term}`" not in docs_text]
    assert not missing_terms, "docs/API.md is missing update contract field(s): " + ", ".join(missing_terms)
