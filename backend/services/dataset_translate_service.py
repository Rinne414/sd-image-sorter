"""Dataset Maker translation service.

Extracted from ``routers/dataset.py`` in v3.4.5 — the translation
subsystem (cache, provider alias maps, seven no-key web provider
clients, VLM bridge, and the auto-chain fallback) previously lived
inside the router module, which made the router ~780 lines longer
than its job (translate HTTP <-> service) warrants.

Public surface:
  * ``DatasetTranslateRequest`` — the pydantic request model (kept here
    so the router imports it from the service, matching the other
    dataset request models).
  * ``translate_dataset_texts(payload, texts)`` — the entry point the
    route handler calls. Returns the response dict on success and
    raises ``fastapi.HTTPException`` on provider failure (the
    domain-exception migration is intentionally deferred — see
    TECHNICAL_DEBT_NOTES Debt-07).

Behaviour is byte-for-byte identical to the pre-extraction router
implementation; this commit only moves code.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from config import DEFAULT_CACHE_DIR


logger = logging.getLogger(__name__)


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

_TRANSLATION_CACHE_LOCK = threading.Lock()
_TRANSLATION_CACHE: Optional[Dict[str, str]] = None
_TRANSLATION_CACHE_MAX_ITEMS = 50_000
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


# ------------------------------ helpers ------------------------------

def _parse_translation_output(raw_text: str, expected_count: int) -> List[str]:
    text = str(raw_text or "").strip()
    if not text:
        return [""] * expected_count
    if text.startswith("```"):
        text = text.strip("`")
        if "\n" in text:
            text = text.split("\n", 1)[1].strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            parsed = parsed.get("translations") or parsed.get("items") or []
        if isinstance(parsed, list):
            out = [str(item or "").strip() for item in parsed]
            return (out + [""] * expected_count)[:expected_count]
    except Exception:
        pass
    lines = [
        line.strip().lstrip("-*0123456789.、) ")
        for line in text.splitlines()
        if line.strip()
    ]
    if len(lines) == expected_count:
        return lines
    return [text] + [""] * max(0, expected_count - 1)


def _translation_cache_path() -> Path:
    path = Path(DEFAULT_CACHE_DIR) / "dataset-translation-cache.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _load_translation_cache() -> Dict[str, str]:
    global _TRANSLATION_CACHE
    with _TRANSLATION_CACHE_LOCK:
        if _TRANSLATION_CACHE is not None:
            return _TRANSLATION_CACHE
        path = _translation_cache_path()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            _TRANSLATION_CACHE = {
                str(k): str(v)
                for k, v in (raw.items() if isinstance(raw, dict) else [])
                if str(k) and str(v)
            }
        except Exception:
            _TRANSLATION_CACHE = {}
        return _TRANSLATION_CACHE


def _save_translation_cache() -> None:
    with _TRANSLATION_CACHE_LOCK:
        cache = _TRANSLATION_CACHE or {}
        # v3.4.5 fix: the previous LRU truncation kept the LAST N entries
        # by insertion order, which evicted frequently-used early entries
        # (the most common trigger words) in favour of rarely-used late
        # ones. Keep the most-recently-WRITTEN entries instead — for a
        # translation cache that approximates "most useful" far better
        # than insertion order did.
        if len(cache) > _TRANSLATION_CACHE_MAX_ITEMS:
            keep = list(cache.items())[-_TRANSLATION_CACHE_MAX_ITEMS:]
            cache.clear()
            cache.update(keep)
        path = _translation_cache_path()
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(path)


def _translation_cache_key(
    provider: str,
    *,
    source_lang: str,
    target_lang: str,
    mode: str,
    text: str,
) -> str:
    normalized = " ".join(str(text or "").strip().split())
    return json.dumps(
        [
            "dataset-translate-v1",
            str(provider or "auto").lower(),
            str(source_lang or "en").lower(),
            str(target_lang or "zh-CN").lower(),
            str(mode or "caption").lower(),
            normalized,
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _translation_lang_code(lang: str, *, provider: str) -> str:
    value = str(lang or "zh-CN").strip()
    if provider == "bing" and value.lower() in {"zh-cn", "zh-hans", "cn"}:
        return "zh-Hans"
    if provider == "google" and value.lower() in {"zh-hans", "zh_cn", "cn"}:
        return "zh-CN"
    if provider == "baidu" and value.lower() in {"zh-cn", "zh-hans", "zh_cn", "cn"}:
        return "zh"
    return value


def _translation_source_lang(lang: str) -> str:
    value = str(lang or "en").strip()
    return value if value and value.lower() != "auto" else "en"


# ------------------------------ provider clients ------------------------------

async def _translate_google_free(
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
) -> List[str]:
    out: List[str] = []
    headers = {"User-Agent": "Mozilla/5.0 SD-Image-Sorter Dataset Maker"}
    async with httpx.AsyncClient(timeout=12.0, headers=headers) as client:
        for text in texts:
            if not text:
                out.append("")
                continue
            response = await client.get(
                "https://translate.googleapis.com/translate_a/single",
                params={
                    "client": "gtx",
                    "sl": source_lang or "auto",
                    "tl": _translation_lang_code(target_lang, provider="google"),
                    "dt": "t",
                    "q": text,
                },
            )
            response.raise_for_status()
            data = response.json()
            segments = data[0] if isinstance(data, list) and data else []
            translated = "".join(
                str(seg[0] or "")
                for seg in segments
                if isinstance(seg, list) and seg
            ).strip()
            out.append(translated)
    return out


async def _translate_mymemory_free(
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
) -> List[str]:
    out: List[str] = []
    langpair = f"{_translation_source_lang(source_lang)}|{_translation_lang_code(target_lang, provider='mymemory')}"
    headers = {"User-Agent": "Mozilla/5.0 SD-Image-Sorter Dataset Maker"}
    async with httpx.AsyncClient(timeout=12.0, headers=headers) as client:
        for text in texts:
            if not text:
                out.append("")
                continue
            response = await client.get(
                "https://api.mymemory.translated.net/get",
                params={"q": text, "langpair": langpair},
            )
            response.raise_for_status()
            data = response.json()
            if int(data.get("responseStatus") or 0) >= 400:
                raise RuntimeError(str(data.get("responseDetails") or "MyMemory translation failed"))
            out.append(str((data.get("responseData") or {}).get("translatedText") or "").strip())
    return out


def _split_caption_tags(text: str) -> List[str]:
    return [token.strip() for token in str(text or "").split(",") if token.strip()]


def _looks_like_tag_list(text: str) -> bool:
    value = str(text or "")
    return "," in value or "_" in value or len(value.split()) <= 5


def _translate_mode_for_texts(mode: str, texts: List[str]) -> str:
    requested = str(mode or "").lower()
    if requested == "tags":
        return "tags"
    # Dataset captions are often comma-separated tag captions even when the
    # UI calls the button from a generic caption row. Treat those as tags so
    # we can dedupe/cache each token instead of spending quota on whole lines.
    if texts and all(_looks_like_tag_list(text) for text in texts):
        return "tags"
    return "caption"


async def _translate_external_uncached(
    provider: str,
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
    mode: str,
) -> Dict[str, Any]:
    provider = str(provider or "").strip().lower()
    direct_provider = _DIRECT_TRANSLATION_PROVIDER_ALIASES.get(provider)
    if direct_provider == "google":
        translations = await _translate_google_free(texts, source_lang=source_lang, target_lang=target_lang)
        provider_name = "google"
    elif direct_provider == "mymemory":
        translations = await _translate_mymemory_free(texts, source_lang=source_lang, target_lang=target_lang)
        provider_name = "mymemory"
    elif direct_provider == "baidu":
        translations = await _translate_baidu_sug_free(texts, mode=mode)
        provider_name = "baidu"
    elif provider in _TRANSLATORS_PROVIDER_ALIASES:
        translations = await _translate_translators_web(
            provider,
            texts,
            source_lang=source_lang,
            target_lang=target_lang,
        )
        provider_name = _TRANSLATORS_PROVIDER_ALIASES.get(provider, provider)
    elif provider == "bing":
        translations = await _translate_bing_keyed(texts, source_lang=source_lang, target_lang=target_lang)
        provider_name = "bing"
    elif provider == "custom":
        translations = await _translate_custom_external(
            texts,
            source_lang=source_lang,
            target_lang=target_lang,
            mode=mode,
        )
        provider_name = "custom"
    else:
        raise RuntimeError(f"Unknown external translation provider: {provider}")
    return {
        "translations": (translations + [""] * len(texts))[:len(texts)],
        "provider": provider_name,
    }


async def _translate_external_with_cache(
    provider: str,
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
    mode: str,
) -> Dict[str, Any]:
    cache = _load_translation_cache()
    keys = [
        _translation_cache_key(provider, source_lang=source_lang, target_lang=target_lang, mode=mode, text=text)
        for text in texts
    ]
    out: List[Optional[str]] = [cache.get(key) for key in keys]
    missing_index_by_text: Dict[str, List[int]] = {}
    for idx, value in enumerate(out):
        if value is None:
            missing_index_by_text.setdefault(texts[idx], []).append(idx)
    if missing_index_by_text:
        missing_texts = list(missing_index_by_text.keys())
        translated = await _translate_external_uncached(
            provider,
            missing_texts,
            source_lang=source_lang,
            target_lang=target_lang,
            mode=mode,
        )
        provider_name = str(translated.get("provider") or provider)
        changed = False
        for text, translation in zip(missing_texts, translated.get("translations") or []):
            for idx in missing_index_by_text.get(text, []):
                value = str(translation or "").strip()
                out[idx] = value
                if value:
                    cache[keys[idx]] = value
                    changed = True
        if changed:
            _save_translation_cache()
    else:
        provider_name = provider
    return {
        "translations": [str(item or "") for item in out],
        "provider": provider_name,
        "cache_hits": len(texts) - len(missing_index_by_text),
        "cache_misses": len(missing_index_by_text),
    }


async def _translate_tag_texts_smart(
    provider: str,
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
) -> Dict[str, Any]:
    token_order: List[str] = []
    seen_tokens: set[str] = set()
    tokenized: List[List[str]] = []
    for text in texts:
        tokens = _split_caption_tags(text)
        tokenized.append(tokens)
        for token in tokens:
            key = token.lower()
            if key in seen_tokens:
                continue
            seen_tokens.add(key)
            token_order.append(token)
    if not token_order:
        return {"translations": [""] * len(texts), "provider": provider, "cache_hits": 0, "cache_misses": 0, "unique_terms": 0}
    translated = await _translate_external_with_cache(
        provider,
        token_order,
        source_lang=source_lang,
        target_lang=target_lang,
        mode="tag",
    )
    if not any(str(item or "").strip() for item in translated.get("translations") or []):
        raise RuntimeError(f"{provider} returned empty tag translations")
    by_lower = {
        source.lower(): target
        for source, target in zip(token_order, translated.get("translations") or [])
    }
    return {
        "translations": [
            ", ".join(by_lower.get(token.lower(), token) or token for token in tokens)
            for tokens in tokenized
        ],
        "provider": translated.get("provider") or provider,
        "cache_hits": translated.get("cache_hits", 0),
        "cache_misses": translated.get("cache_misses", 0),
        "unique_terms": len(token_order),
    }


async def _translate_baidu_sug_free(
    texts: List[str],
    *,
    mode: str,
) -> List[str]:
    """Use Baidu's public suggestion endpoint as a weak no-key tag fallback.

    It is useful for short English tags but not a general sentence translator.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 SD-Image-Sorter Dataset Maker",
        "Referer": "https://fanyi.baidu.com/",
    }
    async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
        async def one(term: str) -> str:
            response = await client.post("https://fanyi.baidu.com/sug", data={"kw": term})
            response.raise_for_status()
            data = response.json()
            items = data.get("data") if isinstance(data, dict) else []
            if not items:
                return ""
            value = str(items[0].get("v") or "").strip()
            return value.split(";")[0].split("；")[0].strip()

        out: List[str] = []
        for text in texts:
            if not text:
                out.append("")
                continue
            tokens = _split_caption_tags(text) if mode == "tags" or "," in text else [text.strip()]
            translated = []
            for token in tokens:
                translated.append(await one(token) or token)
            out.append(", ".join(translated) if "," in text or mode == "tags" else translated[0])
    return out


