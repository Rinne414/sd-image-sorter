"""
Application metadata shared by runtime services and release tooling.
"""

APP_NAME = "SD Image Sorter"
APP_VERSION = "3.1.3"

GITHUB_OWNER = "peter119lee"
GITHUB_REPO = "sd-image-sorter"
GITHUB_RELEASES_API_URL = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases"
GITHUB_LATEST_RELEASE_API_URL = f"{GITHUB_RELEASES_API_URL}/latest"
GITHUB_REPOSITORY_URL = f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}"

PATCH_ASSET_TEMPLATE = "sd-image-sorter-v{version}-app-patch.zip"
WINDOWS_FULL_ASSET_TEMPLATE = "sd-image-sorter-v{version}-windows-portable.zip"
LINUX_FULL_ASSET_TEMPLATE = "sd-image-sorter-v{version}-linux.tar.gz"
PACKAGE_MANIFEST_RELATIVE_PATH = "update/package-manifest.json"
INSTALLED_MANIFEST_RELATIVE_PATH = "update/installed-manifest.json"
