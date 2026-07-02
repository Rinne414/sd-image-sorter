#!/usr/bin/env python3
"""Build a conservative evidence inventory for frontend controls.

The audit is intentionally not a deletion tool.  It marks controls that have
static wiring evidence and leaves the rest for runtime/manual verification.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


CONTROL_TAGS = {"button", "input", "select", "textarea", "details", "summary", "dialog", "menu"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
GENERIC_CLASSES = {
    "active",
    "btn",
    "btn-ghost",
    "btn-help",
    "btn-icon-only",
    "btn-large",
    "btn-primary",
    "btn-secondary",
    "btn-small",
    "danger",
    "disabled",
    "full-width",
    "hidden",
    "input",
    "input-field",
    "is-active",
    "is-disabled",
    "visible",
}
SKIPPED_DIRS = {"node_modules", "__pycache__"}
LOCALIZATION_DATA_ATTRS = {
    "data-i18n",
    "data-i18n-aria",
    "data-i18n-placeholder",
    "data-i18n-title",
}
STANDARD_CATEGORIES = (
    "referenced-by-id",
    "referenced-by-data",
    "delegate-only",
    "inline-or-native",
    "native-control",
    "static-only",
    "needs-runtime-check",
)


@dataclass
class Control:
    tag: str
    line: int
    column: int
    attrs: dict[str, str]
    text_parts: list[str] = field(default_factory=list)

    @property
    def id(self) -> str:
        return self.attrs.get("id", "")

    @property
    def role(self) -> str:
        return self.attrs.get("role", "")

    @property
    def classes(self) -> list[str]:
        return [token for token in self.attrs.get("class", "").split() if token]

    @property
    def data_attrs(self) -> dict[str, str]:
        return {key: value for key, value in self.attrs.items() if key.startswith("data-")}

    @property
    def type(self) -> str:
        return self.attrs.get("type", "")

    @property
    def text(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.text_parts)).strip()

    def to_json(self, category: str, evidence: list[dict[str, str]]) -> dict[str, Any]:
        return {
            "tag": self.tag,
            "line": self.line,
            "column": self.column,
            "id": self.id or None,
            "role": self.role or None,
            "type": self.type or None,
            "name": control_name(self),
            "classes": self.classes,
            "data": self.data_attrs,
            "category": category,
            "evidence": evidence,
        }


class ControlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.controls: list[Control] = []
        self._stack: list[tuple[str, int]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attrs_dict = {key.lower(): (value or "") for key, value in attrs}
        is_role_button = tag == "a" and attrs_dict.get("role") == "button"
        if tag in CONTROL_TAGS or is_role_button:
            line, column = self.getpos()
            control = Control(tag=tag, line=line, column=column, attrs=attrs_dict)
            self.controls.append(control)
            if tag not in VOID_TAGS:
                self._stack.append((tag, len(self.controls) - 1))

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for index in range(len(self._stack) - 1, -1, -1):
            open_tag, _control_index = self._stack[index]
            if open_tag == tag:
                del self._stack[index:]
                break

    def handle_data(self, data: str) -> None:
        if not self._stack or not data.strip():
            return
        _tag, control_index = self._stack[-1]
        self.controls[control_index].text_parts.append(data)


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def iter_js_files(frontend_js_root: Path) -> list[Path]:
    files: list[Path] = []
    for root, dirs, filenames in os.walk(frontend_js_root):
        dirs[:] = [name for name in dirs if name not in SKIPPED_DIRS]
        root_path = Path(root)
        for filename in filenames:
            if filename.endswith(".js"):
                files.append(root_path / filename)
    return sorted(files)


def load_sources(repo_root: Path) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for path in iter_js_files(repo_root / "frontend" / "js"):
        text = path.read_text(encoding="utf-8")
        sources.append(
            {
                "path": path,
                "relative": path.relative_to(repo_root).as_posix(),
                "text": text,
                "lower": text.lower(),
            }
        )
    return sources


def control_name(control: Control) -> str:
    for attr_name in ("aria-label", "title", "placeholder", "value", "data-i18n", "data-i18n-title"):
        value = control.attrs.get(attr_name)
        if value:
            return value.strip()
    return control.text[:80]


def camel_case_data_name(attr_name: str) -> str:
    body = attr_name.removeprefix("data-")
    parts = [part for part in body.split("-") if part]
    if not parts:
        return ""
    return parts[0] + "".join(part[:1].upper() + part[1:] for part in parts[1:])


def compact_id_prefixes(control_id: str) -> list[str]:
    parts = control_id.split("-")
    prefixes: list[str] = []
    for length in range(len(parts) - 1, 1, -1):
        prefix = "-".join(parts[:length]) + "-"
        if len(prefix) >= 8:
            prefixes.append(prefix)
    return prefixes


def find_needle(
    sources: list[dict[str, Any]],
    needle: str,
    *,
    kind: str,
    case_sensitive: bool = True,
    limit: int = 3,
) -> list[dict[str, str]]:
    if not needle:
        return []
    results: list[dict[str, str]] = []
    needle_cmp = needle if case_sensitive else needle.lower()
    for source in sources:
        text_cmp = source["text"] if case_sensitive else source["lower"]
        start = 0
        while len(results) < limit:
            index = text_cmp.find(needle_cmp, start)
            if index < 0:
                break
            line = source["text"].count("\n", 0, index) + 1
            results.append({"kind": kind, "source": f"{source['relative']}:{line}", "pattern": needle})
            start = index + max(len(needle_cmp), 1)
        if len(results) >= limit:
            break
    return results


def find_regex(
    sources: list[dict[str, Any]],
    pattern: str,
    *,
    kind: str,
    limit: int = 3,
) -> list[dict[str, str]]:
    compiled = re.compile(pattern)
    results: list[dict[str, str]] = []
    for source in sources:
        for match in compiled.finditer(source["text"]):
            line = source["text"].count("\n", 0, match.start()) + 1
            results.append({"kind": kind, "source": f"{source['relative']}:{line}", "pattern": match.group(0)})
            if len(results) >= limit:
                return results
    return results


def control_evidence(control: Control, sources: list[dict[str, Any]]) -> list[dict[str, str]]:
    evidence: list[dict[str, str]] = []

    control_id = control.id
    if control_id:
        id_needles = [
            f"getElementById('{control_id}')",
            f'getElementById("{control_id}")',
            f"$('#{control_id}')",
            f'"#{control_id}"',
            f"'#{control_id}'",
            f"`#{control_id}`",
            f'"{control_id}"',
            f"'{control_id}'",
            f"`{control_id}`",
        ]
        for needle in id_needles:
            evidence.extend(find_needle(sources, needle, kind="id-exact", limit=2))
            if evidence:
                break
        if not any(item["kind"].startswith("id-") for item in evidence):
            for prefix in compact_id_prefixes(control_id):
                template_hits = find_regex(sources, re.escape(prefix) + r"\$\{[^}]+\}", kind="id-template", limit=2)
                if template_hits:
                    evidence.extend(template_hits)
                    break

    for attr_name, attr_value in control.data_attrs.items():
        if attr_name in LOCALIZATION_DATA_ATTRS:
            continue
        data_needles = [
            attr_name,
            camel_case_data_name(attr_name),
        ]
        if attr_value:
            data_needles.extend(
                [
                    f'[{attr_name}="{attr_value}"]',
                    f"[{attr_name}='{attr_value}']",
                    f'getAttribute("{attr_name}")',
                    f"getAttribute('{attr_name}')",
                    attr_value if len(attr_value) >= 4 else "",
                ]
            )
        for needle in data_needles:
            if not needle:
                continue
            hits = find_needle(sources, needle, kind="data-attr", limit=2)
            if hits:
                evidence.extend(hits)
                break

    for class_name in control.classes:
        if class_name in GENERIC_CLASSES:
            continue
        class_needles = [
            f".{class_name}",
            f"classList.add('{class_name}'",
            f'classList.add("{class_name}"',
            f"classList.toggle('{class_name}'",
            f'classList.toggle("{class_name}"',
            f"classList.contains('{class_name}'",
            f'classList.contains("{class_name}"',
        ]
        for needle in class_needles:
            hits = find_needle(sources, needle, kind="class-selector", limit=2)
            if hits:
                evidence.extend(hits)
                break

    if control.role:
        role_patterns = [
            f'[role="{control.role}"]',
            f"[role='{control.role}']",
            f'role="{control.role}"',
            f"role='{control.role}'",
        ]
        for needle in role_patterns:
            hits = find_needle(sources, needle, kind="role-selector", limit=2)
            if hits:
                evidence.extend(hits)
                break

    inline_handlers = [name for name in control.attrs if name.startswith("on")]
    if inline_handlers:
        evidence.append({"kind": "inline-handler", "source": f"frontend/index.html:{control.line}", "pattern": ",".join(inline_handlers)})

    href = control.attrs.get("href", "")
    if control.tag == "a" and href and href != "#":
        evidence.append({"kind": "href", "source": f"frontend/index.html:{control.line}", "pattern": href})

    return dedupe_evidence(evidence)


def dedupe_evidence(evidence: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[tuple[str, str, str]] = set()
    deduped: list[dict[str, str]] = []
    for item in evidence:
        key = (item["kind"], item["source"], item["pattern"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped[:8]


def classify_control(control: Control, evidence: list[dict[str, str]]) -> str:
    kinds = {item["kind"] for item in evidence}
    if {"id-exact", "id-template"} & kinds:
        return "referenced-by-id"
    if "data-attr" in kinds:
        return "referenced-by-data"
    if {"class-selector", "role-selector"} & kinds:
        return "delegate-only"
    if {"inline-handler", "href"} & kinds:
        return "inline-or-native"
    if control.tag in {"input", "select", "textarea"} and control.type not in {"button", "submit", "reset"}:
        return "native-control"
    if control.tag in {"button", "a"} or control.role == "button":
        return "needs-runtime-check"
    return "static-only"


def build_report(repo_root: Path) -> dict[str, Any]:
    index_path = repo_root / "frontend" / "index.html"
    parser = ControlParser()
    parser.feed(index_path.read_text(encoding="utf-8"))
    sources = load_sources(repo_root)

    controls: list[dict[str, Any]] = []
    categories: Counter[str] = Counter()
    tag_counts: Counter[str] = Counter()

    for control in parser.controls:
        evidence = control_evidence(control, sources)
        category = classify_control(control, evidence)
        categories[category] += 1
        tag_counts[control.tag] += 1
        controls.append(control.to_json(category, evidence))

    button_count = sum(1 for control in parser.controls if control.tag == "button" or control.role == "button")
    static_only_buttons = sum(
        1
        for control in controls
        if control["tag"] == "button" and control["category"] in {"static-only", "needs-runtime-check"}
    )

    return {
        "summary": {
            "total_controls": len(parser.controls),
            "buttons": button_count,
            "tags": dict(sorted(tag_counts.items())),
            "categories": {category: categories.get(category, 0) for category in STANDARD_CATEGORIES},
            "static_only_buttons": static_only_buttons,
            "needs_runtime_check": categories.get("needs-runtime-check", 0),
            "source": "frontend/index.html",
            "js_files_scanned": len(sources),
        },
        "controls": controls,
        "notes": [
            "static-only and needs-runtime-check are conservative audit labels, not deletion recommendations.",
            "Runtime confirmation with Playwright or manual clicking is required before removing or hiding any control.",
        ],
    }


def render_text(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "Frontend Control Audit",
        "======================",
        f"Source: {summary['source']}",
        f"JS files scanned: {summary['js_files_scanned']}",
        f"Total controls: {summary['total_controls']}",
        f"Buttons: {summary['buttons']}",
        "",
        "Categories:",
    ]
    for category, count in summary["categories"].items():
        lines.append(f"  - {category}: {count}")
    lines.extend(["", "Controls needing runtime check:"])
    needs_runtime = [
        control
        for control in report["controls"]
        if control["category"] in {"needs-runtime-check", "static-only"} and control["tag"] == "button"
    ][:40]
    for control in needs_runtime:
        label = control["id"] or control["name"] or f"{control['tag']}:{control['line']}"
        lines.append(f"  - {label} ({control['category']}) at frontend/index.html:{control['line']}")
    if not needs_runtime:
        lines.append("  - none")
    lines.extend(["", *[f"Note: {note}" for note in report["notes"]]])
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_script())
    parser.add_argument("--format", choices=("text", "json"), default="text")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(args.repo_root.resolve())
    if args.format == "json":
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(render_text(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
