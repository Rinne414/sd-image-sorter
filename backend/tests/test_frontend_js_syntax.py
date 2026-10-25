"""Frontend ES modules are parsed as modules (2026-10-26).

``node --check`` on a module file let a stray ``}``` through in
style-map/custom-axes-view.js; the browser then refused to load the style map.
scripts/check_frontend_js_syntax.py (the CI "frontend js syntax" step) parses
modules with ``--input-type=module``; this checks the modules here as well, so
a local run catches it before CI.
"""

import importlib.util
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="needs Node.js")


def _checker():
    spec = importlib.util.spec_from_file_location(
        "check_frontend_js_syntax_for_test",
        ROOT / "scripts" / "check_frontend_js_syntax.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_every_frontend_module_parses_as_a_module():
    checker = _checker()
    modules = [
        path
        for path in sorted((ROOT / "frontend" / "js").glob("**/*.js"))
        if "vendor" not in path.parts
        and checker.is_module(path.read_text(encoding="utf-8"))
    ]

    assert any(path.parent.name == "style-map" for path in modules)
    assert [str(path) for path in modules if not checker.check(NODE, path)] == []


def test_a_broken_template_in_a_module_is_caught(tmp_path):
    checker = _checker()
    broken = tmp_path / "broken.js"
    broken.write_text(
        "export function f(t, label) {\n"
        "    add(join(label, t('k', { n: 1 })}`, 'warn');\n"
        "}\n",
        encoding="utf-8",
    )

    assert checker.is_module(broken.read_text(encoding="utf-8"))
    assert checker.check(NODE, broken) is False
