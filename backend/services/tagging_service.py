"""Compatibility facade for the tagging service (decomposed 2026-07).

The ~2600-line god-file was split verbatim into the services/tagging/
package, following the services/smart_tag/ precedent (980b309), protected by
the 108 characterization pins in tests/test_tagging_pins*.py:

    services/tagging/catalog.py      custom-ONNX profile tables + TAGGER_MODEL_HINTS
                                     + get_tagger_models catalog assembly
    services/tagging/request.py      TagRequest / TagImportRequest / BatchTagExportRequest
                                     / ExportPreviewRequest / CombinedTagExportRequest
                                     + resolve_request_thresholds + validation constants
    services/tagging/validation.py   custom-profile resolution + tag-request and
                                     hardware-floor validation
    services/tagging/runtime_plan.py chunk constants + _build_runtime_plan
                                     + _format_runtime_adjustment_message
    services/tagging/worker.py       _tagging_worker_main (multiprocessing spawn target)
    services/tagging/filters.py      pre-write tag filters + rescaling batch iterators
                                     + rescaling iterators + pre-tag filters + E2E stub
    services/tagging/progress.py     _build_tag_progress_state + progress get/set/reset
                                     /cancel + worker-progress merge/drain/cleanup
    services/tagging/jobs.py         _run_tagging_job supervision + start_tagging
    services/tagging/exports.py      batch/combined/preview exports + export-progress
                                     state machine + Debt-22 bulk job
    services/tagging/library_io.py   library getters + backup export/import
                                     + fix_rating_tags
    services/tagging/service.py      TaggingService assembly (mixin composition
                                     + __init__ + set_tagger_getter)

Like smart_tag_service, this facade forwards attributes DYNAMICALLY instead
of statically re-importing them, because callers do more than import names:

  * the test suites monkeypatch private seams on THIS module and expect the
    patched value to be seen by the internal call sites — verify_image_readable
    and resolve_existing_indexed_image_path (worker), export_tags_batch_request
    / count_selection_token_ids / iter_selection_token_id_chunks (exports),
    db (library_io), DEFAULT_TAGGER_MODEL (validation), and
    multiprocessing.get_context (jobs);
  * routers/tags.py, services/__init__.py, tagging_pipeline_service and
    tag_score_service import request models, TaggingService,
    resolve_request_thresholds and _apply_pre_tag_filters from this path.

A static from-import would freeze such names at import time. Instead:

  * getattr(tagging_service, name)     -> live value from the owning module
  * setattr(tagging_service, name, v)  -> rebinds the owning module's
    global, so a monkeypatched seam is visible to its real consumers

The "owning module" for a name is the first module in _SUBMODULE_ORDER whose
namespace contains it. The order lists consumers before definers (jobs before
worker, validation before catalog, exports before request, ...) because a
patched collaborator must land in the namespace its call sites resolve it
from. Every name the god-file ever exposed (public and underscore-prefixed)
resolves here exactly as before; new code should import from
services.tagging.* directly instead of going through this facade.
"""
from __future__ import annotations

import sys as _sys
from types import ModuleType as _ModuleType

from services.tagging import catalog as _catalog
from services.tagging import exports as _exports
from services.tagging import filters as _filters
from services.tagging import jobs as _jobs
from services.tagging import library_io as _library_io
from services.tagging import progress as _progress
from services.tagging import request as _request
from services.tagging import runtime_plan as _runtime_plan
from services.tagging import service as _service
from services.tagging import validation as _validation
from services.tagging import worker as _worker

# Consumers first, definers last (see module docstring). validation must
# precede worker/catalog so a patched DEFAULT_TAGGER_MODEL lands where
# _resolve_model_name reads it.
_SUBMODULE_ORDER = (
    _jobs,
    _service,
    _validation,
    _worker,
    # filters after worker: worker re-imports these helpers, so the
    # setdefault owner map keeps resolving them to the worker module
    # (existing consumer/patch semantics preserved).
    _filters,
    _exports,
    _library_io,
    _runtime_plan,
    _progress,
    _request,
    _catalog,
)

_OWNER: dict = {}
for _mod in _SUBMODULE_ORDER:
    for _name in vars(_mod):
        if not _name.startswith("__"):
            _OWNER.setdefault(_name, _mod)
del _mod, _name


class _TaggingServiceFacade(_ModuleType):
    """Module subclass that forwards reads/writes to the owning submodule."""

    def __getattr__(self, name: str):
        owner = _OWNER.get(name)
        if owner is None:
            raise AttributeError(
                f"module {self.__name__!r} has no attribute {name!r}"
            )
        return getattr(owner, name)

    def __setattr__(self, name: str, value) -> None:
        owner = _OWNER.get(name)
        if owner is None:
            super().__setattr__(name, value)
        else:
            setattr(owner, name, value)

    def __delattr__(self, name: str) -> None:
        owner = _OWNER.get(name)
        if owner is None:
            super().__delattr__(name)
        else:
            delattr(owner, name)

    def __dir__(self):
        return sorted(set(super().__dir__()) | set(_OWNER))


_sys.modules[__name__].__class__ = _TaggingServiceFacade
