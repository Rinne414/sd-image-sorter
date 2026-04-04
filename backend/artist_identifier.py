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

    identifier = ArtistIdentifier(threshold=0.5)
    result = identifier.identify("path/to/image.png")
    # Returns: {"artist": "some_artist", "confidence": 0.85, "top_predictions": [...]}
"""
import logging
import os
import threading
from typing import Dict, List, Optional, Tuple, Any

import numpy as np
from PIL import Image
from config import (
    ARTIST_MODEL_SOURCE_DEFAULT,
    ARTIST_HF_MODEL_ID,
    ARTIST_MODELSCOPE_MODEL_ID,
)

logger = logging.getLogger("sd-image-sorter.artist")


# Lazy-loaded model
_model = None
_processor = None
_model_lock = threading.Lock()
_model_source = None

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
        threshold: float = 0.35,
        artists_list: Optional[List[str]] = None,
    ):
        """
        Initialize the artist identifier.

        Args:
            model_path: Path to local model file (ONNX or PyTorch)
            model_source: "huggingface", "modelscope", or "local"
            threshold: Minimum confidence threshold. Below this = "undefined"
            artists_list: Custom list of artist names (optional)
        """
        self.model_path = model_path
        self.model_source = model_source
        self.threshold = threshold
        self.artists = artists_list or DEFAULT_ARTISTS
        self._model: Any = None
        self._session: Any = None

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
            else:
                # Try PyTorch
                try:
                    import torch
                    self._model = torch.load(path, map_location='cpu')
                    self._model.eval()
                except Exception:
                    # Fall back to ONNX runtime
                    import onnxruntime as ort  # type: ignore
                    self._session = ort.InferenceSession(path)
                    self._model = "onnx"
            logger.info(f"Loaded model from: {path}")
        except Exception as e:
            logger.warning(f"Failed to load model: {e}")
            self._model = "placeholder"

    def _load_from_huggingface(self):
        """Load model from HuggingFace."""
        try:
            # Try to use transformers for CLIP-based classification
            from transformers import AutoImageProcessor, AutoModelForImageClassification

            # Keep the default on a plain Transformers image-classification model.
            # This favors integration compatibility today; it does not mean this is
            # the best long-term artist model for bundling or release distribution.
            model_name = ARTIST_HF_MODEL_ID

            logger.info(f"Loading from HuggingFace: {model_name}")
            self._processor = AutoImageProcessor.from_pretrained(model_name)
            self._model = AutoModelForImageClassification.from_pretrained(model_name)
            self._model.eval()

            # Get artist names from model config
            if hasattr(self._model.config, 'id2label'):
                self.artists = [self._model.config.id2label.get(i, f"unknown_{i}")
                               for i in range(len(self._model.config.id2label))]

            logger.info(f"Loaded model with {len(self.artists)} styles")
        except Exception as e:
            logger.warning(f"HuggingFace load failed: {e}")
            logger.info("Using placeholder mode (no model loaded)")
            self._model = "placeholder"

    def _load_from_modelscope(self):
        """Load model from ModelScope."""
        try:
            from modelscope import snapshot_download  # type: ignore
            from transformers import AutoImageProcessor, AutoModelForImageClassification

            # Download model from ModelScope
            model_dir = snapshot_download(ARTIST_MODELSCOPE_MODEL_ID)

            logger.info("Loading from ModelScope")
            self._processor = AutoImageProcessor.from_pretrained(model_dir)
            self._model = AutoModelForImageClassification.from_pretrained(model_dir)
            self._model.eval()

            if hasattr(self._model.config, 'id2label'):
                self.artists = [self._model.config.id2label.get(i, f"unknown_{i}")
                               for i in range(len(self._model.config.id2label))]

            logger.info(f"Loaded model with {len(self.artists)} styles")
        except Exception as e:
            logger.warning(f"ModelScope load failed: {e}")
            logger.info("Falling back to HuggingFace")
            self._load_from_huggingface()

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
                "Artist model unavailable. Install the required dependencies and restart the app, "
                "or configure a working local model."
            )
            return result

        try:
            # Load and preprocess image
            image = Image.open(image_path).convert("RGB")

            if self._session is not None:
                # ONNX inference
                predictions = self._run_onnx(image)
            else:
                # PyTorch/Transformers inference
                predictions = self._run_transformers(image)

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

    def _run_transformers(self, image: Image.Image) -> np.ndarray:
        """Run inference with Transformers model."""
        import torch

        # Preprocess
        inputs = self._processor(images=image, return_tensors="pt")

        # Inference
        assert self._model is not None
        with torch.no_grad():
            outputs = self._model(**inputs)
            logits = outputs.logits[0]

        # Softmax
        probs = torch.nn.functional.softmax(logits, dim=0)
        return probs.numpy()

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
            import torch
            from transformers import AutoImageProcessor, AutoModelForImageClassification
            return True
        except ImportError:
            return False


# Singleton
_identifier = None


def get_artist_identifier(
    model_path: Optional[str] = None,
    model_source: str = ARTIST_MODEL_SOURCE_DEFAULT,
    threshold: float = 0.35,
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
