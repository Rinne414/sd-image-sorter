from __future__ import annotations

import pytest

from runtime_dependency_check import (
    InstalledDistribution,
    MarkerEnvironment,
    RuntimeDependencyError,
    RuntimeSnapshot,
    validate_runtime_dependencies,
)


def _windows_python_312_environment() -> MarkerEnvironment:
    return MarkerEnvironment(
        implementation_name="cpython",
        implementation_version="3.12.7",
        os_name="nt",
        platform_machine="AMD64",
        platform_release="11",
        platform_system="Windows",
        platform_version="10.0.26200",
        python_full_version="3.12.7",
        platform_python_implementation="CPython",
        python_version="3.12",
        sys_platform="win32",
    )


def _snapshot(
    distributions: tuple[InstalledDistribution, ...],
    module_version: str | None,
) -> RuntimeSnapshot:
    return RuntimeSnapshot(
        distributions=distributions,
        onnxruntime_module_version=module_version,
        marker_environment=_windows_python_312_environment(),
    )


def _distribution(
    name: str,
    version: str,
    requirements: tuple[str, ...],
) -> InstalledDistribution:
    return InstalledDistribution(
        name=name,
        version=version,
        requirements=requirements,
    )


@pytest.mark.parametrize(
    "provider_name",
    ("onnxruntime", "onnxruntime-gpu", "onnxruntime-directml"),
)
def test_bare_onnxruntime_requirement_accepts_one_matching_provider(provider_name: str):
    snapshot = _snapshot(
        (
            _distribution(
                "consumer",
                "1.0.0",
                ("onnxruntime>=1.20,<2", "numpy>=1.26"),
            ),
            _distribution(provider_name, "1.21.0", ()),
            _distribution("numpy", "1.26.4", ()),
        ),
        "1.21.0",
    )

    assert validate_runtime_dependencies(snapshot) is None


@pytest.mark.parametrize(
    ("requirement", "installed_dependency"),
    (
        ("missing-lib>=2", None),
        ("shared-lib>=2", _distribution("shared-lib", "1.0.0", ())),
    ),
    ids=("missing", "conflicting"),
)
def test_non_ort_requirement_errors_are_not_hidden_by_provider_alias(
    requirement: str,
    installed_dependency: InstalledDistribution | None,
):
    distributions = (
        _distribution("consumer", "1.0.0", ("onnxruntime>=1.20", requirement)),
        _distribution("onnxruntime-gpu", "1.21.0", ()),
    )
    if installed_dependency is not None:
        distributions = (*distributions, installed_dependency)

    with pytest.raises(RuntimeDependencyError) as error:
        validate_runtime_dependencies(_snapshot(distributions, "1.21.0"))

    message = str(error.value).lower()
    assert "consumer" in message
    assert requirement.split(">=", 1)[0] in message


def test_inactive_requirement_marker_is_ignored():
    snapshot = _snapshot(
        (
            _distribution(
                "consumer",
                "1.0.0",
                (
                    "onnxruntime>=1.20",
                    "linux-only-missing>=9; sys_platform == 'linux'",
                ),
            ),
            _distribution("onnxruntime-directml", "1.21.0", ()),
        ),
        "1.21.0",
    )

    assert validate_runtime_dependencies(snapshot) is None


@pytest.mark.parametrize(
    ("requirement", "provider_version"),
    (
        ("onnxruntime>=1.22", "1.21.0"),
        ("onnxruntime!=1.21.0", "1.21.0"),
    ),
)
def test_provider_version_must_satisfy_upstream_onnxruntime_specifier(
    requirement: str,
    provider_version: str,
):
    snapshot = _snapshot(
        (
            _distribution("consumer", "1.0.0", (requirement,)),
            _distribution("onnxruntime-gpu", provider_version, ()),
        ),
        provider_version,
    )

    with pytest.raises(RuntimeDependencyError) as error:
        validate_runtime_dependencies(snapshot)

    message = str(error.value).lower()
    assert "onnxruntime" in message
    assert provider_version in message


@pytest.mark.parametrize(
    "provider_name",
    ("onnxruntime", "onnxruntime-directml"),
)
def test_direct_gpu_requirement_cannot_be_satisfied_by_another_provider(
    provider_name: str,
):
    snapshot = _snapshot(
        (
            _distribution("consumer", "1.0.0", ("onnxruntime-gpu>=1.20",)),
            _distribution(provider_name, "1.21.0", ()),
        ),
        "1.21.0",
    )

    with pytest.raises(RuntimeDependencyError) as error:
        validate_runtime_dependencies(snapshot)

    assert "onnxruntime-gpu" in str(error.value).lower()


