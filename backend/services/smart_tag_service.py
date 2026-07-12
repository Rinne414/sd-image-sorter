"""Compatibility facade for the Smart Tag service (decomposed 2026-07).

The ~2900-line god-file was split verbatim into the services/smart_tag/
package, following the database.py precedent (a thin facade over db_core /
db_helpers / db_images_read / ... that keeps every historical import path
alive):

    services/smart_tag/consensus.py      noise vocab + is_noise_tag + consensus vote
    services/smart_tag/prompts.py        PROMPT_PRESETS + build_vlm_prompt + purpose filter
    services/smart_tag/request.py        SmartTagRequest + _coerce_request + _tagger_defaults
    services/smart_tag/jobs.py           SmartTagJobState + job bookkeeping helpers
    services/smart_tag/results.py        caption assembly + _persist_result + results jsonl
    services/smart_tag/sources.py        chunked source iterators + skip_existing
    services/smart_tag/tagging.py        tagger resolution + GPU batching + memory pressure
    services/smart_tag/caption_phase.py  VLM/ToriiGate caption-phase executor
    services/smart_tag/pipeline.py       job registry + _run_pipeline + start_smart_tag_job

Unlike database.py, this facade forwards attributes DYNAMICALLY instead of
statically re-importing them, because callers do more than import names:

  * services/tagging_pipeline_service.py and the test suites monkeypatch
    private seams (_resolve_tagger, _persist_result, _jobs, _active_job_id,
    SMART_TAG_ID_CHUNK_SIZE, count_selection_token_ids, ...) on THIS module
    and expect the patched value to be seen by the internal call sites;
  * tests read mutable module state (smart_tag_service._active_job_id)
    after the worker thread rebinds it via global statements.

A static from-import would freeze such names at import time. Instead:

  * getattr(smart_tag_service, name)     -> live value from the owning module
  * setattr(smart_tag_service, name, v)  -> rebinds the owning module's
    global, so a monkeypatched seam is visible to its real consumers

The "owning module" for a name is the first module in _SUBMODULE_ORDER whose
namespace contains it. The order lists consumers before definers (pipeline
before tagging, caption_phase before results, ...) because a patched
collaborator must land in the namespace its call sites resolve it from.
Every name the god-file ever exposed (public and underscore-prefixed)
resolves here exactly as before; new code should import from
services.smart_tag.* directly instead of going through this facade.
"""
from __future__ import annotations

import sys as _sys
from types import ModuleType as _ModuleType

from services.smart_tag import caption_phase as _caption_phase
from services.smart_tag import consensus as _consensus
from services.smart_tag import jobs as _jobs_module
from services.smart_tag import pipeline as _pipeline
from services.smart_tag import prompts as _prompts
from services.smart_tag import request as _request
from services.smart_tag import results as _results
from services.smart_tag import sources as _sources
from services.smart_tag import tagging as _tagging

# Consumers first, definers last (see module docstring).
_SUBMODULE_ORDER = (
    _pipeline,
    _caption_phase,
    _sources,
    _tagging,
    _request,
    _results,
    _jobs_module,
    _prompts,
    _consensus,
)

_OWNER: dict = {}
for _mod in _SUBMODULE_ORDER:
    for _name in vars(_mod):
        if not _name.startswith("__"):
            _OWNER.setdefault(_name, _mod)
del _mod, _name


class _SmartTagServiceFacade(_ModuleType):
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


_sys.modules[__name__].__class__ = _SmartTagServiceFacade
