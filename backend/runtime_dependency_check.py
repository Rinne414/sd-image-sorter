"""Strict installed dependency validation with ONNX Runtime provider support."""

from __future__ import annotations

import importlib
import importlib.metadata as metadata
from dataclasses import dataclass

from packaging.markers import (
    InvalidMarker,
    UndefinedComparison,
    UndefinedEnvironmentName,
    default_environment,
)
from packaging.requirements import InvalidRequirement, Requirement
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version


ORT_DISTRIBUTION_NAMES: tuple[str, ...] = (
    "onnxruntime",
    "onnxruntime-gpu",
    "onnxruntime-directml",
)


@dataclass(frozen=True)
class InstalledDistribution:
    name: str
    version: str
    requirements: tuple[str, ...]


@dataclass(frozen=True)
class MarkerEnvironment:
    implementation_name: str
    implementation_version: str
    os_name: str
    platform_machine: str
    platform_release: str
    platform_system: str
    platform_version: str
    python_full_version: str
    platform_python_implementation: str
    python_version: str
    sys_platform: str


@dataclass(frozen=True)
class RuntimeSnapshot:
    distributions: tuple[InstalledDistribution, ...]
    onnxruntime_module_version: str | None
    marker_environment: MarkerEnvironment


class RuntimeDependencyError(RuntimeError):
    """Raised when installed package metadata or dependencies are inconsistent."""


InstalledDistributionIndex = dict[str, tuple[InstalledDistribution, Version]]


def _marker_environment_mapping(environment: MarkerEnvironment) -> dict[str, str]:
    return {
        "implementation_name": environment.implementation_name,
        "implementation_version": environment.implementation_version,
        "os_name": environment.os_name,
        "platform_machine": environment.platform_machine,
        "platform_release": environment.platform_release,
        "platform_system": environment.platform_system,
        "platform_version": environment.platform_version,
        "python_full_version": environment.python_full_version,
        "platform_python_implementation": environment.platform_python_implementation,
        "python_version": environment.python_version,
        "sys_platform": environment.sys_platform,
        "extra": "",
    }


def _parse_version(distribution_name: str, raw_version: str) -> Version:
    try:
        return Version(raw_version)
    except (InvalidVersion, TypeError) as error:
        raise RuntimeDependencyError(
            f"Invalid version metadata {raw_version!r} for installed distribution "
            f"{distribution_name!r}. Reinstall that distribution from the application lock."
        ) from error


def _index_distributions(
    distributions: tuple[InstalledDistribution, ...],
) -> InstalledDistributionIndex:
    index: InstalledDistributionIndex = {}
    for distribution in distributions:
        if not isinstance(distribution.name, str) or not distribution.name.strip():
            raise RuntimeDependencyError(
                "Invalid installed distribution metadata: Name must be a non-empty string."
            )
        if not isinstance(distribution.version, str) or not distribution.version.strip():
            raise RuntimeDependencyError(
                f"Invalid version metadata for installed distribution {distribution.name!r}: "
                "Version must be a non-empty string."
            )
        if not isinstance(distribution.requirements, tuple) or not all(
            isinstance(requirement, str) for requirement in distribution.requirements
        ):
            raise RuntimeDependencyError(
                f"Invalid requirement metadata for installed distribution "
                f"{distribution.name!r}: Requires-Dist must contain strings."
            )

        canonical_name = canonicalize_name(distribution.name)
        if canonical_name in index:
            existing = index[canonical_name][0]
            raise RuntimeDependencyError(
                f"Invalid installed distribution metadata: {existing.name} "
                f"{existing.version} and {distribution.name} {distribution.version} "
                f"both normalize to {canonical_name!r}. "
                "Remove the duplicate installation and reinstall from the application lock."
            )
        index[canonical_name] = (
            distribution,
            _parse_version(distribution.name, distribution.version),
        )
    return index


def active_distribution_requirements(
    distribution: InstalledDistribution,
    environment: MarkerEnvironment,
) -> tuple[Requirement, ...]:
    """Parse and return the distribution requirements active in one environment."""
    marker_environment = _marker_environment_mapping(environment)
    active_requirements: list[Requirement] = []
    for raw_requirement in distribution.requirements:
        try:
            requirement = Requirement(raw_requirement)
        except InvalidRequirement as error:
            metadata_kind = "marker" if ";" in raw_requirement else "requirement"
            raise RuntimeDependencyError(
                f"Invalid {metadata_kind} metadata {raw_requirement!r} in installed "
                f"distribution {distribution.name!r}: {error}"
            ) from error

        if requirement.marker is not None:
            try:
                marker_matches = requirement.marker.evaluate(
                    environment=marker_environment,
                )
            except (
                InvalidMarker,
                UndefinedComparison,
                UndefinedEnvironmentName,
                KeyError,
                TypeError,
                ValueError,
            ) as error:
                raise RuntimeDependencyError(
                    f"Invalid requirement marker {str(requirement.marker)!r} in installed "
                    f"distribution {distribution.name!r}: {error}"
                ) from error
            if not marker_matches:
                continue
        active_requirements.append(requirement)
    return tuple(active_requirements)