def test_missing_onnxruntime_provider_fails():
    snapshot = _snapshot(
        (_distribution("consumer", "1.0.0", ("onnxruntime>=1.20",)),),
        "1.21.0",
    )

    with pytest.raises(RuntimeDependencyError, match="(?i)onnxruntime"):
        validate_runtime_dependencies(snapshot)


@pytest.mark.parametrize(
    "provider_names",
    (
        ("onnxruntime", "onnxruntime-gpu"),
        ("onnxruntime", "onnxruntime-directml"),
        ("onnxruntime-gpu", "onnxruntime-directml"),
    ),
)
def test_multiple_onnxruntime_providers_fail(
    provider_names: tuple[str, str],
):
    snapshot = _snapshot(
        (
            _distribution("consumer", "1.0.0", ("onnxruntime>=1.20",)),
            *(
                _distribution(provider_name, "1.21.0", ())
                for provider_name in provider_names
            ),
        ),
        "1.21.0",
    )

    with pytest.raises(RuntimeDependencyError) as error:
        validate_runtime_dependencies(snapshot)

    message = str(error.value).lower()
    assert provider_names[0] in message
    assert provider_names[1] in message


def test_missing_onnxruntime_module_fails_with_installed_provider():
    snapshot = _snapshot(
        (
            _distribution("consumer", "1.0.0", ("onnxruntime>=1.20",)),
            _distribution("onnxruntime-gpu", "1.21.0", ()),
        ),
        None,
    )

    with pytest.raises(RuntimeDependencyError) as error:
        validate_runtime_dependencies(snapshot)

    message = str(error.value).lower()
    assert "onnxruntime" in message
    assert "import" in message or "module" in message


def test_onnxruntime_module_version_must_match_provider_distribution():
    snapshot = _snapshot(
        (
            _distribution("consumer", "1.0.0", ("onnxruntime>=1.20",)),
            _distribution("onnxruntime-directml", "1.21.0", ()),
        ),
        "1.20.1",
    )

    with pytest.raises(RuntimeDependencyError) as error:
        validate_runtime_dependencies(snapshot)

    message = str(error.value)
    assert "1.21.0" in message
    assert "1.20.1" in message


@pytest.mark.parametrize(
    ("requirements", "provider_version", "module_version", "message_fragment"),
    (
        (("not a valid requirement ???",), "1.21.0", "1.21.0", "requirement"),
        (
            ("missing-lib>=1; python_version => '3.12'",),
            "1.21.0",
            "1.21.0",
            "marker",
        ),
        (("onnxruntime>=1.20",), "not-a-version", "1.21.0", "version"),
        (("onnxruntime>=1.20",), "1.21.0", "not-a-version", "version"),
    ),
    ids=(
        "invalid-requirement",
        "invalid-marker",
        "invalid-provider-version",
        "invalid-module-version",
    ),
)
def test_invalid_dependency_metadata_fails_explicitly(
    requirements: tuple[str, ...],
    provider_version: str,
    module_version: str,
    message_fragment: str,
):
    snapshot = _snapshot(
        (
            _distribution("consumer", "1.0.0", requirements),
            _distribution("onnxruntime-gpu", provider_version, ()),
        ),
        module_version,
    )

    with pytest.raises(RuntimeDependencyError) as error:
        validate_runtime_dependencies(snapshot)

    message = str(error.value).lower()
    assert "invalid" in message
    assert message_fragment in message


def test_invalid_non_ort_installed_version_fails_explicitly():
    snapshot = _snapshot(
        (
            _distribution(
                "consumer",
                "1.0.0",
                ("onnxruntime>=1.20", "shared-lib>=1"),
            ),
            _distribution("onnxruntime-gpu", "1.21.0", ()),
            _distribution("shared-lib", "not-a-version", ()),
        ),
        "1.21.0",
    )

    with pytest.raises(RuntimeDependencyError) as error:
        validate_runtime_dependencies(snapshot)

    message = str(error.value).lower()
    assert "invalid" in message
    assert "shared-lib" in message
    assert "version" in message


def test_duplicate_normalized_distribution_names_fail_with_both_versions():
    snapshot = _snapshot(
        (
            _distribution("transformers", "5.6.2", ()),
            _distribution("transformers", "5.8.0", ()),
        ),
        None,
    )

    with pytest.raises(RuntimeDependencyError) as error:
        validate_runtime_dependencies(snapshot)

    message = str(error.value).lower()
    assert "transformers" in message
    assert "5.6.2" in message
    assert "5.8.0" in message
    assert "duplicate" in message
