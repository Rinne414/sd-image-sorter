"""
LSNet-style Artist Identification for SD Image Sorter.

Identifies the artist/style of an image using a classification model.
Based on the LSNet concept from: https://github.com/spawner1145/comfyui-lsnet

Features:
- Identifies artist/style from image
- Returns "undefined" for predictions below threshold
- Supports multiple model sources (HuggingFace, ModelScope, local)

Model Sources:
- HuggingFace: Search for "artist-classification" or "style-classification"
- ModelScope: https://modelscope.cn/models (search for artist/style models)
- Local: Provide path to ONNX or PyTorch model

Usage:
    from artist_identifier import ArtistIdentifier

    identifier = ArtistIdentifier(threshold=0.03)
    result = identifier.identify("path/to/image.png")
    # Returns: {"artist": "some_artist", "confidence": 0.85, "top_predictions": [...]}
"""
import logging
import os
import csv
import sys
import threading
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Dict, List, Optional, Tuple, Any

import numpy as np
from PIL import Image
from config import (
    ARTIST_MODEL_SOURCE_DEFAULT,
    ARTIST_HF_MODEL_ID,
    ARTIST_MODELSCOPE_MODEL_ID,
    ARTIST_LSNET_CODE_PATH,
    ARTIST_KALOSCOPE_CHECKPOINT,
    ARTIST_KALOSCOPE_CLASS_MAPPING,
)

logger = logging.getLogger("sd-image-sorter.artist")


# Lazy-loaded model
_model = None
_processor = None
_model_lock = threading.Lock()
ARTIST_THRESHOLD_DEFAULT = 0.03
_model_source = None
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"
ARTIST_LSNET_RUNTIME_REVISION = "416d945e65b81ced93f1e762349d790ca92106b1"
ARTIST_LSNET_RUNTIME_ZIP_URL = (
    f"https://github.com/spawner1145/comfyui-lsnet/archive/{ARTIST_LSNET_RUNTIME_REVISION}.zip"
)
_MAX_ARTIST_RUNTIME_ZIP_ENTRIES = 1024
_MAX_ARTIST_RUNTIME_UNCOMPRESSED_BYTES = 256 * 1024 * 1024


def _is_kaloscope_model_id(model_id: Optional[str]) -> bool:
    normalized = str(model_id or "").strip().lower()
    return normalized == "heathcliff01/kaloscope2.0"


def _normalize_state_dict_keys(state_dict):
    normalized = {}
    for key, value in state_dict.items():
        normalized[key[7:] if key.startswith("module.") else key] = value
    return normalized


def _resolve_lsnet_runtime_path() -> Optional[str]:
    candidates = []
    if ARTIST_LSNET_CODE_PATH:
        candidates.append(ARTIST_LSNET_CODE_PATH)

    project_root = Path(__file__).resolve().parent.parent
    candidates.extend([
        project_root / "models" / "artist" / "comfyui-lsnet",
        project_root / "models" / "artist" / "lsnet-test",
        project_root / "third_party" / "comfyui-lsnet",
        project_root / "third_party" / "lsnet-test",
    ])

    for candidate in candidates:
        candidate_path = Path(candidate).expanduser().resolve()
        if candidate_path.exists() and ((candidate_path / "model").exists() or (candidate_path / "lsnet_model").exists()):
            return str(candidate_path)
    return None


def _get_artist_model_root() -> Path:
    project_root = Path(__file__).resolve().parent.parent
    target = project_root / "models" / "artist"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _candidate_hf_endpoints() -> List[str]:
    candidates: List[str] = []
    configured = str(os.environ.get("HF_ENDPOINT", "") or "").strip().rstrip("/")
    if configured:
        candidates.append(configured)
    candidates.append("")
    candidates.append(HF_MIRROR_ENDPOINT)

    deduped: List[str] = []
    seen = set()
    for endpoint in candidates:
        key = endpoint or "__default__"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(endpoint)
    return deduped


def _hf_download_with_fallback(repo_id: str, filename: str, local_dir: str) -> str:
    from huggingface_hub import hf_hub_download

    last_error: Optional[Exception] = None
    for endpoint in _candidate_hf_endpoints():
        try:
            kwargs = {
                "repo_id": repo_id,
                "filename": filename,
                "local_dir": local_dir,
            }
            if endpoint:
                kwargs["endpoint"] = endpoint
                logger.info("Downloading %s from %s via %s", filename, repo_id, endpoint)
            else:
                logger.info("Downloading %s from %s via HuggingFace", filename, repo_id)
            return hf_hub_download(**kwargs)
        except Exception as exc:
            last_error = exc
            logger.warning("Download failed for %s via %s: %s", filename, endpoint or "huggingface", exc)

    if last_error is None:
        raise RuntimeError(f"Failed to download {filename} from {repo_id}")
    raise last_error


