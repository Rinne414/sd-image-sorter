"""Characterization pins for ``services.dataset_translate_service``.

Tier-2 pins-first step 0. These lock the CURRENT observable behaviour of the
dataset-translation service byte-for-byte so a later facade/mixin split can be
proven verbatim. They are intentionally exhaustive about the seams a split
would disturb:

  * the ONE rebind seam ``_TRANSLATION_CACHE`` (``None``-lazy, mutated in place
    afterwards, ``global`` in ``_load_translation_cache``) and its lock;
  * the on-disk cache round-trip, corruption recovery, and 50k-item eviction;
  * the pure parser ``_parse_translation_output`` and the cache-key / language
    normalisation helpers;
  * the seven no-key provider clients, stubbed at the ``httpx`` transport seam
    and the optional ``translators`` library seam — NO network is ever touched;
  * the auto-chain dispatch and the public ``translate_dataset_texts`` entry.

Census: ``test_dataset_translate.py`` already pins the HTTP route contracts,
tag-token dedup + warm-cache accounting via ``_translate_external_texts``, the
``auto_cn`` mainland chain, the physton alias superset, and the ``translators``
happy path. This file deliberately does NOT duplicate those; it pins the
uncovered pure helpers, the cache lifecycle, the individual provider clients,
and the finer dispatch contracts (global-chain default, non-auto single
attempt).

Dormant quirks are pinned AS-IS and flagged with a ``DORMANT`` comment.
"""

from __future__ import annotations

import asyncio
import sys
import threading
import types
from typing import Callable

import httpx
import pytest

