"""Launcher-side localhost port selection for SD Image Sorter.

The app defaults to 127.0.0.1:8487, but Windows can reserve TCP port
ranges for Hyper-V/WSL/VPN software. In that case a normal server bind fails
with WinError 10013 even when no process is listening on the port. The launchers
use this module before opening the browser so users land on the port that the
backend will actually bind.
"""
from __future__ import annotations

import argparse
import errno
import ipaddress
import os
import shlex
import socket
from dataclasses import dataclass


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8487
AUTO_SEARCH_LIMIT = 100


class PortSelectionError(RuntimeError):
    """Raised when the launcher cannot select a usable localhost port."""


@dataclass(frozen=True)
class PortProbe:
    ok: bool
    reason: str = ""
    can_auto_fallback: bool = False


@dataclass(frozen=True)
class PortSelection:
    port: int
    status: str
    message: str


def url_host_for_bind_host(host: str | None) -> str:
    """Return the URL host that matches the backend bind host."""
    normalized = (host or DEFAULT_HOST).strip()
    if normalized.startswith("[") and normalized.endswith("]"):
        normalized = normalized[1:-1]
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        return normalized or DEFAULT_HOST
    return f"[{address.compressed}]" if address.version == 6 else address.compressed


def parse_port(raw_value: str | None, *, default: int = DEFAULT_PORT) -> tuple[int, bool]:
    """Return ``(port, explicit)`` from an optional environment value."""
    if raw_value is None or raw_value.strip() == "":
        return default, False

    try:
        port = int(raw_value.strip())
    except ValueError as exc:
        raise PortSelectionError(
            f"Invalid SD_IMAGE_SORTER_PORT={raw_value!r}; expected a number from 1 to 65535."
        ) from exc

    if not 1 <= port <= 65535:
        raise PortSelectionError(
            f"Invalid SD_IMAGE_SORTER_PORT={port}; expected a number from 1 to 65535."
        )
    return port, True


def is_loopback_host(host: str | None) -> bool:
    """Return True when ``host`` is an allowed local bind host."""
    if not host:
        return False
    normalized = host.strip().lower()
    if normalized in {"localhost", "127.0.0.1", "::1", "[::1]"}:
        return True
    try:
        return ipaddress.ip_address(normalized.strip("[]")).is_loopback
    except ValueError:
        return False


def _socket_family_for_host(host: str) -> socket.AddressFamily:
    normalized = host.strip().strip("[]")
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        return socket.AF_INET
    return socket.AF_INET6 if address.version == 6 else socket.AF_INET


def classify_bind_error(exc: OSError) -> tuple[str, bool]:
    """Return ``(reason, can_auto_fallback)`` for a bind failure."""
    winerror = getattr(exc, "winerror", None)
    err_no = exc.errno
    if winerror == 10013 or err_no in {errno.EACCES, errno.EPERM}:
        return (
            "Windows refused this port. It is usually in an excluded/reserved "
            "TCP range or blocked by security software.",
            True,
        )
    if winerror == 10048 or err_no == errno.EADDRINUSE:
        return "Another process is already using this port.", False
    return str(exc) or exc.__class__.__name__, False


def describe_bind_error(exc: OSError) -> str:
    """Convert a bind failure into a short user-facing launcher reason."""
    reason, _can_auto_fallback = classify_bind_error(exc)
    return reason


def probe_port(host: str, port: int) -> PortProbe:
    """Check whether the backend should be able to bind ``host:port``."""
    family = _socket_family_for_host(host)
    address = (host.strip("[]"), port, 0, 0) if family == socket.AF_INET6 else (host, port)
    try:
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            sock.bind(address)
    except OSError as exc:
        reason, can_auto_fallback = classify_bind_error(exc)
        return PortProbe(ok=False, reason=reason, can_auto_fallback=can_auto_fallback)
    return PortProbe(ok=True)