def _download_and_extract_github_zip(zip_url: str, target_dir: Path) -> Path:
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="kaloscope-runtime-") as tmp_dir:
        tmp_dir_path = Path(tmp_dir)
        zip_path = tmp_dir_path / "repo.zip"
        urllib.request.urlretrieve(zip_url, zip_path)
        extract_dir = tmp_dir_path / "extract"
        extract_dir.mkdir(parents=True, exist_ok=True)
        extract_root = extract_dir.resolve()
        total_uncompressed_bytes = 0
        with zipfile.ZipFile(zip_path, "r") as archive:
            members = archive.infolist()
            if len(members) > _MAX_ARTIST_RUNTIME_ZIP_ENTRIES:
                raise ValueError("Zip contains too many entries to extract safely")
            for member in members:
                normalized_name = str(member.filename or "").replace("\\", "/").strip()
                relative_name = PurePosixPath(normalized_name)
                if (
                    not normalized_name
                    or relative_name.is_absolute()
                    or normalized_name[:2].endswith(":")
                    or ".." in relative_name.parts
                ):
                    raise ValueError(f"Zip contains path traversal: {member.filename}")
                member_path = (extract_root / relative_name).resolve()
                try:
                    member_path.relative_to(extract_root)
                except ValueError as exc:
                    raise ValueError(f"Zip contains path traversal: {member.filename}") from exc
                if not member.is_dir():
                    total_uncompressed_bytes += member.file_size
                    if total_uncompressed_bytes > _MAX_ARTIST_RUNTIME_UNCOMPRESSED_BYTES:
                        raise ValueError("Zip uncompressed size exceeds the safe extraction limit")
            for member in members:
                normalized_name = str(member.filename or "").replace("\\", "/").strip()
                member_path = (extract_root / PurePosixPath(normalized_name)).resolve()
                if member.is_dir():
                    member_path.mkdir(parents=True, exist_ok=True)
                    continue
                member_path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member, "r") as src, member_path.open("wb") as dst:
                    shutil.copyfileobj(src, dst)

        extracted_roots = [path for path in extract_dir.iterdir() if path.is_dir()]
        if len(extracted_roots) != 1:
            raise ValueError("Zip must contain exactly one runtime root directory")
        if target_dir.exists():
            shutil.rmtree(target_dir)
        shutil.move(str(extracted_roots[0]), str(target_dir))
    return target_dir


def _ensure_comfyui_lsnet_runtime() -> str:
    artist_root = _get_artist_model_root()
    target_dir = artist_root / "comfyui-lsnet-runtime"
    if (target_dir / "lsnet_model").exists():
        return str(target_dir)

    logger.info("Downloading comfyui-lsnet runtime into %s", target_dir)
    _download_and_extract_github_zip(ARTIST_LSNET_RUNTIME_ZIP_URL, target_dir)
    return str(target_dir)


def _ensure_kaloscope_hf_files() -> Tuple[str, str]:
    local_dir = _get_artist_model_root() / "kaloscope2.0"
    local_checkpoint = local_dir / ARTIST_KALOSCOPE_CHECKPOINT
    local_mapping = local_dir / ARTIST_KALOSCOPE_CLASS_MAPPING

    if local_checkpoint.exists() and local_mapping.exists():
        return str(local_checkpoint.resolve()), str(local_mapping.resolve())

    checkpoint_path = _hf_download_with_fallback(
        ARTIST_HF_MODEL_ID,
        ARTIST_KALOSCOPE_CHECKPOINT,
        str(local_dir),
    )
    class_mapping_path = _hf_download_with_fallback(
        ARTIST_HF_MODEL_ID,
        ARTIST_KALOSCOPE_CLASS_MAPPING,
        str(local_dir),
    )
    return checkpoint_path, class_mapping_path


