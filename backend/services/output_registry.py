"""Files the save flows wrote while this server runs.

"Open folder" after a save may reveal only these, so the reveal endpoint
never opens a path a page simply asked for.
"""
from __future__ import annotations

import os
import threading
from collections import OrderedDict

_RECENT_OUTPUTS: "OrderedDict[str, None]" = OrderedDict()
_RECENT_OUTPUTS_LOCK = threading.Lock()
_RECENT_OUTPUTS_MAX = 2000


def _output_key(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def remember_saved_output(path: str) -> None:
    key = _output_key(path)
    with _RECENT_OUTPUTS_LOCK:
        _RECENT_OUTPUTS.pop(key, None)
        _RECENT_OUTPUTS[key] = None
        while len(_RECENT_OUTPUTS) > _RECENT_OUTPUTS_MAX:
            _RECENT_OUTPUTS.popitem(last=False)


def was_saved_output(path: str) -> bool:
    with _RECENT_OUTPUTS_LOCK:
        return _output_key(path) in _RECENT_OUTPUTS