def choose_port(
    *,
    host: str = DEFAULT_HOST,
    raw_port: str | None = None,
    search_limit: int = AUTO_SEARCH_LIMIT,
) -> PortSelection:
    """Select a bindable port while preserving explicit user overrides."""
    if not is_loopback_host(host):
        raise PortSelectionError(
            "This application only allows localhost binding. Use 127.0.0.1 or localhost."
        )

    preferred_port, explicit = parse_port(raw_port)
    preferred_probe = probe_port(host, preferred_port)
    if preferred_probe.ok:
        return PortSelection(
            port=preferred_port,
            status="ok",
            message=f"Using localhost port {preferred_port}.",
        )

    if explicit:
        raise PortSelectionError(
            f"Port {preferred_port} is unavailable: {preferred_probe.reason} "
            "You explicitly set SD_IMAGE_SORTER_PORT, so the launcher will not silently change it."
        )

    if not preferred_probe.can_auto_fallback:
        raise PortSelectionError(
            f"Default port {preferred_port} is unavailable: {preferred_probe.reason} "
            "If SD Image Sorter is already open, use the existing browser tab. Otherwise close the process using it "
            "or set SD_IMAGE_SORTER_PORT to another port."
        )

    stop_port = min(65535, preferred_port + max(0, search_limit))
    for candidate in range(preferred_port + 1, stop_port + 1):
        if probe_port(host, candidate).ok:
            return PortSelection(
                port=candidate,
                status="changed",
                message=(
                    f"Default port {preferred_port} is unavailable: {preferred_probe.reason} "
                    f"Using {candidate} instead."
                ),
            )

    raise PortSelectionError(
        f"Default port {preferred_port} is unavailable: {preferred_probe.reason} "
        f"No free localhost port was found between {preferred_port + 1} and {stop_port}."
    )


def diagnose_port(
    *,
    host: str = DEFAULT_HOST,
    raw_port: str | None = None,
) -> PortSelection:
    """Probe the configured localhost port without choosing a replacement."""
    if not is_loopback_host(host):
        raise PortSelectionError(
            "This application only allows localhost binding. Use 127.0.0.1 or localhost."
        )

    port, explicit = parse_port(raw_port)
    probe = probe_port(host, port)
    source = "configured" if explicit else "default"
    if probe.ok:
        return PortSelection(
            port=port,
            status="ok",
            message=f"{source.capitalize()} localhost port {port} is available.",
        )

    status = "blocked" if probe.can_auto_fallback else "error"
    return PortSelection(
        port=port,
        status=status,
        message=f"{source.capitalize()} localhost port {port} is unavailable: {probe.reason}",
    )


def _format_cmd(selection: PortSelection, *, host: str) -> str:
    lines = {
        "SD_IMAGE_SORTER_PORT": str(selection.port),
        "SD_IMAGE_SORTER_URL_HOST": url_host_for_bind_host(host),
        "SD_IMAGE_SORTER_PORT_STATUS": selection.status,
        "SD_IMAGE_SORTER_PORT_MESSAGE": selection.message,
    }
    return "\n".join(f"{key}={value}" for key, value in lines.items())


def _format_sh(selection: PortSelection, *, host: str) -> str:
    lines = {
        "SD_IMAGE_SORTER_PORT": str(selection.port),
        "SD_IMAGE_SORTER_URL_HOST": url_host_for_bind_host(host),
        "SD_IMAGE_SORTER_PORT_STATUS": selection.status,
        "SD_IMAGE_SORTER_PORT_MESSAGE": selection.message,
    }
    return "\n".join(f"export {key}={shlex.quote(value)}" for key, value in lines.items())


def main() -> int:
    parser = argparse.ArgumentParser(description="Select a localhost port for SD Image Sorter launchers.")
    parser.add_argument("--host", default=os.environ.get("SD_IMAGE_SORTER_HOST", DEFAULT_HOST))
    parser.add_argument("--format", choices=("text", "cmd", "sh"), default="text")
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help="Probe the configured/default port without selecting a replacement.",
    )
    args = parser.parse_args()

    try:
        if args.diagnose:
            selection = diagnose_port(host=args.host, raw_port=os.environ.get("SD_IMAGE_SORTER_PORT"))
        else:
            selection = choose_port(host=args.host, raw_port=os.environ.get("SD_IMAGE_SORTER_PORT"))
    except PortSelectionError as exc:
        if args.format == "cmd":
            print("SD_IMAGE_SORTER_PORT_STATUS=error")
            print(f"SD_IMAGE_SORTER_PORT_MESSAGE={exc}")
        elif args.format == "sh":
            print("export SD_IMAGE_SORTER_PORT_STATUS=error")
            print(f"export SD_IMAGE_SORTER_PORT_MESSAGE={shlex.quote(str(exc))}")
        else:
            print(f"[ERROR] {exc}")
        return 1

    if args.format == "cmd":
        print(_format_cmd(selection, host=args.host))
    elif args.format == "sh":
        print(_format_sh(selection, host=args.host))
    else:
        print(selection.message)
        print(selection.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