def _validate_onnxruntime_state(
    distribution_index: InstalledDistributionIndex,
    module_version_text: str | None,
) -> InstalledDistribution | None:
    providers = tuple(
        distribution_index[name]
        for name in ORT_DISTRIBUTION_NAMES
        if name in distribution_index
    )
    if len(providers) > 1:
        provider_names = ", ".join(provider[0].name for provider in providers)
        raise RuntimeDependencyError(
            "Multiple mutually exclusive ONNX Runtime distributions are installed: "
            f"{provider_names}. Uninstall all ONNX Runtime variants, then run the "
            "application runtime repair to install exactly one provider."
        )
    if not providers:
        if module_version_text is not None:
            raise RuntimeDependencyError(
                "The onnxruntime module is importable but no ONNX Runtime distribution "
                "metadata is installed. Reinstall the runtime through the application repair."
            )
        return None

    provider, provider_version = providers[0]
    if module_version_text is None:
        raise RuntimeDependencyError(
            f"ONNX Runtime provider {provider.name} {provider.version} is installed, but "
            "the onnxruntime module cannot be imported. Reinstall that provider through "
            "the application runtime repair."
        )
    module_version = _parse_version("onnxruntime module", module_version_text)
    if module_version != provider_version:
        raise RuntimeDependencyError(
            f"ONNX Runtime provider {provider.name} reports version {provider.version}, "
            f"but the imported onnxruntime module reports {module_version_text}. Remove "
            "conflicting runtime files and run the application runtime repair."
        )
    return provider


def validated_onnxruntime_provider(
    snapshot: RuntimeSnapshot,
) -> InstalledDistribution | None:
    """Return the sole healthy ONNX Runtime distribution, if one is installed."""
    provider_distributions = tuple(
        distribution
        for distribution in snapshot.distributions
        if canonicalize_name(distribution.name) in ORT_DISTRIBUTION_NAMES
    )
    distribution_index = _index_distributions(provider_distributions)
    return _validate_onnxruntime_state(
        distribution_index,
        snapshot.onnxruntime_module_version,
    )


def validate_runtime_dependencies(snapshot: RuntimeSnapshot) -> None:
    """Validate every active installed requirement and the ORT provider invariant."""
    distribution_index = _index_distributions(snapshot.distributions)
    onnxruntime_provider = _validate_onnxruntime_state(
        distribution_index,
        snapshot.onnxruntime_module_version,
    )

    for distribution in snapshot.distributions:
        for requirement in active_distribution_requirements(
            distribution,
            snapshot.marker_environment,
        ):
            requirement_name = canonicalize_name(requirement.name)
            installed = distribution_index.get(requirement_name)
            if requirement_name == "onnxruntime":
                installed = (
                    distribution_index.get(canonicalize_name(onnxruntime_provider.name))
                    if onnxruntime_provider is not None
                    else None
                )
            if installed is None:
                raise RuntimeDependencyError(
                    f"Installed distribution {distribution.name} {distribution.version} "
                    f"requires {requirement}, but no matching distribution is installed. "
                    "Install the exact dependency from the application lock."
                )

            installed_distribution, installed_version = installed
            if requirement.specifier and not requirement.specifier.contains(
                installed_version,
                prereleases=None,
            ):
                raise RuntimeDependencyError(
                    f"Installed distribution {distribution.name} {distribution.version} "
                    f"requires {requirement}, but {installed_distribution.name} "
                    f"{installed_distribution.version} does not satisfy that version."
                )


def _required_environment_value(environment: dict[str, str], name: str) -> str:
    value = environment.get(name)
    if not isinstance(value, str) or not value:
        raise RuntimeDependencyError(
            f"Invalid marker environment: {name!r} must be a non-empty string."
        )
    return value


