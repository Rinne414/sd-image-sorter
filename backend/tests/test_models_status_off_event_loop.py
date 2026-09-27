"""GET /api/models/status must not hold up every other request (V3.5 3-4).

Building the model inventory takes about 0.7-0.9 s warm (8.8 s cold) on a
real models folder: it looks at every model file and runtime. The endpoint
was ``async def`` calling that synchronous work, so it ran on the event loop
and every request sent meanwhile (a 3 ms one included) waited for it.
"""

from __future__ import annotations

import asyncio
import time

import httpx

SLOW_STATUS_SECONDS = 0.6


class _SlowModelService:
    def get_status(self):
        time.sleep(SLOW_STATUS_SECONDS)
        return {"status": "ok", "models": [], "health": {}}


def test_a_slow_status_does_not_delay_another_request(test_client):
    from main import app
    from services.model_service import get_model_service

    app.dependency_overrides[get_model_service] = lambda: _SlowModelService()

    async def scenario() -> float:
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1"
        ) as client:
            started = time.perf_counter()
            status = asyncio.create_task(client.get("/api/models/status"))
            # Give the status request time to reach its slow part; a blocked
            # event loop also holds this sleep and the next request up.
            await asyncio.sleep(0.05)
            other = await client.get("/api/updates/boot-id")
            elapsed = time.perf_counter() - started
            assert other.status_code == 200
            assert (await status).status_code == 200
            return elapsed

    try:
        elapsed = asyncio.run(scenario())
    finally:
        app.dependency_overrides.pop(get_model_service, None)

    assert elapsed < SLOW_STATUS_SECONDS / 2, (
        f"the other request waited {elapsed:.2f} s"
    )