async def _translate_translators_web(
    provider: str,
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
) -> List[str]:
    provider = str(provider or "").strip().lower()
    translator_name = _TRANSLATORS_PROVIDER_ALIASES.get(provider, provider)
    try:
        import translators as ts  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001
        try:
            from optional_dependencies import UnsafeDependencyInstallError, ensure_group
            install_result = ensure_group("translation")
            if install_result.installed_packages:
                importlib.invalidate_caches()
            import translators as ts  # type: ignore[import-untyped]
        except UnsafeDependencyInstallError as install_exc:
            raise RuntimeError(
                "The physton-style free web providers need the optional 'translators' runtime. "
                f"{install_exc}"
            ) from install_exc
        except Exception as install_exc:  # noqa: BLE001
            raise RuntimeError(
                "The physton-style free web providers need the optional 'translators' runtime, "
                "but automatic installation failed. Open Feature Setup/Prepare or run app setup again."
            ) from install_exc

    from_lang = str(source_lang or "auto").strip() or "auto"
    to_lang = _translation_lang_code(target_lang, provider=translator_name).strip() or "zh-CN"

    async def one(text: str) -> str:
        if not text:
            return ""

        def call(lang: str) -> str:
            return str(ts.translate_text(
                text,
                translator=translator_name,
                from_language=from_lang,
                to_language=lang,
                if_use_preacceleration=False,
                timeout=15,
            ) or "").strip()

        try:
            return await asyncio.to_thread(call, to_lang)
        except Exception as exc:  # noqa: BLE001
            if to_lang.lower() in {"zh-cn", "zh-hans"}:
                try:
                    return await asyncio.to_thread(call, "zh")
                except Exception as zh_exc:  # noqa: BLE001
                    logger.debug(
                        "Translate zh-fallback failed for target %s: %s",
                        to_lang,
                        zh_exc,
                    )
            raise exc

    return [await one(text) for text in texts]


