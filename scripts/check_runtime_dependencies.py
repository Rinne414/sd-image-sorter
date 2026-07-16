#!/usr/bin/env python3
"""Validate installed dependencies with strict ONNX Runtime provider semantics."""

from __future__ import annotations

import sys
from pathlib import Path

from packaging.utils import canonicalize_name


ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from runtime_dependency_check import (  # noqa: E402
    RuntimeDependencyError,
    RuntimeSnapshot,
    active_distribution_requirements,
    capture_runtime_snapshot,
    validate_runtime_dependencies,
    validated_onnxruntime_provider,
)


def _onnxruntime_consumers(snapshot: RuntimeSnapshot) -> tuple[str, ...]:
    consumers = {
        distribution.name
        for distribution in snapshot.distributions
        if any(
            canonicalize_name(requirement.name) == "onnxruntime"
            for requirement in active_distribution_requirements(
                distribution,
                snapshot.marker_environment,
            )
        )
    }
    return tuple(sorted(consumers, key=canonicalize_name))


def main() -> int:
    try:
        snapshot = capture_runtime_snapshot()
        validate_runtime_dependencies(snapshot)
        provider = validated_onnxruntime_provider(snapshot)
        consumers = _onnxruntime_consumers(snapshot)
    except RuntimeDependencyError as error:
        print(f"[runtime-dependencies] FAILED: {error}", file=sys.stderr)
        return 1

    if provider is None:
        print(
            "[runtime-dependencies] PASSED: every active installed dependency "
            "requirement is satisfied; no ONNX Runtime distribution is installed."
        )
        return 0

    provider_name = canonicalize_name(provider.name)
    if provider_name == "onnxruntime":
        print(
            "[runtime-dependencies] PASSED: every active installed dependency "
            f"requirement is satisfied by onnxruntime {provider.version}."
        )
        return 0

    consumer_text = ", ".join(consumers) if consumers else "no active consumers"
    print(
        "[runtime-dependencies] PASSED: strict provider equivalence validated — "
        f"{provider.name} {provider.version} supplies the shared onnxruntime module "
        f"for {consumer_text}. Raw 'pip check' matches distribution names and does "
        "not understand this provider alias; this project-level check independently "
        "validates every active requirement and uses no blanket ignore."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
