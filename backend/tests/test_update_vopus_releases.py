"""Vopus offers only its own releases (tags ``vopus-v<version>``).

The repository also publishes V3.5 (tags ``v3.5.x``), and its "latest"
release may be one of those. Vopus 1.0.0 must never offer v3.5.0 as a newer
version, so the update check reads the release list, keeps the published
``vopus-v`` releases, and picks the newest by version. A channel that returns
one release (a custom mirror URL) is checked for the same tag rule.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import services.update_service as us
import services.update_service_delivery as delivery
from app_info import (
    GITHUB_LATEST_RELEASE_API_URL,
    GITHUB_RELEASES_API_URL,
    GITHUB_REPOSITORY_URL,
)
from services.update_service import UpdateService

CURRENT = "1.0.0"


@pytest.fixture
def service(monkeypatch, tmp_path: Path) -> UpdateService:
    """The built-in GitHub channel, no override file, and Vopus 1.0.0 installed."""
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setattr(us, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(us, "UPDATE_API_URL", GITHUB_LATEST_RELEASE_API_URL)
    monkeypatch.setattr(
        us, "UPDATE_WEB_URL", f"{GITHUB_REPOSITORY_URL}/releases/latest"
    )
    monkeypatch.setattr(us, "UPDATE_DOWNLOAD_URL_PREFIX", "")
    monkeypatch.setattr(delivery, "APP_VERSION", CURRENT)
    return UpdateService()


def _release(tag: str, *, version: str | None = None, **extra) -> dict:
    """A GitHub release with the patch and manifest files named for its version."""
    name_version = (
        version
        if version is not None
        else tag.removeprefix("vopus-v").removeprefix("v")
    )
    prefix = (
        "sd-image-sorter-vopus-v" if tag.startswith("vopus-v") else "sd-image-sorter-v"
    )
    return {
        "tag_name": tag,
        "html_url": f"{GITHUB_REPOSITORY_URL}/releases/tag/{tag}",
        "body": f"## {tag}",
        "prerelease": False,
        "draft": False,
        "assets": [
            {
                "name": f"{prefix}{name_version}-app-patch.zip",
                "size": 10,
                "browser_download_url": f"https://github.com/o/r/releases/download/{tag}/patch.zip",
            },
            {
                "name": f"{prefix}{name_version}-release-manifest.json",
                "size": 1,
                "browser_download_url": f"https://github.com/o/r/releases/download/{tag}/manifest.json",
            },
        ],
        **extra,
    }


def _serve(monkeypatch, payload) -> list[str]:
    """Answer every update request with ``payload``; returns the requested URLs."""
    requested: list[str] = []

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps(payload).encode("utf-8")

    def _open(request, timeout=0):
        requested.append(request.full_url)
        return _Response()

    monkeypatch.setattr(us.urllib.request, "urlopen", _open)
    return requested


def _assert_up_to_date(status: dict) -> None:
    assert status["error"] is None
    assert status["has_update"] is False
    assert status["latest_version"] == CURRENT
    assert status["update_unavailable_reason"] is None
    assert status["asset"] is None
    assert status["release_notes"] == ""


def test_a_v35_latest_release_is_not_offered(service, monkeypatch):
    requested = _serve(monkeypatch, [_release("v3.5.0")])

    status = service.get_status(force=True)

    _assert_up_to_date(status)
    # The release list, not /releases/latest (which may name a V3.5 release).
    assert requested == [GITHUB_RELEASES_API_URL]


def test_a_single_v35_release_from_a_custom_endpoint_is_not_offered(
    service, monkeypatch
):
    monkeypatch.setattr(us, "UPDATE_API_URL", "https://mirror.example/latest.json")
    requested = _serve(monkeypatch, _release("v3.5.0"))

    status = service.get_status(force=True)

    _assert_up_to_date(status)
    assert requested == ["https://mirror.example/latest.json"]


def test_a_newer_vopus_release_is_offered_next_to_v35_releases(service, monkeypatch):
    _serve(
        monkeypatch,
        [
            _release("v3.5.1"),
            _release("vopus-v1.0.1"),
            _release("v3.5.0"),
            _release("vopus-v1.0.0"),
        ],
    )

    status = service.get_status(force=True)

    assert status["error"] is None
    assert status["has_update"] is True
    assert status["latest_version"] == "1.0.1"
    assert status["asset"]["name"] == "sd-image-sorter-vopus-v1.0.1-app-patch.zip"
    assert status["asset"]["manifest_download_url"].endswith(
        "/vopus-v1.0.1/manifest.json"
    )
    assert status["release_url"] == f"{GITHUB_REPOSITORY_URL}/releases/tag/vopus-v1.0.1"
    assert status["release_notes"] == "## vopus-v1.0.1"


def test_the_newest_vopus_release_wins_by_version_not_list_order(service, monkeypatch):
    _serve(
        monkeypatch,
        [_release("vopus-v1.2.0"), _release("vopus-v1.10.0"), _release("vopus-v1.9.3")],
    )

    assert service.get_status(force=True)["latest_version"] == "1.10.0"


def test_the_installed_vopus_version_is_up_to_date(service, monkeypatch):
    _serve(monkeypatch, [_release("v3.5.0"), _release(f"vopus-v{CURRENT}")])

    status = service.get_status(force=True)

    assert status["has_update"] is False
    assert status["update_unavailable_reason"] is None


def test_pre_releases_and_drafts_are_skipped(service, monkeypatch):
    _serve(
        monkeypatch,
        [
            _release("vopus-v2.0.0-beta.1", prerelease=True),
            _release("vopus-v3.0.0", draft=True),
            _release("vopus-v1.0.1"),
        ],
    )

    assert service.get_status(force=True)["latest_version"] == "1.0.1"


@pytest.mark.parametrize(
    "tag",
    [
        "v9.9.9",
        "9.9.9",
        "vopus-9.9.9",
        "Vopus-v9.9.9",
        "xvopus-v9.9.9",
        "vopus-v",
        "vopus-v9",
        "vopus-vnext",
        "vopus-v9.9.9/../x",
        "vopus-v9.9.9-",
        None,
    ],
)
def test_other_or_malformed_tags_are_never_offered(service, monkeypatch, tag):
    release = _release("vopus-v9.9.9")
    release["tag_name"] = tag
    _serve(monkeypatch, [release])

    _assert_up_to_date(service.get_status(force=True))

    # The same rule for a channel that answers with one release.
    monkeypatch.setattr(us, "UPDATE_API_URL", "https://mirror.example/latest.json")
    _serve(monkeypatch, release)
    _assert_up_to_date(service.get_status(force=True))


def test_a_release_name_alone_does_not_make_a_vopus_release(service, monkeypatch):
    release = _release("vopus-v9.9.9")
    release.pop("tag_name")
    release["name"] = "vopus-v9.9.9"
    _serve(monkeypatch, [release])

    _assert_up_to_date(service.get_status(force=True))


def test_a_release_list_with_a_non_object_entry_is_an_error(service, monkeypatch):
    _serve(monkeypatch, [_release("vopus-v1.0.1"), "vopus-v9.9.9"])

    status = service.get_status(force=True)

    assert status["has_update"] is False
    assert status["error"]


def test_a_proxy_mirror_reads_the_release_list_and_downloads_through_the_mirror(
    service, monkeypatch
):
    service.save_proxy_channel("https://ghfast.top")
    requested = _serve(monkeypatch, [_release("v3.5.0"), _release("vopus-v1.0.1")])

    status = service.get_status(force=True)

    assert requested == [f"https://ghfast.top/{GITHUB_RELEASES_API_URL}"]
    assert status["has_update"] is True
    assert status["latest_version"] == "1.0.1"
    assert status["asset"]["download_url"].startswith(
        "https://ghfast.top/https://github.com/"
    )


@pytest.mark.parametrize(
    "api_url",
    [
        "https://evil.example/repos/o/r/releases/latest",
        f"https://127.0.0.1/{GITHUB_LATEST_RELEASE_API_URL}",
        f"http://mirror.example/{GITHUB_LATEST_RELEASE_API_URL}",
    ],
)
def test_an_unsafe_channel_override_still_falls_back_to_github(
    service, monkeypatch, api_url
):
    (us.CONFIG_DIR / "update-channel.json").write_text(
        json.dumps({"api_url": api_url}), encoding="utf-8"
    )
    requested = _serve(monkeypatch, [_release("vopus-v1.0.1")])

    service.get_status(force=True)

    assert requested == [GITHUB_RELEASES_API_URL]
