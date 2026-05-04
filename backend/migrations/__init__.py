"""
SQLite migration loader for numbered migration files.

Policy notes:
- Migrations are applied in strictly increasing version order.
- Versions must be unique.
- Add new migrations; do not mutate the semantics of already-shipped ones.
"""
from __future__ import annotations

from dataclasses import dataclass
import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Callable, List


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    apply: Callable


def _load_module_from_path(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(f"migrations.runtime_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load migration module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def get_migrations() -> List[Migration]:
    migrations_dir = Path(__file__).resolve().parent
    migrations: List[Migration] = []

    for path in sorted(migrations_dir.glob("[0-9][0-9][0-9]_*.py")):
        module = _load_module_from_path(path)
        migrations.append(
            Migration(
                version=int(getattr(module, "VERSION")),
                name=str(getattr(module, "NAME", path.stem)),
                apply=getattr(module, "apply"),
            )
        )

    migrations.sort(key=lambda migration: migration.version)
    versions = [migration.version for migration in migrations]
    if len(versions) != len(set(versions)):
        raise ValueError(f"Duplicate migration versions detected: {versions}")
    return migrations
