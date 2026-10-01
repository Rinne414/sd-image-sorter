"""Refuse oversized uploads before the multipart body is parsed.

FastAPI parses a multipart request completely before the route runs, and
everything past 1 MiB of it goes to a temporary file, so a size check inside
the route comes too late: a 5 GB upload would first be written to disk. This
pure ASGI middleware, applied to the listed upload paths only, answers 413

- at once when ``Content-Length`` already exceeds the limit (the app never
  sees the request, nothing is written), and
- as soon as the counted bytes of a request without ``Content-Length``
  (chunked) pass the limit: the app is fed a disconnect, and whatever answer
  it then tries to send is replaced by the 413.
"""

from __future__ import annotations

import json
from typing import Dict

MIB = 1024 * 1024
# The picture itself (the routes keep their own exact check as a backstop);
# the multipart envelope (boundaries, headers) may add a little on top.
ENVELOPE_ALLOWANCE = MIB
UPLOAD_LIMITS: Dict[str, int] = {
    "/api/style-map/query": 50 * MIB,
    "/api/similarity/search-upload": 50 * MIB,
}


def _too_large_body(limit: int) -> bytes:
    detail = f"File too large (max {max(1, limit // MIB)} MB)"
    return json.dumps({"detail": detail}).encode("utf-8")


class UploadSizeLimitMiddleware:
    def __init__(self, app, limits: Dict[str, int] | None = None) -> None:
        self.app = app
        self.limits = dict(UPLOAD_LIMITS if limits is None else limits)

    async def __call__(self, scope, receive, send) -> None:
        limit = (
            self.limits.get(scope.get("path", "")) if scope["type"] == "http" else None
        )
        if limit is None or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        ceiling = limit + ENVELOPE_ALLOWANCE
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > ceiling:
            await self._refuse(send, limit)
            return
        await self._guarded(scope, receive, send, limit, ceiling)

    @staticmethod
    async def _refuse(send, limit: int) -> None:
        body = _too_large_body(limit)
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"connection", b"close"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def _guarded(self, scope, receive, send, limit: int, ceiling: int) -> None:
        state = {"seen": 0, "exceeded": False, "answered": False}

        async def counted_receive():
            if state["exceeded"]:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                state["seen"] += len(message.get("body", b""))
                if state["seen"] > ceiling:
                    state["exceeded"] = True
                    return {"type": "http.disconnect"}
            return message

        async def replacing_send(message) -> None:
            if not state["exceeded"]:
                await send(message)
                return
            # Over the limit: the app's own answer (a 400 for the torn body)
            # is dropped and the first message of it becomes the 413.
            if not state["answered"]:
                state["answered"] = True
                await self._refuse(send, limit)

        try:
            await self.app(scope, counted_receive, replacing_send)
        except Exception:
            # The torn body surfaces as a disconnect error inside the app;
            # only that one (we caused it) is swallowed.
            if not state["exceeded"]:
                raise
        if state["exceeded"] and not state["answered"]:
            await self._refuse(send, limit)
