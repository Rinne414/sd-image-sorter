"""The network proxy setting (see network_proxy.py)."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import network_proxy
from app_security import require_own_page

router = APIRouter(prefix="/api/network", tags=["network"])

MAX_PROXY_LENGTH = 2048
INSTALL_RUNNING_MESSAGE = (
    "An install is running. Change the proxy after it finishes. / "
    "正在安装，等它结束再改代理。"
)


class ProxyRequest(BaseModel):
    proxy: str = Field(default="", max_length=MAX_PROXY_LENGTH)


def _install_running() -> bool:
    # Read through the module: routers.models rebinds _prepare_result.
    from routers import models as models_router

    with models_router._prepare_lock:
        return bool(models_router._prepare_result.get("active"))


@router.get("/proxy", summary="Read the network proxy")
def get_proxy(http_request: Request) -> Dict[str, str]:
    # A saved address can hold a password, so other local web apps do not get it.
    require_own_page(http_request, "read the network proxy")
    return network_proxy.proxy_status()


@router.post("/proxy", summary="Save the network proxy and start using it")
def set_proxy(request: ProxyRequest, http_request: Request) -> Dict[str, str]:
    require_own_page(http_request, "change the network proxy")
    # Changing it closes the Hugging Face connection a running download is using.
    if _install_running():
        raise HTTPException(status_code=409, detail=INSTALL_RUNNING_MESSAGE)
    try:
        network_proxy.save_proxy(request.proxy)
    except network_proxy.InvalidProxyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return network_proxy.proxy_status()


@router.post("/proxy/test", summary="Try the download sites through a proxy")
def test_proxy(request: ProxyRequest, http_request: Request) -> Dict[str, Any]:
    require_own_page(http_request, "test the network proxy")
    try:
        return network_proxy.test_proxy(request.proxy)
    except network_proxy.InvalidProxyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
