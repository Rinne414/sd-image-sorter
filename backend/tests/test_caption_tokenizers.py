"""Exact caption token counts with the tokenizers Anima uses (Qwen3-0.6B, T5 v1.1 XXL).

The real tokenizer files are 11 MB and 2 MB and are downloaded on first use, so
these tests build two tiny tokenizers of the same kinds and point the service at
them; the real files are only checked when they happen to be on this machine.
"""

from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path

import pytest

tokenizers = pytest.importorskip("tokenizers")
from tokenizers import Tokenizer, models, pre_tokenizers, processors  # noqa: E402

import pinned_download  # noqa: E402
from services import caption_tokenizer_service as svc  # noqa: E402


def _word_tokenizer(
    words: list[str], *, eos: bool, always_prepend_space: bool = False
) -> bytes:
    vocab = {"[UNK]": 0, "</s>": 1}
    for word in words:
        vocab[word] = len(vocab)
    tok = Tokenizer(models.WordLevel(vocab, unk_token="[UNK]"))
    tok.pre_tokenizer = pre_tokenizers.Whitespace()
    if eos:
        tok.post_processor = processors.TemplateProcessing(
            single="$A </s>", special_tokens=[("</s>", 1)]
        )
    return tok.to_str().encode("utf-8")


QWEN_BYTES = _word_tokenizer(["1girl", "solo", "smile", "blue", "eyes"], eos=False)
T5_BYTES = _word_tokenizer(["1girl", "solo", "smile", "blue", "eyes"], eos=True)


def _pinned(data: bytes, name: str) -> pinned_download.PinnedFile:
    return pinned_download.PinnedFile(
        repo="test/" + name,
        revision="0" * 40,
        remote_path="tokenizer.json",
        sha256=hashlib.sha256(data).hexdigest(),
        size_bytes=len(data),
    )


@pytest.fixture
def specs(tmp_path, monkeypatch):
    """The two Anima tokenizers, replaced by tiny stand-ins in a temp folder."""
    monkeypatch.setattr(svc, "models_root", lambda: tmp_path / "tokenizers")
    fake = {
        "qwen3_0_6b": svc.TokenizerSpec(
            "qwen3_0_6b",
            "Qwen3-0.6B",
            _pinned(QWEN_BYTES, "qwen"),
            add_special_tokens=False,
            collapse_spaces=False,
        ),
        "t5_v1_1_xxl": svc.TokenizerSpec(
            "t5_v1_1_xxl",
            "T5 v1.1 XXL",
            _pinned(T5_BYTES, "t5"),
            add_special_tokens=True,
            collapse_spaces=True,
        ),
    }
    monkeypatch.setattr(svc, "SPECS", fake)
    monkeypatch.setattr(svc, "_loaded", {})
    return fake


def _install(specs, which=("qwen3_0_6b", "t5_v1_1_xxl")):
    data = {"qwen3_0_6b": QWEN_BYTES, "t5_v1_1_xxl": T5_BYTES}
    for key in which:
        path = svc.tokenizer_path(specs[key])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data[key])


def test_status_says_what_is_missing_and_how_big_the_download_is(specs):
    status = svc.get_status()

    assert status["available"] is False
    assert status["tokenizers_package"] is True
    assert [f["id"] for f in status["files"]] == ["qwen3_0_6b", "t5_v1_1_xxl"]
    assert not any(f["present"] for f in status["files"])
    assert status["download_bytes"] == len(QWEN_BYTES) + len(T5_BYTES)


def test_anima_counts_qwen_without_special_tokens_and_t5_with_one_end_token(specs):
    _install(specs)

    result = svc.count_tokens("anima", ["1girl, solo, blue eyes", "", "smile"])

    assert result["available"] is True
    assert [m["id"] for m in result["metrics"]] == ["qwen3_0_6b", "t5_v1_1_xxl"]
    # whitespace tokenizer: the commas are tokens too
    assert result["counts"] == [
        {"qwen3_0_6b": 6, "t5_v1_1_xxl": 7},
        {"qwen3_0_6b": 0, "t5_v1_1_xxl": 1},
        {"qwen3_0_6b": 1, "t5_v1_1_xxl": 2},
    ]


def test_t5_counts_collapse_runs_of_whitespace_but_qwen_sees_the_text_as_it_is(specs):
    # Measured against SentencePiece: the T5 fast tokenizer needs single spaces to
    # count like the real encoder; Qwen reads the text unchanged.
    text = "  solo \n\n  smile　 "

    assert svc.text_for(specs["qwen3_0_6b"], text) == text
    assert svc.text_for(specs["t5_v1_1_xxl"], text) == "solo smile"
    _install(specs)
    counted = svc.count_tokens("anima", [text, "solo smile"])["counts"]
    assert counted[0]["t5_v1_1_xxl"] == counted[1]["t5_v1_1_xxl"] == 3


def test_counts_say_unavailable_instead_of_guessing_when_a_file_is_missing(specs):
    _install(specs, which=("qwen3_0_6b",))

    result = svc.count_tokens("anima", ["solo"])

    assert result["available"] is False
    assert result["counts"] == []
    assert result["missing"] == ["t5_v1_1_xxl"]


def test_a_changed_file_is_not_trusted(specs):
    _install(specs)
    svc.tokenizer_path(specs["t5_v1_1_xxl"]).write_bytes(T5_BYTES + b" ")

    result = svc.count_tokens("anima", ["solo"])

    assert result["available"] is False
    assert result["missing"] == ["t5_v1_1_xxl"]
    assert svc.get_status()["files"][1]["present"] is False


