"""Pairing of browser extensions with this program.

The extension makes a random token, keeps it in its own storage and asks to
be paired (``POST /api/ext/pair``). The request waits, in memory, until the
user clicks Allow or Deny inside the program's own page; a web page cannot
make that click. Only the SHA-256 of the token is kept: approved pairings in
``CONFIG_DIR/browser-extensions.json``, so they survive a restart and can be
revoked in Settings. Every later call carries the token in ``X-SD-Ext-Token``
(see ``app_security``), and the Origin, when the browser sends one, must be
the extension origin that asked.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import config
from app_security import is_extension_origin

STORE_FILENAME = "browser-extensions.json"
# A request nobody answered is forgotten after this long; the extension
# simply asks again.
PENDING_TTL_SECONDS = 15 * 60
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
BROWSERS = ("chrome", "edge", "firefox", "other")
NAME_MAX_CHARS = 80

STATE_PENDING = "pending"
STATE_APPROVED = "approved"
STATE_DENIED = "denied"
STATE_UNKNOWN = "unknown"


class PairingError(ValueError):
    """A pairing request that cannot be accepted; ``code`` names it for the page."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class Pairing:
    id: str
    origin: Optional[str]
    name: str
    browser: str
    token_hash: str
    requested_at: str
    state: str = STATE_PENDING
    paired_at: Optional[str] = None

    def public(self) -> Dict[str, Any]:
        data = asdict(self)
        data.pop("token_hash")
        return data


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now_text() -> str:
    return datetime.now().isoformat(timespec="seconds")


class PairingRegistry:
    def __init__(self, store_path: Optional[Path] = None) -> None:
        self._store_path = store_path
        self._lock = threading.Lock()
        self._pending: Dict[str, tuple[float, Pairing]] = {}
        self._paired: Optional[List[Pairing]] = None

    # Storage -------------------------------------------------------------

    def _path(self) -> Path:
        return self._store_path or Path(config.CONFIG_DIR) / STORE_FILENAME

    def _load(self) -> List[Pairing]:
        if self._paired is not None:
            return self._paired
        paired: List[Pairing] = []
        try:
            raw = json.loads(self._path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = {}
        for item in raw.get("paired", []) if isinstance(raw, dict) else []:
            try:
                paired.append(Pairing(**{**item, "state": STATE_APPROVED}))
            except TypeError:
                continue
        self._paired = paired
        return paired

    def _save(self) -> None:
        path = self._path()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"paired": [asdict(p) for p in self._paired or []]}
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(path)

    def _drop_expired(self) -> None:
        cutoff = time.monotonic() - PENDING_TTL_SECONDS
        for key in [k for k, (at, _p) in self._pending.items() if at < cutoff]:
            del self._pending[key]

    # Requests --------------------------------------------------------------

    def request(
        self, *, origin: Optional[str], name: str, browser: str, token: str
    ) -> Pairing:
        """Record a pairing request; it waits for the user's Allow or Deny."""
        if not TOKEN_RE.match(token or ""):
            raise PairingError("The extension sent no usable token.", "ext_bad_token")
        if origin is not None and not is_extension_origin(origin):
            raise PairingError(
                "Only a browser extension can ask to be paired.", "ext_not_extension"
            )
        browser = browser if browser in BROWSERS else "other"
        name = " ".join(str(name or "").split())[:NAME_MAX_CHARS] or "Browser extension"
        pairing = Pairing(
            id=secrets.token_hex(8),
            origin=origin,
            name=name,
            browser=browser,
            token_hash=hash_token(token),
            requested_at=_now_text(),
        )
        with self._lock:
            self._drop_expired()
            # One open request per extension: asking again replaces it.
            for key in [
                k for k, (_at, p) in self._pending.items() if p.origin == origin
            ]:
                del self._pending[key]
            self._pending[pairing.id] = (time.monotonic(), pairing)
        return pairing

    def pending(self) -> List[Dict[str, Any]]:
        """Waiting requests; ``replaces_existing`` is true when the same
        extension (origin) is already paired, so allowing replaces that pairing."""
        with self._lock:
            self._drop_expired()
            paired_origins = {p.origin for p in self._load() if p.origin}
            return [
                {**p.public(), "replaces_existing": p.origin in paired_origins}
                for _at, p in self._pending.values()
                if p.state == STATE_PENDING
            ]

    def decide(self, pairing_id: str, allow: bool) -> Optional[Dict[str, Any]]:
        """Allow or deny one waiting request; None when it is gone."""
        with self._lock:
            self._drop_expired()
            entry = self._pending.get(pairing_id)
            if entry is None or entry[1].state != STATE_PENDING:
                return None
            pairing = entry[1]
            if not allow:
                pairing.state = STATE_DENIED
                return pairing.public()
            del self._pending[pairing_id]
            pairing.state = STATE_APPROVED
            pairing.paired_at = _now_text()
            paired = self._load()
            # The same extension paired again replaces its old pairing.
            self._paired = [
                p for p in paired if p.origin != pairing.origin or p.origin is None
            ]
            self._paired.append(pairing)
            self._save()
            return pairing.public()

    # Paired ----------------------------------------------------------------

    def paired(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [p.public() for p in self._load()]

    def revoke(self, pairing_id: str) -> bool:
        with self._lock:
            paired = self._load()
            kept = [p for p in paired if p.id != pairing_id]
            if len(kept) == len(paired):
                return False
            self._paired = kept
            self._save()
            return True

    def is_known_origin(self, origin: Optional[str]) -> bool:
        """True for an extension origin that is paired or waiting for an answer."""
        if not is_extension_origin(origin):
            return False
        with self._lock:
            if any(p.origin == origin for p in self._load()):
                return True
            return any(p.origin == origin for _at, p in self._pending.values())

    def _match(
        self, candidates, token: str, origin: Optional[str]
    ) -> Optional[Pairing]:
        digest = hash_token(token)
        for pairing in candidates:
            if not hmac.compare_digest(pairing.token_hash, digest):
                continue
            if (
                origin is not None
                and pairing.origin is not None
                and origin != pairing.origin
            ):
                return None
            return pairing
        return None

    def state_for(self, token: Optional[str], origin: Optional[str]) -> str:
        """pending / approved / denied / unknown for the token an extension holds."""
        if not token or not TOKEN_RE.match(token):
            return STATE_UNKNOWN
        with self._lock:
            self._drop_expired()
            if self._match(self._load(), token, origin):
                return STATE_APPROVED
            match = self._match([p for _at, p in self._pending.values()], token, origin)
            return match.state if match else STATE_UNKNOWN

    def authorize(
        self, token: Optional[str], origin: Optional[str]
    ) -> Optional[Dict[str, Any]]:
        """The approved pairing this token belongs to, or None."""
        if not token or not TOKEN_RE.match(token):
            return None
        with self._lock:
            pairing = self._match(self._load(), token, origin)
            if pairing is None:
                return None
            return pairing.public()

    def reset_for_tests(self, store_path: Optional[Path]) -> None:
        with self._lock:
            self._store_path = store_path
            self._pending.clear()
            self._paired = None


_registry = PairingRegistry()


def get_pairing_registry() -> PairingRegistry:
    return _registry


def check_ext_token(path: str, origin: Optional[str], token: Optional[str]) -> bool:
    """The guard's token check: the status call accepts any known request,
    every other /api/ext call an approved pairing only."""
    registry = get_pairing_registry()
    if path == "/api/ext/pair/status":
        return registry.state_for(token, origin) != STATE_UNKNOWN
    return registry.authorize(token, origin) is not None
