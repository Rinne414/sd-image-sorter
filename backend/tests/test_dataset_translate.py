from __future__ import annotations

from vlm_providers import VLMConfig, VLMResult


class DummyTextProvider:
    def __init__(self, result: VLMResult):
        self.result = result

    async def generate_text(self, *args, **kwargs):
        return self.result


def test_dataset_translate_external_free_success(test_client, monkeypatch):
    import routers.dataset as dataset_router

    async def fake_translate(payload, texts):
        return {
            "translations": ["长发，蓝眼睛"],
            "provider_mode": "external",
            "provider": payload.external_provider,
        }

    monkeypatch.setattr(dataset_router, "_translate_external_texts", fake_translate)

    response = test_client.post("/api/dataset/translate", json={
        "texts": ["long_hair, blue_eyes"],
        "provider_mode": "external",
        "external_provider": "google",
    })

    assert response.status_code == 200
    body = response.json()
    assert body["translations"] == ["长发，蓝眼睛"]
    assert body["provider"] == "google"


def test_dataset_translate_external_failure_is_clear(test_client, monkeypatch):
    import routers.dataset as dataset_router
    from fastapi import HTTPException

    async def fake_translate(payload, texts):
        raise HTTPException(status_code=502, detail={
            "error": "google: blocked; mymemory: quota finished",
            "error_type": "external_provider_error",
            "provider": "auto",
        })

    monkeypatch.setattr(dataset_router, "_translate_external_texts", fake_translate)

    response = test_client.post("/api/dataset/translate", json={
        "texts": ["long_hair, blue_eyes"],
        "provider_mode": "external",
        "external_provider": "auto",
    })

    assert response.status_code == 502
    assert "external_provider_error" in response.text


def test_dataset_translate_requires_vlm_settings(test_client, monkeypatch):
    import routers.vlm as vlm_router

    monkeypatch.setattr(vlm_router, "_build_config", lambda overrides=None: VLMConfig(provider="openai_compat"))

    response = test_client.post("/api/dataset/translate", json={
        "texts": ["long_hair, blue_eyes"],
        "provider_mode": "vlm",
    })

    assert response.status_code == 400
    assert "No VLM endpoint" in response.text


