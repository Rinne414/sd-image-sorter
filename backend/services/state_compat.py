"""
Compatibility helpers for legacy dict-style state access.

These shims exist so routers/tests can keep their old access pattern while the
real state authority stays inside the service layer.
"""

from typing import Any, Callable, Dict


class MutableStateProxy:
    """Expose a dict-like interface backed by service getter/setter callbacks."""

    def __init__(
        self,
        state_getter: Callable[[], Dict[str, Any]],
        state_setter: Callable[[Dict[str, Any]], None],
    ):
        self._state_getter = state_getter
        self._state_setter = state_setter

    def __getitem__(self, key: str) -> Any:
        return self._state_getter()[key]

    def __setitem__(self, key: str, value: Any) -> None:
        state = self._state_getter()
        state[key] = value
        self._state_setter(state)

    def __contains__(self, key: object) -> bool:
        return key in self._state_getter()

    def __iter__(self):
        return iter(self._state_getter())

    def __len__(self) -> int:
        return len(self._state_getter())

    def get(self, key: str, default: Any = None) -> Any:
        return self._state_getter().get(key, default)

    def items(self):
        return self._state_getter().items()

    def keys(self):
        return self._state_getter().keys()

    def values(self):
        return self._state_getter().values()

    def update(self, other=None, **kwargs) -> None:
        state = self._state_getter()
        if other is not None:
            state.update(other)
        if kwargs:
            state.update(kwargs)
        self._state_setter(state)

    def copy(self) -> Dict[str, Any]:
        return self._state_getter().copy()
