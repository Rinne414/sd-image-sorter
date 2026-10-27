"""The classic interface carries the Check-step features V Opus got first.

Subject-count fixes (health check), blurry / flat pictures and long captions
with exact Anima counts (Quality Audit). The browser behaviour is pinned by
tests/e2e/specs/dataset-audit-hints.spec.ts; these tests pin what a browser
test cannot see cheaply: the numbers the page repeats from the backend, the
wiring of the new files, the language packs and the one pure function.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from services.image_quality_scores import BLUR_REVIEW_BELOW

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"
INDEX = (FRONTEND / "index.html").read_text(encoding="utf-8")
LANG = {
    name: (FRONTEND / "js" / "lang" / f"{name}.js").read_text(encoding="utf-8")
    for name in ("en", "zh-CN")
}
NEW_MODULES = {
    "subject-fixes": FRONTEND / "js" / "modules" / "subject-fixes.js",
    "audit-hints": FRONTEND / "js" / "dataset" / "audit-hints.js",
    "caption-tokens": FRONTEND / "js" / "dataset" / "caption-tokens.js",
}
KEY_USE_RE = re.compile(r"""\b(?:tr|t)\(\s*['"](dataset\.[A-Za-z0-9]+)['"]""")


def _number(text: str) -> float:
    return float(text)


def test_the_audit_default_is_the_backend_default():
    """The sharpness field, its placeholder and the script's fallback repeat the backend number."""
    field = re.search(r'<input[^>]*id="dataset-audit-blur-below"[^>]*>', INDEX)
    assert field, "the Quality Audit has no sharpness field"
    value = re.search(r'\bvalue="([^"]*)"', field.group(0))
    placeholder = re.search(r'\bplaceholder="([^"]*)"', field.group(0))
    assert value and _number(value.group(1)) == BLUR_REVIEW_BELOW
    assert placeholder and _number(placeholder.group(1)) == BLUR_REVIEW_BELOW
    script = NEW_MODULES["audit-hints"].read_text(encoding="utf-8")
    fallback = re.search(r"const DEFAULT_BLUR_BELOW = ([0-9.]+);", script)
    assert fallback and _number(fallback.group(1)) == BLUR_REVIEW_BELOW


def test_the_new_files_are_loaded():
    assert '<script src="/static/js/modules/subject-fixes.js"></script>' in INDEX
    assert '<link rel="stylesheet" href="/static/css/dataset-checks.css">' in INDEX
    assert (FRONTEND / "css" / "dataset-checks.css").is_file()
    core = (FRONTEND / "js" / "dataset" / "core.js").read_text(encoding="utf-8")
    order = [
        core.index(f"'/static/js/dataset/{name}.js'")
        for name in ("audit", "audit-run", "caption-tokens", "audit-hints")
    ]
    assert order == sorted(order), "audit, audit-run, then the hint modules"
    # The sepcon files stay before the module that health.js calls at click time.
    assert INDEX.index("separation-console/health.js") < INDEX.index(
        "modules/subject-fixes.js"
    )


def test_every_text_key_the_new_files_use_is_in_both_languages():
    used: set[str] = set()
    for path in NEW_MODULES.values():
        used.update(KEY_USE_RE.findall(path.read_text(encoding="utf-8")))
    audit = (FRONTEND / "js" / "dataset" / "audit.js").read_text(encoding="utf-8")
    used.update(
        re.findall(r"'(dataset\.audit(?:Badge|Next)(?:Blurry|Flat|TooLong))'", audit)
    )
    used.update(
        re.findall(
            r'data-i18n(?:-title)?="(dataset\.(?:audit|subjectFix)[A-Za-z]+)"', INDEX
        )
    )
    assert len(used) > 25, "the scan found too few keys to trust"
    for name, text in LANG.items():
        missing = sorted(key for key in used if f"'{key}':" not in text)
        assert not missing, f"{name}.js lacks: {missing}"


def test_the_texts_state_the_download_size_and_that_counts_are_estimates():
    en, zh = LANG["en"], LANG["zh-CN"]
    assert re.search(
        r"'dataset\.auditTokensDownloadNote': '[^']*only estimates[^']*\{mb\} MB[^']*'",
        en,
    )
    assert re.search(
        r"'dataset\.auditTokensDownloadNote': '[^']*估算[^']*\{mb\} MB[^']*'", zh
    )
    assert "'dataset.auditTokensPrepare': 'Download for exact counts ({mb} MB)'" in en


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required")
def test_remove_tags_keeps_solo_focus_spacing_and_other_tags():
    script = r"""
const fs = require('fs'), vm = require('vm');
const source = fs.readFileSync(process.argv[1], 'utf8');
const sandbox = { window: {}, document: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const S = sandbox.window.SubjectFixes;
const out = {
  solo: S.removeTags('1girl, 1boy, solo, solo_focus', ['solo']),
  both: S.removeTags('1girl, solo, 2girls, long_hair', ['1girl', 'solo']),
  spelling: S.removeTags('Multiple_Girls, 1girl, smile', ['multiple girls']),
  untouched: S.removeTags('1girl,smile', ['solo']),
  tight: S.removeTags('1girl,solo,smile', ['solo']),
  all: S.removeTags('solo', ['solo']),
  proposals: S.proposalsOf({ fix: { proposals: [
    { image_id: 5, keep: ['2girls'], drop: ['1girl'] },
    { image_id: 5, keep: [], drop: ['solo'] },
    { image_id: -1, keep: [], drop: ['solo'] },
    { image_id: 0, keep: [], drop: ['solo'] },
    { image_id: 6, keep: [], drop: [] },
    { image_id: 7, drop: ['solo'] },
  ] } }).map((p) => p.image_id),
};
process.stdout.write(JSON.stringify(out));
"""
    done = subprocess.run(
        ["node", "-e", script, str(NEW_MODULES["subject-fixes"])],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    assert json.loads(done.stdout) == {
        "solo": "1girl, 1boy, solo_focus",
        "both": "2girls, long_hair",
        "spelling": "1girl, smile",
        "untouched": "1girl,smile",
        "tight": "1girl,smile",
        "all": "",
        # A folder picture keeps its own negative id; 0 is no picture.
        "proposals": [5, -1, 7],
    }
