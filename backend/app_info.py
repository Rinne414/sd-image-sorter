"""
Application metadata shared by runtime services and release tooling.
"""

APP_NAME = "SD Image Sorter"
APP_VERSION = "3.2.2"

GITHUB_OWNER = "peter119lee"
GITHUB_REPO = "sd-image-sorter"
GITHUB_RELEASES_API_URL = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases"
GITHUB_LATEST_RELEASE_API_URL = f"{GITHUB_RELEASES_API_URL}/latest"
GITHUB_REPOSITORY_URL = f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}"

PATCH_ASSET_TEMPLATE = "sd-image-sorter-v{version}-app-patch.zip"
WINDOWS_FULL_ASSET_TEMPLATE = "sd-image-sorter-v{version}-windows-portable.zip"
LINUX_FULL_ASSET_TEMPLATE = "sd-image-sorter-v{version}-linux.tar.gz"
# Linux portable bundle (Phase 1, x86_64 only): app + python-build-standalone
# cpython-3.13. Source-install Linux users keep using LINUX_FULL_ASSET_TEMPLATE;
# this asset is for users on distros without Python 3.12+ in the package
# manager, or on Python 3.14 systems where heavy AI wheels are not yet ready.
LINUX_PORTABLE_ASSET_TEMPLATE = "sd-image-sorter-v{version}-linux-portable.tar.gz"
PACKAGE_MANIFEST_RELATIVE_PATH = "update/package-manifest.json"
INSTALLED_MANIFEST_RELATIVE_PATH = "update/installed-manifest.json"