def test_unknown_profile_is_refused(specs):
    with pytest.raises(ValueError):
        svc.count_tokens("sdxl", ["solo"])


def test_prepare_downloads_pinned_files_once_and_verifies_them(specs, monkeypatch):
    calls = []
    payload = {"test/qwen": QWEN_BYTES, "test/t5": T5_BYTES}

    def fake_download(url, dest, *, timeout=0):
        repo = next(r for r in payload if f"/{r}/" in url)
        calls.append(url)
        Path(dest).write_bytes(payload[repo])
        return Path(dest)

    monkeypatch.setattr(svc, "_download_file", lambda: fake_download)
    monkeypatch.setattr(
        "model_download_sources.get_hf_endpoint_order",
        lambda model_name="": ["https://hf.test"],
    )
    monkeypatch.setattr(
        pinned_download,
        "get_hf_endpoint_order",
        lambda model_name="": ["https://hf.test"],
    )

    svc.prepare_blocking()

    assert len(calls) == 2 and all(c.startswith("https://hf.test/test/") for c in calls)
    assert svc.get_status()["available"] is True
    svc.prepare_blocking()  # a verified copy is never downloaded again
    assert len(calls) == 2


def test_prepare_refuses_a_download_with_the_wrong_checksum(specs, monkeypatch):
    def bad_download(url, dest, *, timeout=0):
        Path(dest).write_bytes(b"something else")
        return Path(dest)

    monkeypatch.setattr(svc, "_download_file", lambda: bad_download)
    monkeypatch.setattr(
        pinned_download,
        "get_hf_endpoint_order",
        lambda model_name="": ["https://hf.test"],
    )

    with pytest.raises(RuntimeError, match="checksum"):
        svc.prepare_blocking()
    assert svc.get_status()["available"] is False
    assert not list((svc.models_root()).rglob("tokenizer.json"))


def test_prepare_installs_the_tokenizers_package_first_when_it_is_missing(
    specs, monkeypatch
):
    order = []
    monkeypatch.setattr(svc, "tokenizers_installed", lambda: bool(order))
    monkeypatch.setattr(svc, "_install_package", lambda: order.append("package"))
    monkeypatch.setattr(
        svc,
        "_download_file",
        lambda: (
            lambda url, dest, *, timeout=0: (
                order.append("file"),
                Path(dest).write_bytes(QWEN_BYTES if "qwen" in url else T5_BYTES),
                Path(dest),
            )[-1]
        ),
    )
    monkeypatch.setattr(
        pinned_download,
        "get_hf_endpoint_order",
        lambda model_name="": ["https://hf.test"],
    )

    svc.prepare_blocking()

    assert order[0] == "package" and order.count("file") == 2


def test_endpoints_report_status_start_a_download_and_count(
    test_client, specs, monkeypatch
):
    status = test_client.get("/api/dataset/caption-tokens/status").json()
    assert status["available"] is False and status["preparing"] is False

    miss = test_client.post(
        "/api/dataset/caption-tokens", json={"profile": "anima", "texts": ["solo"]}
    )
    assert miss.status_code == 200 and miss.json()["available"] is False

    payload = {"test/qwen": QWEN_BYTES, "test/t5": T5_BYTES}

    def fake_download(url, dest, *, timeout=0):
        Path(dest).write_bytes(payload[next(r for r in payload if f"/{r}/" in url)])
        return Path(dest)

    monkeypatch.setattr(svc, "_download_file", lambda: fake_download)
    monkeypatch.setattr(
        pinned_download,
        "get_hf_endpoint_order",
        lambda model_name="": ["https://hf.test"],
    )

    started = test_client.post("/api/dataset/caption-tokens/prepare").json()
    assert started["status"] in {"started", "ready"}
    for _ in range(100):
        if not test_client.get("/api/dataset/caption-tokens/status").json()[
            "preparing"
        ]:
            break
        time.sleep(0.05)
    final = test_client.get("/api/dataset/caption-tokens/status").json()
    assert final["available"] is True and final["error"] is None

    counted = test_client.post(
        "/api/dataset/caption-tokens",
        json={"profile": "anima", "texts": ["1girl, solo"]},
    ).json()
    assert counted["available"] is True
    assert counted["counts"] == [{"qwen3_0_6b": 3, "t5_v1_1_xxl": 4}]

    assert (
        test_client.post(
            "/api/dataset/caption-tokens", json={"profile": "nope", "texts": ["x"]}
        ).status_code
        == 400
    )


REAL_DIR = os.environ.get("SD_IMAGE_SORTER_REAL_TOKENIZER_DIR", "")


@pytest.mark.skipif(
    not REAL_DIR or not (Path(REAL_DIR) / "qwen3_0_6b" / "tokenizer.json").is_file(),
    reason="set SD_IMAGE_SORTER_REAL_TOKENIZER_DIR to a folder holding the downloaded files",
)
def test_the_real_tokenizers_agree_with_numbers_measured_elsewhere(monkeypatch):
    monkeypatch.setattr(svc, "models_root", lambda: Path(REAL_DIR))
    result = svc.count_tokens(
        "anima",
        [
            "1girl, solo, long hair, blue eyes, looking at viewer, smile, white dress, outdoors, cherry blossoms",
            "  extra   spaces , and\nnewlines ",
        ],
    )

    assert result["available"] is True
    assert result["counts"][0]["t5_v1_1_xxl"] == 26
