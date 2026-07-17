"""No-key web provider clients for the Dataset Maker translation service.

Split out of ``services/dataset_translate_service.py`` (2026-07) VERBATIM —
the direct google/mymemory/baidu-sug clients, the ``translators``-backed web
engines, and the keyed bing/custom clients. Two seams are load-bearing
(tests/test_dataset_translate_pins.py):

* every client builds its client through the module-level ``httpx`` NAME
  (NEVER ``from httpx import AsyncClient``) — the MockTransport harness
  patches ``AsyncClient`` on the shared ``httpx`` module object;
* the ``translators`` import and the ``optional_dependencies.ensure_group``
  fallback stay LAZY inside ``_translate_translators_web`` —
  ``ensure_group("translation")`` AUTO-INSTALLS packages (heavy side effect)
  and must never run at import time.
"""
from __future__ import annotations

import asyncio
import importlib
import logging
import os
from typing import List

import httpx

from services.dataset_translate_models import _TRANSLATORS_PROVIDER_ALIASES
from services.dataset_translate_parsing import (
    _split_caption_tags,
    _translation_lang_code,
    _translation_source_lang,
)


logger = logging.getLogger(__name__)


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