def current_marker_environment() -> MarkerEnvironment:
    """Capture the PEP 508 marker fields used by installed package metadata."""
    environment = default_environment()
    return MarkerEnvironment(
        implementation_name=_required_environment_value(
            environment,
            "implementation_name",
        ),
        implementation_version=_required_environment_value(
            environment,
            "implementation_version",
        ),
        os_name=_required_environment_value(environment, "os_name"),
        platform_machine=_required_environment_value(
            environment,
            "platform_machine",
        ),
        platform_release=_required_environment_value(
            environment,
            "platform_release",
        ),
        platform_system=_required_environment_value(
            environment,
            "platform_system",
        ),
        platform_version=_required_environment_value(
            environment,
            "platform_version",
        ),
        python_full_version=_required_environment_value(
            environment,
            "python_full_version",
        ),
        platform_python_implementation=_required_environment_value(
            environment,
            "platform_python_implementation",
        ),
        python_version=_required_environment_value(environment, "python_version"),
        sys_platform=_required_environment_value(environment, "sys_platform"),
    )


def _read_distribution(distribution: metadata.Distribution) -> InstalledDistribution:
    name = distribution.metadata.get("Name")
    version = distribution.metadata.get("Version")
    requirements = distribution.requires
    if not isinstance(name, str) or not name.strip():
        raise RuntimeDependencyError(
            "Invalid installed distribution metadata: missing non-empty Name field."
        )
    if not isinstance(version, str) or not version.strip():
        raise RuntimeDependencyError(
            f"Invalid installed distribution metadata for {name!r}: missing non-empty "
            "Version field."
        )
    if requirements is None:
        requirement_values: tuple[str, ...] = ()
    elif isinstance(requirements, list) and all(
        isinstance(requirement, str) for requirement in requirements
    ):
        requirement_values = tuple(requirements)
    else:
        raise RuntimeDependencyError(
            f"Invalid requirement metadata for installed distribution {name!r}: "
            "Requires-Dist must contain strings."
        )
    return InstalledDistribution(
        name=name,
        version=version,
        requirements=requirement_values,
    )


def _snapshot_from_distributions(
    distributions: tuple[InstalledDistribution, ...],
) -> RuntimeSnapshot:
    provider_names = {
        canonicalize_name(distribution.name)
        for distribution in distributions
        if canonicalize_name(distribution.name) in ORT_DISTRIBUTION_NAMES
    }
    module_version: str | None = None
    if provider_names:
        try:
            onnxruntime_module = importlib.import_module("onnxruntime")
        except (ImportError, OSError) as error:
            raise RuntimeDependencyError(
                "An ONNX Runtime distribution is installed, but importing the "
                f"onnxruntime module failed with {type(error).__name__}: {error}"
            ) from error
        raw_module_version = getattr(onnxruntime_module, "__version__", None)
        if not isinstance(raw_module_version, str) or not raw_module_version.strip():
            raise RuntimeDependencyError(
                "The imported onnxruntime module has no valid string __version__. "
                "Reinstall the selected runtime through the application repair."
            )
        module_version = raw_module_version

    return RuntimeSnapshot(
        distributions=distributions,
        onnxruntime_module_version=module_version,
        marker_environment=current_marker_environment(),
    )


def capture_runtime_snapshot() -> RuntimeSnapshot:
    """Read every installed distribution and probe the shared ORT module."""
    try:
        distributions = tuple(
            sorted(
                (_read_distribution(distribution) for distribution in metadata.distributions()),
                key=lambda distribution: canonicalize_name(distribution.name),
            )
        )
    except (OSError, UnicodeError) as error:
        raise RuntimeDependencyError(
            f"Could not read installed distribution metadata: {error}"
        ) from error
    return _snapshot_from_distributions(distributions)


def capture_named_runtime_snapshot(
    distribution_names: tuple[str, ...],
) -> RuntimeSnapshot:
    """Read only named distributions for a scoped runtime operation."""
    requested_names = tuple(
        sorted({canonicalize_name(name) for name in distribution_names})
    )
    distributions: list[InstalledDistribution] = []
    for requested_name in requested_names:
        try:
            matching_distributions = metadata.distributions(name=requested_name)
            for distribution in matching_distributions:
                installed = _read_distribution(distribution)
                if canonicalize_name(installed.name) != requested_name:
                    raise RuntimeDependencyError(
                        f"Requested installed distribution {requested_name!r}, but "
                        f"metadata discovery returned {installed.name!r}. Reinstall "
                        "the affected package from the application lock."
                    )
                distributions.append(installed)
        except (OSError, UnicodeError) as error:
            raise RuntimeDependencyError(
                f"Could not read installed metadata for {requested_name!r}: {error}"
            ) from error
    ordered_distributions = tuple(
        sorted(
            distributions,
            key=lambda distribution: (
                canonicalize_name(distribution.name),
                distribution.version,
            ),
        )
    )
    return _snapshot_from_distributions(ordered_distributions)
