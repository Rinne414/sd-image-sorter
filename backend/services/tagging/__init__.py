"""AI tagging pipeline: catalog, validation, runtime plan, worker, exports.

This package is the decomposition of the old ~2600-line
services/tagging_service.py god-file (2026-07), executed under the 108
characterization pins in tests/test_tagging_pins*.py. Import through
services.tagging_service (the compatibility facade) for existing code, or
from the specific submodule for new code. Submodule map: catalog / request /
validation / runtime_plan / worker / progress / jobs / exports / library_io /
service — see the facade docstring for ownership details.
"""