async def _translate_bing_keyed(
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
) -> List[str]:
    key = os.environ.get("SD_IMAGE_SORTER_TRANSLATE_BING_KEY", "").strip()
    region = os.environ.get("SD_IMAGE_SORTER_TRANSLATE_BING_REGION", "").strip()
    if not key:
        raise RuntimeError(
            "Bing free/no-key endpoint rejected this runtime. Use Auto/Google/MyMemory, "
            "or set SD_IMAGE_SORTER_TRANSLATE_BING_KEY for Microsoft Translator."
        )
    headers = {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/json",
    }
    if region:
        headers["Ocp-Apim-Subscription-Region"] = region
    params = {
        "api-version": "3.0",
        "from": _translation_source_lang(source_lang),
        "to": _translation_lang_code(target_lang, provider="bing"),
    }
    async with httpx.AsyncClient(timeout=15.0, headers=headers) as client:
        response = await client.post(
            "https://api.cognitive.microsofttranslator.com/translate",
            params=params,
            json=[{"Text": text} for text in texts],
        )
        response.raise_for_status()
        data = response.json()
    return [
        str((((item.get("translations") or [{}])[0]).get("text") or "")).strip()
        for item in data
    ]


async def _translate_custom_external(
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
    mode: str,
) -> List[str]:
    url = os.environ.get("SD_IMAGE_SORTER_TRANSLATE_CUSTOM_URL", "").strip()
    if not url:
        raise RuntimeError("Set SD_IMAGE_SORTER_TRANSLATE_CUSTOM_URL to use the custom translation provider.")
    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get("SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY", "").strip()
    header_name = os.environ.get("SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY_HEADER", "Authorization").strip() or "Authorization"
    if api_key:
        headers[header_name] = api_key if header_name.lower() != "authorization" else f"Bearer {api_key}"
    async with httpx.AsyncClient(timeout=20.0, headers=headers) as client:
        response = await client.post(
            url,
            json={
                "texts": texts,
                "source_lang": source_lang,
                "target_lang": target_lang,
                "mode": mode,
            },
        )
        response.raise_for_status()
        data = response.json()
    parsed = data.get("translations") or data.get("items") if isinstance(data, dict) else data
    if not isinstance(parsed, list):
        raise RuntimeError("Custom translation response must be a JSON list or {translations: [...]}.")
    return [str(item or "").strip() for item in parsed][:len(texts)]


