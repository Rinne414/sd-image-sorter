"""Style map UMAP layout (slice S2b.1): the optional install group, its
Model Center card, prepare / health wiring and the bilingual strings.
The layout job itself is covered by test_style_map_umap.py."""

from __future__ import annotations

import sys


import optional_dependencies as deps
from services import model_service
from tests.test_style_map_umap import REPO_ROOT


class TestInstallGroup:
    def test_umap_group_is_declared_with_its_native_dependencies(self):
        packages = deps.OPTIONAL_DEPENDENCY_GROUPS["umap"]
        names = [p.split(">=")[0].split("==")[0] for p in packages]
        assert names == [
            "umap-learn",
            "pynndescent",
            "numba",
            "llvmlite",
            "scikit-learn",
            "scipy",
        ]
        assert deps.GROUP_IMPORTS["umap"] == (
            "umap",
            "pynndescent",
            "numba",
            "llvmlite",
            "sklearn",
            "scipy",
        )
        for module_name in deps.GROUP_IMPORTS["umap"]:
            assert module_name in deps.IMPORT_TO_PACKAGE_HINT

    def test_group_versions_come_from_the_full_lock(self):
        lock = deps._load_requirement_version_map()
        for package in (
            "umap-learn",
            "pynndescent",
            "numba",
            "llvmlite",
            "scikit-learn",
            "scipy",
        ):
            assert deps._normalize_package_name(package) in lock, package
        assert lock["umap_learn"].startswith("umap-learn==")

    def test_style_map_umap_card_maps_to_the_group(self):
        from routers.models import MODEL_DEPENDENCY_GROUPS

        assert MODEL_DEPENDENCY_GROUPS["style-map-umap"] == "umap"

    def test_plan_lists_the_missing_packages(self, monkeypatch):
        def missing(module_name, declared_spec):
            return declared_spec

        monkeypatch.setattr(deps, "_resolved_install_spec", missing)
        for module_name in deps.GROUP_IMPORTS["umap"]:
            monkeypatch.delitem(sys.modules, module_name, raising=False)
        plan = deps.plan_group("umap")
        assert plan["restart_likely"] is False
        assert any(spec.startswith("umap-learn") for spec in plan["packages"])
        assert any(spec.startswith("llvmlite") for spec in plan["packages"])

    def test_prepare_installs_the_group_and_nothing_else(self, monkeypatch):
        seen = []

        def fake_ensure_group(group):
            seen.append(group)
            return deps.DependencyInstallResult(
                installed_packages=("umap-learn==0.5.12",)
            )

        monkeypatch.setattr(model_service, "ensure_group", fake_ensure_group)
        result = model_service.ModelService().prepare_model("style-map-umap")
        assert seen == ["umap"]
        assert result["status"] == "ok" and result["model_id"] == "style-map-umap"
        assert result["installed_packages"] == ["umap-learn==0.5.12"]
        assert result["paths"] == {}

    def test_prepare_stops_when_a_restart_is_needed(self, monkeypatch):
        monkeypatch.setattr(
            model_service,
            "ensure_group",
            lambda group: deps.DependencyInstallResult(
                installed_packages=("llvmlite==0.49.0",),
                restart_recommended=True,
                restart_reason=deps.RESTART_REASON_DLL_LOCK,
            ),
        )
        result = model_service.ModelService().prepare_model("style-map-umap")
        assert result["status"] == "needs_restart"

    def test_health_reports_the_layout_runtime(self, monkeypatch):
        import model_health

        monkeypatch.setattr(model_health, "_umap_runtime_available", lambda: False)
        entry = model_health.get_model_health()["umap"]
        assert entry["available"] is False
        assert entry["message_key"] == "models.styleMapUmap.missing"
        monkeypatch.setattr(model_health, "_umap_runtime_available", lambda: True)
        entry = model_health.get_model_health()["umap"]
        assert entry["available"] is True
        assert entry["message_key"] == "models.styleMapUmap.ready"

    def test_model_center_card(self, monkeypatch):
        from tests.test_model_service_pins import _base_health

        health = _base_health()
        health["umap"] = {
            "available": False,
            "message": "Not installed.",
            "message_key": "models.styleMapUmap.missing",
        }
        monkeypatch.setattr(model_service, "get_model_health", lambda: health)
        inventory = model_service.ModelService().build_model_inventory()
        card = next(item for item in inventory if item["id"] == "style-map-umap")
        assert card["group"] == "Search" and card["group_key"] == "models.group.search"
        assert card["status"] == "missing" and card["download_supported"] is True
        assert card["recommended"] is False
        assert card["message_key"] == "models.styleMapUmap.missing"
        assert card["path"] == ""
        assert any("90" in step for step in card["setup_steps"]), (
            "download size in the setup steps"
        )
        ids = [item["id"] for item in inventory]
        assert ids.index("style-map-umap") == ids.index("video-ffmpeg") + 1

    def test_i18n_strings_exist_and_are_plain(self):
        zh = (REPO_ROOT / "frontend" / "js" / "lang" / "zh-CN.js").read_text(
            encoding="utf-8"
        )
        en = (REPO_ROOT / "frontend" / "js" / "lang" / "en.js").read_text(
            encoding="utf-8"
        )
        assert (
            "'models.styleMapUmap.ready': '画风地图布局（UMAP）已就绪，地图上靠在一起的图会真的相像。'"
            in zh
        )
        for key in ("'models.styleMapUmap.ready'", "'models.styleMapUmap.missing'"):
            assert key in zh and key in en
        zh_lines = [line for line in zh.splitlines() if "models.styleMapUmap" in line]
        assert zh_lines and all("app" not in line.lower() for line in zh_lines)
        assert any("90 MB" in line for line in zh_lines)
