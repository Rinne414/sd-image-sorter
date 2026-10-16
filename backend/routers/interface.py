"""The interface ``/`` opens: the classic one or Vopus (``services.interface_preference``)."""

from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import app_static
from services import interface_preference

router = APIRouter(prefix="/api/interface", tags=["interface"])


class InterfaceChoice(BaseModel):
    interface: str = Field(..., pattern="^(classic|vopus)$")


def _state() -> Dict[str, Any]:
    return {
        "interface": interface_preference.get_preferred_interface(),
        "vopus_built": app_static.vopus_is_built(),
    }


@router.get("", summary="The interface / opens, and whether Vopus is built")
def get_interface() -> Dict[str, Any]:
    return _state()


@router.put("", summary="Remember the interface / opens")
def put_interface(body: InterfaceChoice) -> Dict[str, Any]:
    """Remember ``classic`` or ``vopus``. Vopus can only be chosen once it is built (409)."""
    if body.interface == interface_preference.VOPUS and not app_static.vopus_is_built():
        raise HTTPException(
            status_code=409,
            detail="Vopus is not built yet: install Node.js and start the program again with run.bat or run.sh.",
        )
    try:
        interface_preference.set_preferred_interface(body.interface)
    except interface_preference.InterfaceChoiceBusyError as exc:
        # The file stayed held through every retry; the page shows why.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return _state()
