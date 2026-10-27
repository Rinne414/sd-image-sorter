"""Download one picture from the web for "collect by URL".

Used when the browser extension could not fetch a picture itself, and when a
picture address is pasted into the program. The page address is sent as
``Referer`` because many sites (Pixiv, some boorus) refuse pictures
requested without it. No size limit; a read that stalls for
``READ_TIMEOUT_SECONDS`` is given up.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import unquote, urlsplit

import httpx

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT_SECONDS = 15.0
READ_TIMEOUT_SECONDS = 60.0
MAX_REDIRECTS = 10
CHUNK_BYTES = 1024 * 1024
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0 Safari/537.36"
)


class DownloadError(Exception):
    """A picture that could not be downloaded.

    ``code`` (+ ``params``) lets the page say it in the UI language;
    ``message`` is the English fallback.
    """

    def __init__(
        self,
        message: str,
        status_code: int = 502,
        code: str = "collect_download_failed",
        params: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.params = params or {}

    def detail(self) -> Dict[str, Any]:
        return {"code": self.code, "message": self.message, "params": self.params}


def network_error(exc: httpx.HTTPError) -> DownloadError:
    """What went wrong, in words the page can say in either language.

    The system's own text (``[WinError 10061] ...``, in the system's language)
    goes to the log only.
    """
    logger.info("Picture download failed: %r", exc)
    # A connect timeout is both a TimeoutException and a transport error: time first.
    if isinstance(exc, httpx.TimeoutException):
        return DownloadError(
            "The site took too long to send the picture. Try again later.",
            504,
            code="collect_download_timeout",
        )
    if isinstance(exc, httpx.ConnectError):
        return DownloadError(
            "The site could not be reached. Check the address, the network and the proxy setting.",
            502,
            code="collect_site_unreachable",
        )
    if isinstance(exc, httpx.TooManyRedirects):
        return DownloadError(
            "The address kept redirecting and never reached a picture.",
            502,
            code="collect_too_many_redirects",
        )
    if isinstance(exc, (httpx.RemoteProtocolError, httpx.ReadError, httpx.WriteError)):
        return DownloadError(
            "The connection broke off before the whole picture arrived. Try again.",
            502,
            code="collect_connection_broken",
        )
    return DownloadError(
        f"The picture could not be downloaded: {exc}",
        502,
        code="collect_download_failed",
        params={"reason": str(exc)},
    )


@dataclass(frozen=True)
class DownloadedFile:
    path: Path
    suggested_name: str
    content_type: str


def check_web_url(url: str) -> str:
    """The URL when it is an http(s) address with a host; DownloadError otherwise."""
    text = str(url or "").strip()
    parts = urlsplit(text)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise DownloadError(
            "Only http:// and https:// picture addresses can be downloaded.",
            400,
            code="collect_url_not_web",
        )
    return text


def site_root(url: str) -> str:
    """``https://host/a/b.png`` -> ``https://host/``: the Referer for a picture
    pasted without its page (sites that only check for their own domain pass)."""
    parts = urlsplit(check_web_url(url))
    return f"{parts.scheme}://{parts.netloc}/"


def name_from_url(url: str) -> str:
    """Last path segment of a URL (``.../abc.png?x=1`` -> ``abc.png``)."""
    leaf = unquote(urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1])
    return leaf or "picture"


def _is_loopback(host: Optional[str]) -> bool:
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def _request_headers(referer: Optional[str]) -> dict:
    headers = {
        "User-Agent": BROWSER_USER_AGENT,
        "Accept": "image/avif,image/webp,image/png,image/*;q=0.9,*/*;q=0.5",
    }
    if referer:
        headers["Referer"] = check_web_url(referer)
    return headers


def download_picture(
    url: str, *, referer: Optional[str], dest_dir: Path
) -> DownloadedFile:
    """Stream ``url`` into a temporary file in ``dest_dir``; the caller moves it."""
    url = check_web_url(url)
    timeout = httpx.Timeout(READ_TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS)
    # A proxy from the environment is for the internet, not for this machine.
    trust_env = not _is_loopback(urlsplit(url).hostname)
    dest_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=".collect-", suffix=".part", dir=str(dest_dir)
    )
    tmp_path = Path(tmp_name)
    try:
        with (
            os.fdopen(fd, "wb") as out,
            httpx.Client(
                follow_redirects=True,
                max_redirects=MAX_REDIRECTS,
                timeout=timeout,
                trust_env=trust_env,
            ) as client,
        ):
            with client.stream(
                "GET", url, headers=_request_headers(referer)
            ) as response:
                if response.status_code != 200:
                    raise DownloadError(
                        f"The site answered {response.status_code} instead of the picture."
                        " If it only shows the picture to signed-in visitors, save it"
                        " with the browser extension instead.",
                        502,
                        code="collect_site_refused",
                        params={"status": response.status_code},
                    )
                for chunk in response.iter_bytes(CHUNK_BYTES):
                    out.write(chunk)
                final_url = str(response.url)
                content_type = response.headers.get("content-type", "")
    except httpx.HTTPError as exc:
        tmp_path.unlink(missing_ok=True)
        raise network_error(exc) from exc
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    return DownloadedFile(tmp_path, name_from_url(final_url), content_type)
