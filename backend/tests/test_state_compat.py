"""
Tests for MutableStateProxy dict-like compatibility methods.
"""
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from services.state_compat import MutableStateProxy


def test_mutable_state_proxy_dict_protocol_methods():
    holder = {"state": {"status": "idle", "count": 1}}

    def getter():
        return holder["state"]

    def setter(new_state):
        holder["state"] = new_state.copy()

    proxy = MutableStateProxy(getter, setter)

    assert "status" in proxy
    assert "missing" not in proxy
    assert proxy.get("status") == "idle"
    assert proxy.get("missing", "fallback") == "fallback"
    assert len(proxy) == 2
    assert list(iter(proxy)) == ["status", "count"]
    assert list(proxy.keys()) == ["status", "count"]
    assert list(proxy.values()) == ["idle", 1]
    assert list(proxy.items()) == [("status", "idle"), ("count", 1)]


def test_mutable_state_proxy_update_and_copy_behavior():
    holder = {"state": {"status": "idle", "count": 1}}
    setter_calls = []

    def getter():
        return holder["state"]

    def setter(new_state):
        setter_calls.append(new_state.copy())
        holder["state"] = new_state.copy()

    proxy = MutableStateProxy(getter, setter)

    proxy.update({"status": "running"}, count=2, stage="scan")
    assert holder["state"] == {"status": "running", "count": 2, "stage": "scan"}
    assert setter_calls[-1] == {"status": "running", "count": 2, "stage": "scan"}

    snapshot = proxy.copy()
    snapshot["status"] = "mutated"
    assert holder["state"]["status"] == "running"