def _ensure_kaloscope_modelscope_files() -> Tuple[str, str]:
    from modelscope import snapshot_download  # type: ignore

    if not ARTIST_MODELSCOPE_MODEL_ID:
        raise RuntimeError(
            "No compatible ModelScope artist model is configured. "
            "Use HuggingFace/hf-mirror or set SD_IMAGE_SORTER_ARTIST_MODELSCOPE_MODEL."
        )

    cache_dir = _get_artist_model_root() / "kaloscope2.0-modelscope"
    model_dir = snapshot_download(ARTIST_MODELSCOPE_MODEL_ID, cache_dir=str(cache_dir))

    checkpoint_path = os.path.join(model_dir, ARTIST_KALOSCOPE_CHECKPOINT)
    class_mapping_path = os.path.join(model_dir, ARTIST_KALOSCOPE_CLASS_MAPPING)
    if not os.path.exists(checkpoint_path) or not os.path.exists(class_mapping_path):
        raise RuntimeError("Configured ModelScope artist model does not match the expected Kaloscope file layout.")
    return checkpoint_path, class_mapping_path


def _has_lsnet_runtime() -> bool:
    runtime_path = _resolve_lsnet_runtime_path()
    if not runtime_path:
        try:
            runtime_path = _ensure_comfyui_lsnet_runtime()
        except Exception:
            return False

    if runtime_path not in sys.path:
        sys.path.insert(0, runtime_path)

    try:
        import timm  # noqa: F401
        try:
            from lsnet_model import lsnet_artist  # noqa: F401
        except ImportError:
            from model import lsnet_artist  # noqa: F401
        return True
    except ImportError:
        return False


def prepare_artist_assets(preferred_source: str = "auto") -> Dict[str, str]:
    """Ensure runtime + artist files exist, trying mirrors/fallbacks when needed."""
    runtime_path = _resolve_lsnet_runtime_path() or _ensure_comfyui_lsnet_runtime()
    errors: List[str] = []

    source_order: List[str]
    preferred = str(preferred_source or "auto").strip().lower()
    if preferred == "modelscope":
        source_order = ["modelscope", "huggingface"]
    elif preferred == "huggingface":
        source_order = ["huggingface", "modelscope"]
    else:
        source_order = ["huggingface", "modelscope"]

    for source in source_order:
        try:
            if source == "modelscope":
                checkpoint_path, class_mapping_path = _ensure_kaloscope_modelscope_files()
            else:
                checkpoint_path, class_mapping_path = _ensure_kaloscope_hf_files()
            return {
                "runtime_path": runtime_path,
                "checkpoint_path": checkpoint_path,
                "class_mapping_path": class_mapping_path,
                "source": source,
            }
        except Exception as exc:
            errors.append(f"{source}: {exc}")
            logger.warning("Artist asset preparation failed via %s: %s", source, exc)

    raise RuntimeError("Artist assets could not be prepared. " + " | ".join(errors))