def test_dataset_translate_vlm_success(test_client, monkeypatch):
    import routers.vlm as vlm_router
    import vlm_providers

    config = VLMConfig(provider="openai_compat", endpoint="http://example.test/v1", model="dummy")
    monkeypatch.setattr(vlm_router, "_build_config", lambda overrides=None: config)
    monkeypatch.setattr(
        vlm_providers,
        "get_provider",
        lambda cfg: DummyTextProvider(VLMResult(caption='["长发，蓝眼睛"]', tokens_used=12, model="dummy")),
    )

    response = test_client.post("/api/dataset/translate", json={
        "texts": ["long_hair, blue_eyes"],
        "mode": "tags",
        "target_lang": "zh-CN",
        "provider_mode": "vlm",
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["translations"] == ["长发，蓝眼睛"]
    assert body["tokens_used"] == 12


def test_dataset_translate_vlm_provider_error(test_client, monkeypatch):
    import routers.vlm as vlm_router
    import vlm_providers

    config = VLMConfig(provider="openai_compat", endpoint="http://example.test/v1", model="dummy")
    monkeypatch.setattr(vlm_router, "_build_config", lambda overrides=None: config)
    monkeypatch.setattr(
        vlm_providers,
        "get_provider",
        lambda cfg: DummyTextProvider(VLMResult(error="bad gateway", error_type="network", model="dummy")),
    )

    response = test_client.post("/api/dataset/translate", json={
        "texts": ["caption"],
        "provider_mode": "vlm",
    })

    assert response.status_code == 502
    assert "bad gateway" in response.text


def test_dataset_translate_vlm_empty_translation_is_error(test_client, monkeypatch):
    import routers.vlm as vlm_router
    import vlm_providers

    config = VLMConfig(provider="openai_compat", endpoint="http://example.test/v1", model="dummy")
    monkeypatch.setattr(vlm_router, "_build_config", lambda overrides=None: config)
    monkeypatch.setattr(
        vlm_providers,
        "get_provider",
        lambda cfg: DummyTextProvider(VLMResult(caption='[""]', tokens_used=1, model="dummy")),
    )

    response = test_client.post("/api/dataset/translate", json={
        "texts": ["caption"],
        "provider_mode": "vlm",
    })

    assert response.status_code == 502
    assert "empty_response" in response.text


def test_external_translation_dedupes_tags_and_uses_cache(monkeypatch, tmp_path):
    import asyncio
    import routers.dataset as dataset_router

    calls = []

    async def fake_uncached(provider, texts, **kwargs):
        calls.append(list(texts))
        return {
            "translations": [f"zh:{text}" for text in texts],
            "provider": provider,
        }

    monkeypatch.setattr(dataset_router, "DEFAULT_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(dataset_router, "_TRANSLATION_CACHE", None)
    monkeypatch.setattr(dataset_router, "_translate_external_uncached", fake_uncached)

    payload = dataset_router.DatasetTranslateRequest(
        texts=["long hair, blue eyes", "blue eyes, smile, long hair"],
        provider_mode="external",
        external_provider="google",
        mode="tags",
    )

    first = asyncio.run(dataset_router._translate_external_texts(payload, payload.texts))
    second = asyncio.run(dataset_router._translate_external_texts(payload, payload.texts))

    assert calls == [["long hair", "blue eyes", "smile"]]
    assert first["unique_terms"] == 3
    assert first["translations"] == [
        "zh:long hair, zh:blue eyes",
        "zh:blue eyes, zh:smile, zh:long hair",
    ]
    assert second["cache_hits"] == 3
    assert second["cache_misses"] == 0


def test_external_auto_cn_uses_mainland_chain(monkeypatch, tmp_path):
    import asyncio
    import routers.dataset as dataset_router

    calls = []

    async def fake_uncached(provider, texts, **kwargs):
        calls.append(provider)
        if provider != "baidu_free":
            raise RuntimeError(f"{provider} should not be first")
        return {
            "translations": [f"zh:{text}" for text in texts],
            "provider": "baidu",
        }

    monkeypatch.setattr(dataset_router, "DEFAULT_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(dataset_router, "_TRANSLATION_CACHE", None)
    monkeypatch.setattr(dataset_router, "_translate_external_uncached", fake_uncached)

    payload = dataset_router.DatasetTranslateRequest(
        texts=["long hair, blue eyes"],
        provider_mode="external",
        external_provider="auto_cn",
        mode="tags",
    )

    result = asyncio.run(dataset_router._translate_external_texts(payload, payload.texts))

    assert calls == ["baidu_free"]
    assert result["provider"] == "baidu"
    assert result["translations"] == ["zh:long hair, zh:blue eyes"]


def test_external_auto_cn_falls_back_on_empty_provider(monkeypatch, tmp_path):
    import asyncio
    import routers.dataset as dataset_router

    calls = []

    async def fake_uncached(provider, texts, **kwargs):
        calls.append(provider)
        if provider == "baidu_free":
            return {"translations": ["" for _ in texts], "provider": provider}
        return {
            "translations": [f"zh:{text}" for text in texts],
            "provider": provider,
        }

    monkeypatch.setattr(dataset_router, "DEFAULT_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(dataset_router, "_TRANSLATION_CACHE", None)
    monkeypatch.setattr(dataset_router, "_translate_external_uncached", fake_uncached)

    payload = dataset_router.DatasetTranslateRequest(
        texts=["long hair, blue eyes"],
        provider_mode="external",
        external_provider="auto_cn",
        mode="tags",
    )

    result = asyncio.run(dataset_router._translate_external_texts(payload, payload.texts))

    assert calls[:2] == ["baidu_free", "alibaba_free"]
    assert result["provider"] == "alibaba_free"
    assert result["translations"] == ["zh:long hair, zh:blue eyes"]


def test_physton_no_key_free_providers_are_supported():
    import routers.dataset as dataset_router

    physton_keys = {
        "bing_free",
        "google_free",
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
        "mymemory_free",
    }
    supported = (
        set(dataset_router._DIRECT_TRANSLATION_PROVIDER_ALIASES)
        | set(dataset_router._TRANSLATORS_PROVIDER_ALIASES)
    )

    assert physton_keys <= supported
    assert "alibaba_free" in dataset_router._GLOBAL_FREE_PROVIDER_CHAIN
    assert "alibaba_free" in dataset_router._MAINLAND_FREE_PROVIDER_CHAIN


def test_translators_provider_alias_uses_optional_engine(monkeypatch):
    import asyncio
    import sys
    import types
    import routers.dataset as dataset_router

    fake = types.SimpleNamespace()
    seen = {}

    def translate_text(text, **kwargs):
        seen["text"] = text
        seen["kwargs"] = kwargs
        return "翻译"

    fake.translate_text = translate_text
    monkeypatch.setitem(sys.modules, "translators", fake)

    result = asyncio.run(dataset_router._translate_translators_web(
        "qqTranSmart_free",
        ["long hair"],
        source_lang="en",
        target_lang="zh-CN",
    ))

    assert result == ["翻译"]
    assert seen["kwargs"]["translator"] == "qqTranSmart"