import services.dataset_translate_service as svc


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def isolated_cache(monkeypatch, tmp_path):
    """Redirect the disk cache to tmp_path and reset the lazy rebind seam.

    ``DEFAULT_CACHE_DIR`` is bound into the service module namespace (``from
    config import DEFAULT_CACHE_DIR``), so patching it on the service module is
    the real seam ``_translation_cache_path`` reads. ``_TRANSLATION_CACHE`` is
    forced back to ``None`` so each test observes a cold lazy init.
    """
    monkeypatch.setattr(svc, "DEFAULT_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(svc, "_TRANSLATION_CACHE", None)
    return tmp_path


def _patch_httpx(monkeypatch, handler: Callable[[httpx.Request], httpx.Response]):
    """Route every ``httpx.AsyncClient`` the service builds through a MockTransport.

    The provider clients construct their own ``httpx.AsyncClient(timeout=...,
    headers=...)`` internally; injecting ``transport=`` via a wrapping factory
    (the precedent in ``test_vlm_proxy.py`` which patches ``module.httpx.
    AsyncClient``) keeps the pins fully offline.
    """
    real_async_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.setdefault("transport", httpx.MockTransport(handler))
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(svc.httpx, "AsyncClient", factory)


# ============================================================================
# Module constants / statefulness anchors
# ============================================================================


class TestModuleConstants:
    def test_cache_max_items_is_50000(self):
        # DORMANT-adjacent anchor: the eviction algorithm keys off this literal.
        assert svc._TRANSLATION_CACHE_MAX_ITEMS == 50_000

    def test_translation_cache_lock_is_a_lock(self):
        assert isinstance(svc._TRANSLATION_CACHE_LOCK, type(threading.Lock()))

    def test_direct_provider_aliases_exact(self):
        assert svc._DIRECT_TRANSLATION_PROVIDER_ALIASES == {
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

    def test_translators_alias_sample_resolution(self):
        aliases = svc._TRANSLATORS_PROVIDER_ALIASES
        # camelCase engine names must survive verbatim through the alias map.
        assert aliases["bing_free"] == "bing"
        assert aliases["qqtransmart"] == "qqTranSmart"
        assert aliases["cloudyi_free"] == "cloudTranslation"
        assert aliases["mymemory_web"] == "myMemory"
        assert aliases["modernmt"] == "modernMt"
        assert aliases["sys_tran"] == "sysTran"

    def test_provider_chain_endpoints(self):
        # First/last entries anchor the auto-fallback ordering.
        assert svc._MAINLAND_FREE_PROVIDER_CHAIN[0] == "baidu_free"
        assert svc._MAINLAND_FREE_PROVIDER_CHAIN[-1] == "baidu"
        assert svc._GLOBAL_FREE_PROVIDER_CHAIN[0] == "google_free"
        assert svc._GLOBAL_FREE_PROVIDER_CHAIN[-1] == "baidu"
        # Both chains terminate on the keyed baidu fallback (only non-_free tail).
        assert svc._GLOBAL_FREE_PROVIDER_CHAIN.count("baidu") == 1


# ============================================================================
# Request model
# ============================================================================


class TestRequestModel:
    def test_defaults(self):
        req = svc.DatasetTranslateRequest()
        assert req.texts == []
        assert req.mode == "tags"
        assert req.target_lang == "zh-CN"
        assert req.provider_mode == "vlm"
        assert req.source_lang == "en"
        assert req.prompt is None
        assert req.external_provider is None

    def test_ignores_extra_fields(self):
        # model_config = ConfigDict(extra="ignore")
        req = svc.DatasetTranslateRequest(texts=["a"], unknown_field="x")
        assert req.texts == ["a"]
        assert not hasattr(req, "unknown_field")

    def test_texts_length_capped_at_200(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            svc.DatasetTranslateRequest(texts=["t"] * 201)


# ============================================================================
# _parse_translation_output — pure parser
# ============================================================================


class TestParseTranslationOutput:
    def test_empty_and_single_blob(self):
        assert svc._parse_translation_output("", 3) == ["", "", ""]
        assert svc._parse_translation_output("   ", 2) == ["", ""]
        # Non-JSON blob that is not line-aligned: original text in slot 0, blanks after.
        assert svc._parse_translation_output("a full english sentence here", 3) == [
            "a full english sentence here",
            "",
            "",
        ]

    def test_json_array_forms(self):
        assert svc._parse_translation_output('["长发", "蓝眼"]', 2) == ["长发", "蓝眼"]
        # Longer than expected → truncated; shorter → padded.
        assert svc._parse_translation_output('["a", "b", "c"]', 2) == ["a", "b"]
        assert svc._parse_translation_output('["a"]', 3) == ["a", "", ""]

    def test_json_dict_translations_and_items_keys(self):
        assert svc._parse_translation_output('{"translations": ["a", "b"]}', 2) == [
            "a",
            "b",
        ]
        assert svc._parse_translation_output('{"items": ["a", "b"]}', 2) == ["a", "b"]
        # translations preferred over items when both present.
        assert svc._parse_translation_output(
            '{"translations": ["x"], "items": ["y"]}', 1
        ) == ["x"]

    def test_markdown_fence_stripped(self):
        raw = '```json\n["长发", "蓝眼"]\n```'
        assert svc._parse_translation_output(raw, 2) == ["长发", "蓝眼"]

    def test_line_fallback_strips_numbering(self):
        # Bullet/number/punctuation prefixes are lstripped when line count matches.
        assert svc._parse_translation_output("1. 长发\n2. 蓝眼", 2) == ["长发", "蓝眼"]
        assert svc._parse_translation_output("- alpha\n- beta", 2) == ["alpha", "beta"]


# ============================================================================
# Pure helpers: cache key + language normalisation
# ============================================================================


class TestPureHelpers:
    def test_cache_key_collapses_whitespace_and_lowercases(self):
        key = svc._translation_cache_key(
            "Google",
            source_lang="EN",
            target_lang="ZH-CN",
            mode="Tags",
            text="  long   hair  ",
        )
        assert (
            key == '["dataset-translate-v1","google","en","zh-cn","tags","long hair"]'
        )

    def test_cache_key_falls_back_to_defaults(self):
        key = svc._translation_cache_key(
            "", source_lang="", target_lang="", mode="", text="x"
        )
        assert key == '["dataset-translate-v1","auto","en","zh-cn","caption","x"]'

    def test_lang_code_provider_specialcases(self):
        assert svc._translation_lang_code("zh-CN", provider="bing") == "zh-Hans"
        assert svc._translation_lang_code("zh-hans", provider="google") == "zh-CN"
        assert svc._translation_lang_code("zh-CN", provider="baidu") == "zh"
        # No rule for the (value, provider) pair → stripped passthrough, case kept.
        assert svc._translation_lang_code("zh-CN", provider="mymemory") == "zh-CN"
        assert svc._translation_lang_code(" ja ", provider="google") == "ja"

    def test_source_lang_auto_becomes_en(self):
        assert svc._translation_source_lang("auto") == "en"
        assert svc._translation_source_lang("AUTO") == "en"
        assert svc._translation_source_lang("") == "en"
        assert svc._translation_source_lang(" fr ") == "fr"

    def test_split_caption_tags(self):
        assert svc._split_caption_tags("long hair, blue eyes ,, smile") == [
            "long hair",
            "blue eyes",
            "smile",
        ]
        assert svc._split_caption_tags("") == []

    def test_looks_like_tag_list(self):
        assert svc._looks_like_tag_list("a, b") is True
        assert svc._looks_like_tag_list("long_hair") is True
        assert svc._looks_like_tag_list("one two three four five") is True  # <= 5 words
        assert (
            svc._looks_like_tag_list("this sentence has clearly six words here")
            is False
        )

    def test_translate_mode_for_texts(self):
        assert (
            svc._translate_mode_for_texts("tags", ["anything at all here now"])
            == "tags"
        )
        # All-taglike inputs are treated as tags even when caller says caption.
        assert (
            svc._translate_mode_for_texts("caption", ["long_hair, blue_eyes"]) == "tags"
        )
        # A genuine sentence stays caption.
        assert (
            svc._translate_mode_for_texts(
                "caption", ["this is clearly a full sentence with many words"]
            )
            == "caption"
        )


# ============================================================================
# Cache lifecycle — the one rebind seam
# ============================================================================


class TestCacheLifecycle:
    def test_cache_path_and_parent_created(self, monkeypatch, tmp_path):
        nested = tmp_path / "deep" / "cache"
        monkeypatch.setattr(svc, "DEFAULT_CACHE_DIR", str(nested))
        path = svc._translation_cache_path()
        assert path.name == "dataset-translation-cache.json"
        assert path.parent == nested
        assert nested.exists()  # mkdir(parents=True, exist_ok=True)

    def test_load_lazy_init_when_file_missing(self, isolated_cache):
        assert svc._TRANSLATION_CACHE is None
        cache = svc._load_translation_cache()
        assert cache == {}
        # Global was rebound away from None (lazy init happened).
        assert svc._TRANSLATION_CACHE is cache

    def test_load_filters_and_coerces(self, isolated_cache):
        import json

        path = svc._translation_cache_path()
        path.write_text(
            json.dumps({"good": "值", "": "x", "y": "", "num": 5}),
            encoding="utf-8",
        )
        cache = svc._load_translation_cache()
        # Empty key and empty value dropped; non-str value coerced via str().
        assert cache == {"good": "值", "num": "5"}

    def test_load_corrupted_json_recovers_empty(self, isolated_cache):
        svc._translation_cache_path().write_text("{ not valid json", encoding="utf-8")
        assert svc._load_translation_cache() == {}

    def test_load_non_dict_json_recovers_empty(self, isolated_cache):
        svc._translation_cache_path().write_text("[1, 2, 3]", encoding="utf-8")
        assert svc._load_translation_cache() == {}

    def test_load_memoizes_same_object(self, isolated_cache):
        first = svc._load_translation_cache()
        # Rewrite the file underneath; memoization must ignore it.
        svc._translation_cache_path().write_text('{"a": "b"}', encoding="utf-8")
        second = svc._load_translation_cache()
        assert first is second
        assert second == {}

    def test_save_roundtrips_to_disk(self, isolated_cache):
        import json

        monkeypatch_cache = {"k": "值"}
        svc._TRANSLATION_CACHE = dict(monkeypatch_cache)
        svc._save_translation_cache()
        path = svc._translation_cache_path()
        assert path.exists()
        # ensure_ascii=False keeps the CJK char raw; compact separators.
        raw = path.read_text(encoding="utf-8")
        assert raw == '{"k":"值"}'
        assert json.loads(raw) == monkeypatch_cache
        # The .tmp scratch file is renamed away, not left behind.
        assert not path.with_suffix(".tmp").exists()

    def test_save_evicts_keeping_last_n(self, isolated_cache, monkeypatch):
        import json

        # Reduce the cap so the keep-last-N algorithm is exercised without 50k rows.
        monkeypatch.setattr(svc, "_TRANSLATION_CACHE_MAX_ITEMS", 3)
        svc._TRANSLATION_CACHE = {f"k{i}": f"v{i}" for i in range(5)}
        svc._save_translation_cache()
        # v3.4.5 fix: keep the most-recently-WRITTEN entries (last by insertion).
        assert svc._TRANSLATION_CACHE == {"k2": "v2", "k3": "v3", "k4": "v4"}
        on_disk = json.loads(svc._translation_cache_path().read_text(encoding="utf-8"))
        assert on_disk == {"k2": "v2", "k3": "v3", "k4": "v4"}


# ============================================================================
# _translate_external_with_cache — hit/miss accounting (caption path)
# ============================================================================


class TestCacheAccounting:
    def test_dedup_counts_duplicates_as_hits_then_warm(
        self, isolated_cache, monkeypatch
    ):
        calls = []

        async def fake_uncached(provider, texts, **kwargs):
            calls.append(list(texts))
            return {"translations": [f"zh:{t}" for t in texts], "provider": provider}

        monkeypatch.setattr(svc, "_translate_external_uncached", fake_uncached)

        cold = _run(
            svc._translate_external_with_cache(
                "google",
                ["a", "a", "b"],
                source_lang="en",
                target_lang="zh-CN",
                mode="caption",
            )
        )
        # Uncached is called once per UNIQUE text only.
        assert calls == [["a", "b"]]
        assert cold["translations"] == ["zh:a", "zh:a", "zh:b"]
        # DORMANT quirk: cache_hits = total - unique_missing, so the duplicate
        # "a" is counted as a "hit" (1) even though nothing was cached yet.
        assert cold["cache_hits"] == 1
        assert cold["cache_misses"] == 2

        warm = _run(
            svc._translate_external_with_cache(
                "google",
                ["a", "a", "b"],
                source_lang="en",
                target_lang="zh-CN",
                mode="caption",
            )
        )
        assert warm["cache_hits"] == 3
        assert warm["cache_misses"] == 0
        assert warm["provider"] == "google"  # untouched provider echoed back
        # Second call performed no new uncached fetch.
        assert calls == [["a", "b"]]

    def test_empty_translations_are_not_cached(self, isolated_cache, monkeypatch):
        async def fake_uncached(provider, texts, **kwargs):
            return {"translations": ["" for _ in texts], "provider": provider}

        monkeypatch.setattr(svc, "_translate_external_uncached", fake_uncached)

        _run(
            svc._translate_external_with_cache(
                "google", ["a"], source_lang="en", target_lang="zh-CN", mode="caption"
            )
        )
        # No non-empty value → nothing persisted, cache stays empty.
        assert svc._TRANSLATION_CACHE == {}
        assert not svc._translation_cache_path().exists()


# ============================================================================
# Provider clients — stubbed at the httpx transport seam (no network)
# ============================================================================


class TestProviderClients:
    def test_google_free_parses_segments_and_skips_empty(self, monkeypatch):
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(200, json=[[["长发", "long hair", None, None]]])

        _patch_httpx(monkeypatch, handler)
        out = _run(
            svc._translate_google_free(
                ["long hair", ""], source_lang="en", target_lang="zh-CN"
            )
        )
        assert out == ["长发", ""]
        # Empty text short-circuits without an HTTP call.
        assert len(seen) == 1

    def test_mymemory_extracts_text_and_raises_on_status(self, monkeypatch):
        def ok_handler(request):
            return httpx.Response(
                200,
                json={
                    "responseStatus": 200,
                    "responseData": {"translatedText": "长发"},
                },
            )

        _patch_httpx(monkeypatch, ok_handler)
        out = _run(
            svc._translate_mymemory_free(
                ["long hair"], source_lang="en", target_lang="zh-CN"
            )
        )
        assert out == ["长发"]

        def quota_handler(request):
            return httpx.Response(
                200, json={"responseStatus": 429, "responseDetails": "quota finished"}
            )

        _patch_httpx(monkeypatch, quota_handler)
        with pytest.raises(RuntimeError, match="quota finished"):
            _run(
                svc._translate_mymemory_free(
                    ["x"], source_lang="en", target_lang="zh-CN"
                )
            )

    def test_baidu_sug_takes_first_definition(self, monkeypatch):
        def handler(request):
            return httpx.Response(200, json={"data": [{"v": "长发；long hair"}]})

        _patch_httpx(monkeypatch, handler)
        out = _run(svc._translate_baidu_sug_free(["long_hair"], mode="tags"))
        # Splits on ';' and '；', keeps the first sense.
        assert out == ["长发"]

    def test_bing_keyed_requires_env_key(self, monkeypatch):
        monkeypatch.delenv("SD_IMAGE_SORTER_TRANSLATE_BING_KEY", raising=False)
        with pytest.raises(RuntimeError, match="Bing free/no-key"):
            _run(
                svc._translate_bing_keyed(["x"], source_lang="en", target_lang="zh-CN")
            )

    def test_custom_requires_env_url(self, monkeypatch):
        monkeypatch.delenv("SD_IMAGE_SORTER_TRANSLATE_CUSTOM_URL", raising=False)
        with pytest.raises(RuntimeError, match="SD_IMAGE_SORTER_TRANSLATE_CUSTOM_URL"):
            _run(
                svc._translate_custom_external(
                    ["x"], source_lang="en", target_lang="zh-CN", mode="caption"
                )
            )

    def test_custom_parses_response_and_sets_bearer_header(self, monkeypatch):
        monkeypatch.setenv(
            "SD_IMAGE_SORTER_TRANSLATE_CUSTOM_URL", "http://custom.test/translate"
        )
        monkeypatch.setenv("SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY", "secret")
        monkeypatch.delenv("SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY_HEADER", raising=False)
        captured = {}

        def handler(request):
            captured["auth"] = request.headers.get("authorization")
            return httpx.Response(200, json={"translations": ["长发", "蓝眼"]})

        _patch_httpx(monkeypatch, handler)
        out = _run(
            svc._translate_custom_external(
                ["long hair", "blue eyes"],
                source_lang="en",
                target_lang="zh-CN",
                mode="caption",
            )
        )
        assert out == ["长发", "蓝眼"]
        # Default header name "Authorization" → Bearer-prefixed key.
        assert captured["auth"] == "Bearer secret"

    def test_translators_web_arg_contract_and_zh_fallback(self, monkeypatch):
        seen = []

        def translate_text(text, **kwargs):
            seen.append(kwargs)
            # bing maps zh-CN → zh-Hans; simulate that being rejected so the
            # zh retry path fires.
            if kwargs["to_language"] == "zh-Hans":
                raise RuntimeError("blocked")
            return "翻译"

        fake = types.SimpleNamespace(translate_text=translate_text)
        monkeypatch.setitem(sys.modules, "translators", fake)

        out = _run(
            svc._translate_translators_web(
                "bing_free", ["long hair"], source_lang="en", target_lang="zh-CN"
            )
        )
        assert out == ["翻译"]
        # First attempt used the mapped zh-Hans; retry used bare "zh".
        assert seen[0]["to_language"] == "zh-Hans"
        assert seen[1]["to_language"] == "zh"
        # Static call contract carried on every attempt.
        assert seen[0]["translator"] == "bing"
        assert seen[0]["from_language"] == "en"
        assert seen[0]["if_use_preacceleration"] is False
        assert seen[0]["timeout"] == 15


# ============================================================================
# Dispatch + public entry point
# ============================================================================


class TestDispatchAndEntry:
    def test_uncached_rejects_unknown_provider(self):
        with pytest.raises(
            RuntimeError, match="Unknown external translation provider: nope"
        ):
            _run(
                svc._translate_external_uncached(
                    "nope", ["x"], source_lang="en", target_lang="zh-CN", mode="caption"
                )
            )

    def test_translate_dataset_texts_empty_short_circuits(self):
        # No texts → no VLM import, no provider call; echoes provider_mode.
        req = svc.DatasetTranslateRequest(texts=[], provider_mode="vlm")
        result = _run(svc.translate_dataset_texts(req, []))
        assert result == {"translations": [], "provider_mode": "vlm"}

    def test_external_non_auto_provider_single_attempt_502(
        self, isolated_cache, monkeypatch
    ):
        attempts = []

        async def boom(provider, texts, **kwargs):
            attempts.append(provider)
            raise RuntimeError("blocked")

        monkeypatch.setattr(svc, "_translate_external_with_cache", boom)

        payload = svc.DatasetTranslateRequest(
            texts=["this is clearly a whole caption sentence with many words"],
            provider_mode="external",
            external_provider="google",  # concrete provider → NO chain fallback
            mode="caption",
        )
        with pytest.raises(svc.HTTPException) as exc:
            _run(svc._translate_external_texts(payload, payload.texts))
        assert exc.value.status_code == 502
        detail = exc.value.detail
        assert detail["error_type"] == "external_provider_error"
        assert detail["provider"] == "google"
        assert "google: blocked" in detail["error"]
        # A concrete (non-auto) provider breaks after the first failure.
        assert attempts == ["google"]

    def test_external_auto_maps_to_global_chain(self, isolated_cache, monkeypatch):
        first_provider = []

        async def fake_smart(provider, texts, **kwargs):
            first_provider.append(provider)
            return {
                "translations": [f"zh:{t}" for t in texts],
                "provider": provider,
                "cache_hits": 0,
                "cache_misses": len(texts),
                "unique_terms": len(texts),
            }

        monkeypatch.setattr(svc, "_translate_tag_texts_smart", fake_smart)

        payload = svc.DatasetTranslateRequest(
            texts=["long_hair, blue_eyes"],
            provider_mode="external",
            external_provider="auto",  # → _GLOBAL_FREE_PROVIDER_CHAIN
            mode="tags",
        )
        result = _run(svc._translate_external_texts(payload, payload.texts))
        assert first_provider[0] == "google_free"  # head of the global chain
        assert result["provider_mode"] == "external"
        assert result["provider"] == "google_free"