# Default artist list (common anime artists)
# This is a sample list - actual model will have its own labels
DEFAULT_ARTISTS = [
    "undefined",  # Index 0 = unknown/undefined
    # Popular anime/manga artists
    "makoto_shinkai",
    "hayao_miyazaki",
    "yoshitaka_amano",
    "takeshi_obata",
    "eiichiro_oda",
    "akira_toriyama",
    "masashi_kishimoto",
    "tite_kubo",
    "clare",
    "wlop",
    "ilya_kuvshinov",
    "rossdraws",
    "artgerm",
    "sakimichan",
    "krenz_cushart",
    "guweiz",
    "muchuan",
    "ke-ta",
    "nardack",
    "hiten",
    "ask",
    "redjuice",
    "houtengeki",
    "shirow_masamune",
    "karako",
    "fuzichoco",
    "hifumi_takobo",
    "torino_aqua",
    "mika_pikazo",
    "ogino_tsukasa",
    "namie",
    "tofudev",
    "sho_lwl",
    "tianliang",
    "don_malo",
    "dandon_fuga",
    "sho_(sho_lwl)",
    "ruslik_club",
    "zeno_(nobu-sama)",
    "zaki_zaki_zaki",
    "yanyanyo",
    "van_ogre",
    "usazaki_shiro",
    "unagi17171717",
    "tyanten",
    "tsuki_(tsuki0000)",
    "torippu",
    "tinkerbreeze",
    "suzu_(suzushiro1337)",
    "stabilo",
    "sime",
    "sho_yamamoto",
    "shen_yuan",
    "serafleur",
    "seishiki",
    "seishin_500000",
    "sciamano240",
    "sakiyamama",
    "rurudo",
    "rose_(npmr3)",
    "ririko_himeno",
    "ricard_sarafyan",
    "redmiya",
    "r.e.i",
    "quasarcake",
    "primelamp",
    "potg_(pote_guma)",
    "pozai",
    "poplin_p",
    "pikacha",
    "peco_(pecoooo)",
    "pdoko",
    "paint002",
    "owl_(owl_tow)",
    "owlyo",
    "ousawa",
    "ohisashiburi",
    "noripachi",
    "nozmo",
    "norio_matsumoto",
    "norikonya",
    "ninstagram",
    "niek",
    "nekomataya",
    "nardack",
    "nara",
    "nana_yuuki",
    "nacho",
    "myketchum",
    "mwl4g",
    "mtd",
    "mosu",
    "moriyama_kirara",
    "morikuramori",
    "monet",
    "mogura",
    "mito",
    "minami_(minami_nah)",
    "mika_pikazo",
    "mery",
    "menine",
    "medakashi",
    "maxgillo",
    "ma-kurou",
    "lylian",
    "lowah",
    "lulukhu",
    "lofi_(loficat)",
    "lionfish",
    "life_or_death",
    "lie_hu",
    "lax",
    "lastwatchernu",
    "laranon",
    "kuro_(kuro_kuro_kuro)",
    "koyori",
    "kotori_kot",
    "konofoot",
    "kongou",
    "kira_(kirakirakira)",
    "kim_tae_hyung",
    "kawacy",
    "kazu_(kazuv_v)",
    "k_arayama",
    "jui",
    "jun_(juunjun)",
    "jimmy",
    "jim-_heng",
    "jii",
    "jessy",
    "jim",
    "iwyao",
    "itzel",
    "isaki",
    "ino",
    "inhoso",
    "incase",
    "idle_lee",
    "hutaba",
    "hyouju_neru",
    "hyo",
    "hunter_(hunter-xx)",
    "houtengeki",
    "hosi_(hosi_xx)",
    "horocca",
    "homare",
    "hiroshino",
    "hijikata",
    "hibiki_(hibiki_x)",
    "hezzi",
    "herio",
    "helio",
    "hahaha",
    "guguru",
    "gravy",
    "grey",
    "greeeen",
    "godratt",
    "gl_nescafe",
    "gigidigi",
    "gerardo",
    "gegera",
    "gaming",
    "gammong",
    "futaba_(kiyoshirou)",
    "from_nemu",
    "frillo",
    "free_planet",
    "fou_kusa",
    "flower_(flower_55)",
    "fleet",
    "flou",
    "flashback",
    "fkey",
    "five_(quinox)",
    "first",
    "firis",
    "featuring",
    "f4t4li4",
    "expressive_yum",
    "excellenty",
    "evo",
    "etuzan_jakusui",
    "eterii",
    "esawees",
    "elvenmonk",
    "eluxir",
    "elvenmonk",
    "elroir",
    "elhy",
    "ekria",
    "eight",
    "efi",
    "eddie",
    "ears",
    "dynamitemochi",
    "duren",
    "dujae",
    "dsmir9",
    "drake_(dsdr)",
    "doxy",
    "donkichi",
    "dokutan",
    "dododo",
    "doctor_wolfff",
    "dmy-(dmy)",
    "dmlsl",
    "dkk",
    "divian",
    "dittsu",
    "dimsd",
    "digako",
    "dickable",
    "despairo",
    "der_mon",
    "dendrobatid",
    "demento",
    "deloid",
    "deghi",
    "ddeoy",
    "db",
    "dazzy",
    "dazai",
    "data",
    "dairoku",
    "dadada",
    "cufimofu",
    "ctsl",
    "crow",
    "crotalus",
    "crimson",
    "crim",
    "creamsoda",
    "crab",
    "coupe",
    "cooler",
    "cookie",
    "conoco",
    "cnj",
    "clock",
    "claire",
    "cist",
    "chocobox",
    "chisato",
    "ching",
    "chigusa",
    "cherry_blossom",
    "chemi",
    "cheese",
    "chawoo",
    "cet",
    "ceri",
    "cccp",
    "cct",
    "carrot",
    "canihazarts",
    "calico",
    "caibao",
    "caburi",
    "bun",
    "bui",
    "btc",
    "bt",
    "bs",
    "brokoro",
    "bright",
    "bride",
    "brave",
    "box",
    "bow",
    "boos",
    "bono",
    "bomber",
    "boku",
    "boiled",
    "bluedragon",
    "blue_(blue00111)",
    "blow",
    "bloody",
    "blits",
    "blee",
    "bleach",
    "blackfox",
    "bit",
    "bird",
    "bin",
    "big",
    "bie",
    "bety",
    "best",
    "bep",
    "bely",
    "beluga",
    "bell",
    "bekkankou",
    "beeb",
    "beans",
    "baz",
    "battler",
    "batch",
    "bastet",
    "bash",
    "bar",
    "baku",
    "baif",
    "bad",
    "b2",
    "azyz",
    "azure",
    "ax",
    "awai",
    "av",
    "aue",
    "atdan",
    "asven",
    "ask",
    "ash",
    "art",
    "arquan",
    "aru",
    "artyperson",
    "arty",
    "artwork",
    "artrus",
    "artofandy",
    "arthenol",
    "artgerm",
    "artist",
    "ars",
    "arom",
    "ari",
    "ardnov",
    "arc",
    "aqou",
    "aqua",
    "apuc",
    "apricot",
    "apple",
    "aogiri",
    "aoba",
    "aono",
    "another",
    "anis",
    "anlo",
    "angl",
    "andr",
    "anc",
    "amb",
    "ama",
    "alt",
    "alui",
    "alt",
    "allo",
    "all",
    "alex",
    "albert",
    "alba",
    "ajisai",
    "ai",
    "aho",
    "ags",
    "af",
    "advo",
    "adumi",
    "adriof",
    "act",
    "acdc",
    "abys",
    "abub",
    "abo",
    "abm",
    "abend",
    "abe",
    "abba",
    "a_baz",
    "a",
    "zuntata",
    "zumi",
    "zounose",
    "zol",
    "zone",
    "zonda",
    "zon",
    "zolo",
    "zoloft",
    "zolance",
    "zombie",
    "zomb",
    "zoldyck",
    "zoaldyeck",
    "zodiac",
    "znt",
    "zip",
    "zing",
    "zin",
    "zim",
    "zigen",
    "zi",
    "zhuzhu",
    "zheng",
    "zhao",
    "zhange",
    "zettai",
    "zero",
    "zeon",
    "zeno",
    "zen",
    "zem",
    "zel",
    "zei",
    "zed",
    "zawazawa",
    "zaurus",
    "zatt",
    "zat",
    "zara",
    "zantz",
    "zant",
    "zan",
    "zam",
    "zal",
    "zakki",
    "zak",
    "zai",
    "zag",
    "zaf",
    "zad",
    "zac",
    "zab",
    "za",
    "yzy",
    "yzk",
    "yz",
    "yyz",
    "yy",
    "yxy",
    "yx",
    "ywm",
    "ywj",
    "ywh",
    "ywg",
    "ywf",
    "ywe",
    "ywd",
    "ywc",
    "ywb",
    "ywa",
    "yw",
    "yvu",
    "yvt",
    "yvs",
    "yvr",
    "yvq",
    "yvp",
    "yvo",
    "yvn",
    "yvm",
    "yvl",
    "yvk",
    "yvj",
    "yvi",
    "yvh",
    "yvg",
    "yvf",
    "yve",
    "yvd",
    "yvc",
    "yvb",
    "yva",
    "yv",
    "yuz",
    "yuy",
    "yux",
    "yuw",
    "yuv",
    "yuu",
    "yut",
    "yus",
    "yur",
    "yuq",
    "yup",
    "yuo",
    "yun",
    "yum",
    "yul",
    "yuk",
    "yuj",
    "yui",
    "yuh",
    "yug",
    "yuf",
    "yue",
    "yud",
    "yuc",
    "yub",
    "yua",
    "yu",
    "ytz",
    "yty",
    "ytx",
    "ytw",
    "ytv",
    "ytu",
    "ytt",
    "yts",
    "ytr",
    "ytq",
    "ytp",
    "yto",
    "ytn",
    "ytm",
    "ytl",
    "ytk",
    "ytj",
    "yti",
    "yth",
    "ytg",
    "ytf",
    "yte",
    "ytd",
    "ytc",
    "ytb",
    "yta",
    "yt",
]


