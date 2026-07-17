"""Request model + provider alias maps for the Dataset Maker translation service.

Split out of ``services/dataset_translate_service.py`` (2026-07) VERBATIM —
pure data only: the pydantic request model, the two provider alias maps, and
the two auto-fallback provider chains. No state, no I/O, no patch seams. The
facade re-exports every name here so every historical
``services.dataset_translate_service.<name>`` keeps resolving (locked by
tests/test_dataset_translate_pins.py + tests/test_dataset_translate.py).
"""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


# ------------------------------ request model ------------------------------

class DatasetTranslateRequest(BaseModel):
    """Translate Dataset Maker tags/captions for review.

    Translation output is advisory only. The frontend must not write the
    translation back into training captions unless the user explicitly asks.
    """

    model_config = ConfigDict(extra="ignore")

    texts: List[str] = Field(default_factory=list, max_length=200)
    mode: str = Field(default="tags", max_length=24)
    target_lang: str = Field(default="zh-CN", max_length=24)
    provider_mode: str = Field(default="vlm", max_length=24)
    prompt: Optional[str] = Field(default=None, max_length=4000)
    external_provider: Optional[str] = Field(default=None, max_length=64)
    source_lang: str = Field(default="en", max_length=24)


# ------------------------------ provider alias maps + chains -----------------------------

_DIRECT_TRANSLATION_PROVIDER_ALIASES = {
    "google": "google",
    "google_free": "google",
    "googlefree": "google",
    "mymemory": "mymemory",
    "my_memory": "mymemory",
    "mymemory_free": "mymemory",
    "mymemoryfree": "mymemory",
    "baidu": "baidu",
    "baidu_sug": "baidu",
    "baidu_tag": "baidu",
}
_TRANSLATORS_PROVIDER_ALIASES = {
    "bing_free": "bing",
    "bing_web": "bing",
    "bing-free": "bing",
    "bingfree": "bing",
    "itranslate_free": "itranslate",
    "itranslate": "itranslate",
    "lingvanex_free": "lingvanex",
    "lingvanex": "lingvanex",
    "modernmt_free": "modernMt",
    "modernmt": "modernMt",
    "modern_mt": "modernMt",
    "systran_free": "sysTran",
    "systran": "sysTran",
    "sys_tran": "sysTran",
    "translatecom_free": "translateCom",
    "translatecom": "translateCom",
    "translate_com": "translateCom",
    "argos_free": "argos",
    "argos": "argos",
    "papago_free": "papago",
    "papago": "papago",
    "reverso_free": "reverso",
    "reverso": "reverso",
    "translateme_free": "translateMe",
    "translateme": "translateMe",
    "translate_me": "translateMe",
    "elia_free": "elia",
    "elia": "elia",
    "judic_free": "judic",
    "judic": "judic",
    "alibaba_free": "alibaba",
    "alibabafree": "alibaba",
    "alibaba_web": "alibaba",
    "alibaba": "alibaba",
    "baidu_free": "baidu",
    "baidu_web": "baidu",
    "baiduweb": "baidu",
    "sogou_free": "sogou",
    "sogou": "sogou",
    "qqtransmart_free": "qqTranSmart",
    "qqtransmart": "qqTranSmart",
    "qq_tran_smart": "qqTranSmart",
    "qqfanyi": "qqFanyi",
    "qq_fanyi": "qqFanyi",
    "youdao_free": "youdao",
    "youdao": "youdao",
    "iciba_free": "iciba",
    "iciba": "iciba",
    "cloudyi_free": "cloudTranslation",
    "cloudyi": "cloudTranslation",
    "cloudyifree": "cloudTranslation",
    "cloudtranslation_free": "cloudTranslation",
    "cloudtranslation": "cloudTranslation",
    "cloud_translation": "cloudTranslation",
    "caiyun_free": "caiyun",
    "caiyun": "caiyun",
    "mymemory_web": "myMemory",
    "mymemoryweb": "myMemory",
}
_MAINLAND_FREE_PROVIDER_CHAIN = [
    "baidu_free",
    "alibaba_free",
    "sogou_free",
    "youdao_free",
    "iciba_free",
    "qqtransmart_free",
    "caiyun_free",
    "cloudyi_free",
    "bing_free",
    "mymemory_free",
    "google_free",
    "baidu",
]
_GLOBAL_FREE_PROVIDER_CHAIN = [
    "google_free",
    "mymemory_free",
    "bing_free",
    "itranslate_free",
    "lingvanex_free",
    "modernmt_free",
    "systran_free",
    "translatecom_free",
    "argos_free",
    "papago_free",
    "reverso_free",
    "translateme_free",
    "elia_free",
    "judic_free",
    "alibaba_free",
    "baidu_free",
    "sogou_free",
    "qqtransmart_free",
    "youdao_free",
    "iciba_free",
    "cloudyi_free",
    "caiyun_free",
    "baidu",
]
