"""Fixed response containing the verified Dataset Maker trainer contracts."""

from typing import Tuple, Union

from pydantic import BaseModel, ConfigDict

from services.dataset_export.anima_contract import (
    AnimaTrainerContract,
    get_anima_trainer_contract,
)
from services.dataset_export.kohya_contract import (
    KohyaTrainerContract,
    get_kohya_trainer_contract,
)


TrainerContract = Union[KohyaTrainerContract, AnimaTrainerContract]


class TrainerContractsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    trainers: Tuple[TrainerContract, ...]


def get_trainer_contracts_response() -> TrainerContractsResponse:
    return TrainerContractsResponse(
        trainers=(
            get_kohya_trainer_contract(),
            get_anima_trainer_contract(),
        )
    )


__all__ = [
    "TrainerContract",
    "TrainerContractsResponse",
    "get_trainer_contracts_response",
]