class ArtistIdentifier:
    """
    LSNet-style artist identification using classification models.

    Identifies the artist/style of an image and returns:
    - "undefined" if confidence is below threshold
    - Top predictions with confidence scores
    """

    def __init__(
        self,
        model_path: Optional[str] = None,
        model_source: str = ARTIST_MODEL_SOURCE_DEFAULT,
        threshold: float = ARTIST_THRESHOLD_DEFAULT,
        artists_list: Optional[List[str]] = None,
    ):
        """
        Initialize the artist identifier.

        Args:
            model_path: Path to local model file (ONNX or PyTorch)
            model_source: "huggingface", "modelscope", or "local"
            threshold: Minimum confidence threshold. Kaloscope logits are
                usually quite low, so values around 0.02-0.08 are more
                realistic than the old 0.35 default.
            artists_list: Custom list of artist names (optional)
        """
        self.model_path = model_path
        self.model_source = model_source
        self.threshold = threshold
        self.artists = artists_list or DEFAULT_ARTISTS
        self._model: Any = None
        self._session: Any = None
        self._processor: Any = None
        self._transform: Any = None
        self._input_size: int = 224
        self._backend: str = "unknown"
        self._load_error: Optional[str] = None

    def _load_class_mapping_csv(self, csv_path: str) -> List[str]:
        artists: List[str] = []
        with open(csv_path, "r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames or "class_id" not in reader.fieldnames or "class_name" not in reader.fieldnames:
                raise RuntimeError("Kaloscope class mapping CSV must contain class_id and class_name columns.")

            rows = []
            for row in reader:
                class_id = int(row["class_id"])
                class_name = str(row["class_name"] or "").strip().strip("'").strip('"')
                rows.append((class_id, class_name or f"unknown_{class_id}"))

        rows.sort(key=lambda item: item[0])
        artists = [name for _, name in rows]
        if not artists:
            raise RuntimeError("Kaloscope class mapping CSV is empty.")
        return artists

    def _load_kaloscope_checkpoint_blob(self, checkpoint_path: str):
        import argparse
        import torch

        torch.serialization.add_safe_globals([argparse.Namespace])
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
        if not isinstance(checkpoint, dict):
            raise RuntimeError("Unexpected Kaloscope checkpoint format.")
        return checkpoint

    def _load_kaloscope_runtime_modules(self):
        runtime_path = _resolve_lsnet_runtime_path()
        if not runtime_path:
            try:
                runtime_path = _ensure_comfyui_lsnet_runtime()
            except Exception as exc:
                raise RuntimeError(
                    "Kaloscope2.0 requires the LSNet runtime code.\n"
                    "Automatic download of comfyui-lsnet failed.\n"
                    "Clone either https://github.com/spawner1145/comfyui-lsnet or "
                    "https://github.com/spawner1145/lsnet-test and set "
                    "SD_IMAGE_SORTER_LSNET_CODE_PATH to that repository root."
                ) from exc

        if runtime_path not in sys.path:
            sys.path.insert(0, runtime_path)

        try:
            from timm.models import create_model
            from timm.data import resolve_data_config
            from timm.data.transforms_factory import create_transform
            try:
                from lsnet_model import lsnet_artist  # noqa: F401
                runtime_kind = "comfyui-lsnet"
            except ImportError:
                from model import lsnet_artist  # noqa: F401
                runtime_kind = "lsnet-test"
        except ModuleNotFoundError as exc:
            if exc.name == "triton":
                raise RuntimeError(
                    "Kaloscope2.0 currently requires the LSNet runtime plus `triton`.\n"
                    "On Windows, install `triton-windows`.\n"
                    "On Linux, install a compatible Triton package for your PyTorch/CUDA stack."
                ) from exc
        except ImportError as exc:
            raise RuntimeError(
                "Kaloscope2.0 requires `timm` plus a compatible LSNet runtime repository.\n"
                "Install `timm` and point SD_IMAGE_SORTER_LSNET_CODE_PATH at a comfyui-lsnet or lsnet-test checkout."
            ) from exc

        logger.info("Using %s runtime for Kaloscope", runtime_kind)
        return create_model, resolve_data_config, create_transform

    def _initialize_kaloscope(self, checkpoint_path: str, class_mapping_path: str):
        import torch

        create_model, resolve_data_config, create_transform = self._load_kaloscope_runtime_modules()
        checkpoint = self._load_kaloscope_checkpoint_blob(checkpoint_path)
        args = checkpoint.get("args")
        model_name = getattr(args, "model", None) or "lsnet_xl_artist_448"
        feature_dim = getattr(args, "feature_dim", None)
        self._input_size = int(getattr(args, "input_size", 448) or 448)

        artists = self._load_class_mapping_csv(class_mapping_path)
        state_dict = checkpoint.get("model_ema") or checkpoint.get("model")
        if state_dict is None:
            raise RuntimeError("Kaloscope checkpoint is missing model weights.")
        state_dict = _normalize_state_dict_keys(state_dict)

        model = create_model(
            model_name,
            pretrained=False,
            num_classes=len(artists),
            feature_dim=feature_dim,
        )
        load_result = model.load_state_dict(state_dict, strict=False)
        unexpected = [key for key in load_result.unexpected_keys if not key.startswith("head_dist")]
        if unexpected:
            logger.warning("Kaloscope unexpected keys ignored: %s", unexpected[:10])
        if load_result.missing_keys:
            logger.warning("Kaloscope missing keys during load: %s", load_result.missing_keys[:10])

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model.to(device)
        model.eval()

        data_config = resolve_data_config(
            {"input_size": (3, self._input_size, self._input_size)},
            model=model,
        )
        transform = create_transform(**data_config, is_training=False)

        self._model = model
        self._processor = None
        self._transform = transform
        self.artists = artists
        self._backend = "kaloscope"
        logger.info("Loaded Kaloscope model '%s' with %d artist classes", model_name, len(self.artists))

    def load(self):
        """Load the model (lazy loading)."""
        global _model, _processor, _model_source

        if self._model is not None:
            return

        with _model_lock:
            if self._model is not None:
                return

            # Try to load based on source
            if self.model_path and os.path.exists(self.model_path):
                self._load_local_model(self.model_path)
            elif self.model_source == "modelscope":
                self._load_from_modelscope()
            else:
                # Default: try HuggingFace or fall back to placeholder
                self._load_from_huggingface()

    def _load_local_model(self, path: str):
        """Load model from local file."""
        try:
            if path.endswith('.onnx'):
                import onnxruntime as ort  # type: ignore
                self._session = ort.InferenceSession(path)
                self._model = "onnx"
                self._backend = "onnx"
            else:
                class_mapping_path = os.path.join(os.path.dirname(path), ARTIST_KALOSCOPE_CLASS_MAPPING)
                if os.path.exists(class_mapping_path):
                    self._initialize_kaloscope(path, class_mapping_path)
                else:
                    # Try generic PyTorch model as legacy fallback
                    try:
                        import torch
                        self._model = torch.load(path, map_location='cpu')
                        self._model.eval()
                        self._backend = "torch-generic"
                    except Exception:
                        # Fall back to ONNX runtime
                        import onnxruntime as ort  # type: ignore
                        self._session = ort.InferenceSession(path)
                        self._model = "onnx"
                        self._backend = "onnx"
            self._load_error = None
            logger.info(f"Loaded model from: {path}")
        except Exception as e:
            logger.warning(f"Failed to load model: {e}")
            self._model = "placeholder"
            self._load_error = str(e)

    def _load_from_huggingface(self):
        """Load model from HuggingFace."""
        try:
            model_name = ARTIST_HF_MODEL_ID

            logger.info(f"Loading from HuggingFace: {model_name}")
            if _is_kaloscope_model_id(model_name):
                prepared = prepare_artist_assets("auto")
                checkpoint_path = prepared["checkpoint_path"]
                class_mapping_path = prepared["class_mapping_path"]
                self._initialize_kaloscope(checkpoint_path, class_mapping_path)
            else:
                from transformers import AutoImageProcessor, AutoModelForImageClassification

                self._processor = AutoImageProcessor.from_pretrained(model_name)
                self._model = AutoModelForImageClassification.from_pretrained(model_name)
                self._model.eval()
                self._backend = "transformers"

                if hasattr(self._model.config, 'id2label'):
                    self.artists = [self._model.config.id2label.get(i, f"unknown_{i}")
                                   for i in range(len(self._model.config.id2label))]

                logger.info(f"Loaded model with {len(self.artists)} styles")
            self._load_error = None
        except Exception as e:
            logger.warning(f"HuggingFace load failed: {e}")
            logger.info("Using placeholder mode (no model loaded)")
            self._model = "placeholder"
            self._load_error = str(e)

    def _load_from_modelscope(self):
        """Load model from ModelScope."""
        try:
            logger.info("Loading from ModelScope")
            prepared = prepare_artist_assets("modelscope")
            self._initialize_kaloscope(prepared["checkpoint_path"], prepared["class_mapping_path"])
            self._load_error = None
        except Exception as e:
            logger.warning(f"ModelScope load failed: {e}")
            logger.info("Using placeholder mode (no model loaded)")
            self._model = "placeholder"
            self._load_error = str(e)

    def identify(
        self,
        image_path: str,
        top_k: int = 5,
    ) -> Dict[str, Any]:
        """
        Identify the artist/style of an image.

        Args:
            image_path: Path to the image file
            top_k: Number of top predictions to return

        Returns:
            {
                "artist": str,  # "undefined" if below threshold
                "confidence": float,
                "top_predictions": [{"artist": str, "confidence": float}, ...],
                "model_loaded": bool,
            }
        """
        self.load()

        result: Dict[str, Any] = {
            "artist": "undefined",
            "confidence": 0.0,
            "top_predictions": [],
            "model_loaded": self._model is not None and self._model != "placeholder",
        }

        if self._model == "placeholder":
            result["error"] = (
                self._load_error
                or "Artist model unavailable. Install the required dependencies and restart the app, "
                   "or configure a working local model."
            )
            return result

        try:
            # Load and preprocess image
            image = Image.open(image_path).convert("RGB")

            if self._session is not None:
                # ONNX inference
                predictions = self._run_onnx(image)
            elif self._backend == "kaloscope":
                predictions = self._run_kaloscope(image)
            else:
                # PyTorch/Transformers inference
                predictions = self._run_torch_classifier(image)

            # Get top predictions
            top_indices = np.argsort(predictions)[::-1][:top_k]

            for idx in top_indices:
                artist_name = self.artists[idx] if idx < len(self.artists) else f"unknown_{idx}"
                confidence = float(predictions[idx])
                result["top_predictions"].append({
                    "artist": artist_name,
                    "confidence": round(confidence, 4),
                })

            # Set main result based on threshold
            if result["top_predictions"]:
                top = result["top_predictions"][0]
                if top["confidence"] >= self.threshold:
                    result["artist"] = top["artist"]
                    result["confidence"] = top["confidence"]
                else:
                    result["artist"] = "undefined"
                    result["confidence"] = top["confidence"]

        except Exception as e:
            logger.error(f"Error identifying {image_path}: {e}")
            result["error"] = str(e)

        return result

    def _run_onnx(self, image: Image.Image) -> np.ndarray:
        """Run inference with ONNX model."""
        # Preprocess image
        img_resized = image.resize((224, 224))
        img_array = np.array(img_resized).astype(np.float32) / 255.0
        img_array = np.transpose(img_array, (2, 0, 1))
        img_array = np.expand_dims(img_array, 0)

        # Get input name
        assert self._session is not None
        input_name = self._session.get_inputs()[0].name

        # Run inference
        outputs = self._session.run(None, {input_name: img_array})

        # Apply softmax
        logits = outputs[0][0]
        exp_logits = np.exp(logits - np.max(logits))
        return exp_logits / np.sum(exp_logits)

    def _run_kaloscope(self, image: Image.Image) -> np.ndarray:
        """Run inference with the LSNet/Kaloscope classifier."""
        import torch

        if self._transform is None:
            raise RuntimeError("Kaloscope transform pipeline is not initialized.")

        tensor = self._transform(image).unsqueeze(0)
        assert self._model is not None
        device = next(self._model.parameters()).device
        with torch.no_grad():
            logits = self._model(tensor.to(device))
            if isinstance(logits, tuple):
                logits = logits[0]
            logits = logits[0]

        probs = torch.nn.functional.softmax(logits, dim=0)
        return probs.detach().cpu().numpy()

    def _run_torch_classifier(self, image: Image.Image) -> np.ndarray:
        """Run inference with a Transformers-compatible image classifier."""
        import torch

        if self._processor is None:
            raise RuntimeError("Artist processor is not initialized.")

        inputs = self._processor(images=image, return_tensors="pt")

        assert self._model is not None
        with torch.no_grad():
            outputs = self._model(**inputs)
            logits = outputs.logits[0]

        probs = torch.nn.functional.softmax(logits, dim=0)
        return probs.detach().cpu().numpy()

    def set_threshold(self, threshold: float):
        """Set the confidence threshold."""
        self.threshold = threshold

    def get_artists_list(self) -> List[str]:
        """Get the list of known artists."""
        return self.artists.copy()

    @staticmethod
    def is_available() -> bool:
        """Check if artist identification is available."""
        try:
            import torch  # noqa: F401
        except ImportError:
            return False

        if _is_kaloscope_model_id(ARTIST_HF_MODEL_ID):
            return _has_lsnet_runtime()

        try:
            from transformers import AutoImageProcessor, AutoModelForImageClassification  # noqa: F401
            return True
        except ImportError:
            return False


# Singleton
_identifier = None


def get_artist_identifier(
    model_path: Optional[str] = None,
    model_source: str = ARTIST_MODEL_SOURCE_DEFAULT,
    threshold: float = ARTIST_THRESHOLD_DEFAULT,
) -> ArtistIdentifier:
    """Get the singleton artist identifier."""
    global _identifier
    normalized_path = str(model_path).strip() if model_path else None

    if (
        _identifier is None
        or _identifier.model_source != model_source
        or _identifier.model_path != normalized_path
    ):
        _identifier = ArtistIdentifier(
            model_path=normalized_path,
            model_source=model_source,
            threshold=threshold,
        )
    else:
        _identifier.set_threshold(threshold)
    return _identifier
