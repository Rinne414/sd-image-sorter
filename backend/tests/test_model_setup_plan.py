"""The first-use confirm says up front whether setup needs a restart.

GET /api/models/plan reports the Python packages a model's setup still has to
install and whether a restart is likely, without installing anything.
"""

from __future__ import annotations

import sys
import types

import optional_dependencies as deps


def _missing(*modules: str):
    def resolved(module_name: str, declared_spec: str):
        return declared_spec if module_name in modules else None

    return resolved


def test_first_install_of_modules_never_imported_needs_no_restart(monkeypatch):
    monkeypatch.setattr(deps, "_resolved_install_spec", _missing("fastembed"))
    monkeypatch.delitem(sys.modules, "fastembed", raising=False)

    plan = deps.plan_group("clip")

    assert plan["packages"] == ["fastembed>=0.4.0"]
    assert plan["restart_likely"] is False


def test_replacing_an_already_imported_module_needs_a_restart(monkeypatch):
    monkeypatch.setattr(deps, "_resolved_install_spec", _missing("open_clip"))
    monkeypatch.setitem(sys.modules, "open_clip", types.ModuleType("open_clip"))

    plan = deps.plan_group("aesthetic")

    assert plan["packages"] == ["open-clip-torch>=2.24.0"]
    assert plan["restart_likely"] is True


def test_windows_cpu_torch_swap_for_toriigate_needs_a_restart(monkeypatch):
    monkeypatch.setattr(deps, "_resolved_install_spec", _missing())
    monkeypatch.setattr(deps.sys, "platform", "win32")
    monkeypatch.setattr(deps.importlib.metadata, "version", lambda name: "2.13.0+cpu")

    assert deps.plan_group("toriigate")["restart_likely"] is True


def test_plan_endpoint_does_not_promise_no_restart_for_unplanned_models(test_client):
    # WD14 has no dependency group, but its Prepare can still swap in the GPU
    # ONNX runtime and recommend a restart, so the answer is "not known".
    response = test_client.get("/api/models/plan?model_id=wd14")

    assert response.status_code == 200
    assert response.json() == {
        "model_id": "wd14",
        "packages": [],
        "restart_likely": None,
    }