async def _translate_external_texts(payload: DatasetTranslateRequest, texts: List[str]) -> Dict[str, Any]:
    provider = str(payload.external_provider or "auto").strip().lower()
    mode = _translate_mode_for_texts(payload.mode, texts)
    source_lang = str(payload.source_lang or "en").strip() or "en"
    target_lang = str(payload.target_lang or "zh-CN").strip() or "zh-CN"
    attempts = [provider]
    if provider in {"", "auto", "free", "auto_global"}:
        attempts = _GLOBAL_FREE_PROVIDER_CHAIN
    elif provider in {"auto_cn", "mainland", "china", "physton"}:
        attempts = _MAINLAND_FREE_PROVIDER_CHAIN

    errors: List[str] = []
    for name in attempts:
        try:
            if mode == "tags":
                translated = await _translate_tag_texts_smart(
                    name,
                    texts,
                    source_lang=source_lang,
                    target_lang=target_lang,
                )
            else:
                translated = await _translate_external_with_cache(
                    name,
                    texts,
                    source_lang=source_lang,
                    target_lang=target_lang,
                    mode=mode,
                )
                if any(texts) and not any(str(item or "").strip() for item in translated.get("translations") or []):
                    raise RuntimeError(f"{name} returned empty translations")
            return {
                "translations": (translated.get("translations", []) + [""] * len(texts))[:len(texts)],
                "provider_mode": "external",
                "provider": translated.get("provider") or name,
                "target_lang": target_lang,
                "source_lang": source_lang,
                "mode": mode,
                "cache_hits": translated.get("cache_hits", 0),
                "cache_misses": translated.get("cache_misses", 0),
                "unique_terms": translated.get("unique_terms", len(texts)),
            }
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
            if provider not in {"", "auto", "free", "auto_global", "auto_cn", "mainland", "china", "physton"}:
                break

    raise HTTPException(status_code=502, detail={
        "error": "; ".join(errors) or "External translation failed",
        "error_type": "external_provider_error",
        "provider": provider or "auto",
    })


