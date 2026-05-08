from __future__ import annotations

import errno
import socket

import pytest

import launcher_port


def test_parse_port_marks_missing_value_as_default():
    port, explicit = launcher_port.parse_port(None)

    assert port == 8487
    assert explicit is False


def test_parse_port_rejects_invalid_values():
    with pytest.raises(launcher_port.PortSelectionError, match="expected a number"):
        launcher_port.parse_port("banana")

    with pytest.raises(launcher_port.PortSelectionError, match="1 to 65535"):
        launcher_port.parse_port("70000")


def test_url_host_for_bind_host_preserves_non_default_loopback_addresses():
    assert launcher_port.url_host_for_bind_host("127.0.0.2") == "127.0.0.2"
    assert launcher_port.url_host_for_bind_host("::1") == "[::1]"
    assert launcher_port.url_host_for_bind_host("[::1]") == "[::1]"


def test_shell_format_exports_url_host_matching_probe_host():
    selection = launcher_port.PortSelection(port=8587, status="ok", message="ready")

    output = launcher_port._format_sh(selection, host="127.0.0.2")

    assert "export SD_IMAGE_SORTER_URL_HOST=127.0.0.2" in output


def test_cmd_format_exports_url_host_matching_probe_host():
    selection = launcher_port.PortSelection(port=8587, status="ok", message="ready")

    output = launcher_port._format_cmd(selection, host="::1")

    assert "SD_IMAGE_SORTER_URL_HOST=[::1]" in output


def test_choose_port_uses_default_when_available(monkeypatch):
    monkeypatch.setattr(
        launcher_port,
        "probe_port",
        lambda host, port: launcher_port.PortProbe(ok=True),
    )

    selection = launcher_port.choose_port(raw_port=None)

    assert selection.port == 8487
    assert selection.status == "ok"


def test_choose_port_auto_falls_forward_when_default_is_blocked(monkeypatch):
    probes = []

    def fake_probe(host, port):
        probes.append(port)
        if port == 8487:
            return launcher_port.PortProbe(
                ok=False,
                reason="Windows refused this port.",
                can_auto_fallback=True,
            )
        return launcher_port.PortProbe(ok=True)

    monkeypatch.setattr(launcher_port, "probe_port", fake_probe)

    selection = launcher_port.choose_port(raw_port=None)

    assert selection.port == 8488
    assert selection.status == "changed"
    assert probes == [8487, 8488]


def test_choose_port_does_not_change_explicit_user_port(monkeypatch):
    monkeypatch.setattr(
        launcher_port,
        "probe_port",
        lambda host, port: launcher_port.PortProbe(ok=False, reason="blocked"),
    )

    with pytest.raises(launcher_port.PortSelectionError, match="explicitly set SD_IMAGE_SORTER_PORT"):
        launcher_port.choose_port(raw_port="8587")


def test_choose_port_does_not_auto_fallback_when_default_is_in_use(monkeypatch):
    monkeypatch.setattr(
        launcher_port,
        "probe_port",
        lambda host, port: launcher_port.PortProbe(
            ok=False,
            reason="Another process is already using this port.",
            can_auto_fallback=False,
        ),
    )

    with pytest.raises(launcher_port.PortSelectionError, match="already open"):
        launcher_port.choose_port(raw_port=None)


def test_describe_bind_error_explains_windows_access_denied():
    error = OSError(errno.EACCES, "permission denied")

    assert "reserved" in launcher_port.describe_bind_error(error)


def test_probe_port_reports_in_use_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        port = sock.getsockname()[1]

        probe = launcher_port.probe_port("127.0.0.1", port)

    assert probe.ok is False
    assert "using this port" in probe.reason
    assert probe.can_auto_fallback is False


def test_diagnose_port_reports_blocked_default_without_selecting_fallback(monkeypatch):
    probes = []

    def fake_probe(host, port):
        probes.append(port)
        return launcher_port.PortProbe(
            ok=False,
            reason="Windows refused this port.",
            can_auto_fallback=True,
        )

    monkeypatch.setattr(launcher_port, "probe_port", fake_probe)

    selection = launcher_port.diagnose_port(raw_port=None)

    assert selection.port == 8487
    assert selection.status == "blocked"
    assert "unavailable" in selection.message
    assert probes == [8487]