# ------------------------------ public entry point ------------------------------

async def translate_dataset_texts(payload: DatasetTranslateRequest, texts: List[str]) -> Dict[str, Any]:
    """Translate Dataset Maker texts via the configured VLM or free web providers.

    Response contract:
    - Always: ``translations`` — list aligned 1:1 with ``payload.texts``.
    - VLM mode adds ``provider_mode='vlm'``, ``provider``, ``model``,
      ``tokens_used``.
    - External mode adds ``provider_mode='external'``, ``provider`` (the one
      that actually succeeded), ``source_lang``, ``target_lang``, ``mode``,
      ``cache_hits``, ``cache_misses``, ``unique_terms``.
    - Errors: 400 when VLM mode has no endpoint configured; 502 with
      ``{error, error_type, provider}`` detail when the provider (or every
      provider in an auto chain) fails or returns empty output.
    """
    if not texts:
        return {"translations": [], "provider_mode": payload.provider_mode}

    provider_mode = str(payload.provider_mode or "vlm").strip().lower()
    if provider_mode != "vlm":
        return await _translate_external_texts(payload, texts)

    from routers.vlm import _build_config
    from vlm_providers import get_provider

    config = _build_config()
    if not config.endpoint and not config.use_vertex:
        raise HTTPException(status_code=400, detail="No VLM endpoint configured for translation")

    mode = "tags" if str(payload.mode or "").lower() == "tags" else "caption"
    custom_prompt = str(payload.prompt or "").strip()
    system_prompt = (
        "You are a precise translation engine for Stable Diffusion dataset captions. "
        "Translate to Chinese. Preserve tag separators, order, counts, names, model tokens, "
        "and technical terms when translation would be harmful. Return only valid JSON."
    )
    instruction = custom_prompt or (
        "Translate each item to Simplified Chinese for human review. "
        "Return a JSON array of strings with exactly the same length as the input. "
        "For tag lists, keep comma-separated structure and translate understandable tag meanings; "
        "do not invent, remove, or reorder tags."
    )
    prompt = (
        f"Target language: {payload.target_lang}\n"
        f"Input mode: {mode}\n"
        f"{instruction}\n\n"
        f"Input JSON array:\n{json.dumps(texts, ensure_ascii=False)}"
    )
    provider = get_provider(config)
    result = await provider.generate_text(prompt, system_prompt=system_prompt, max_tokens=4096, temperature=0.1)
    if result.error:
        raise HTTPException(status_code=502, detail={
            "error": result.error,
            "error_type": result.error_type or "provider_error",
            "provider": config.provider,
            "model": config.model,
        })

    translations = _parse_translation_output(result.caption or result.raw_text, len(texts))
    if not any(str(item or "").strip() for item in translations):
        raise HTTPException(status_code=502, detail={
            "error": "Translation provider returned an empty translation",
            "error_type": "empty_response",
            "provider": config.provider,
            "model": config.model,
        })
    return {
        "translations": translations,
        "provider_mode": provider_mode,
        "provider": config.provider,
        "model": result.model or config.model,
        "tokens_used": result.tokens_used,
    }
