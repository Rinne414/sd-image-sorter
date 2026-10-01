"""Where the aesthetic predictor's CLIP ViT-L/14 backbone lives in a cache.

Kept apart from ``aesthetic.py`` (which pulls in numpy and the GPU guard) so
``model_matchers_hf`` can name the same repo and files without importing the
scoring runtime. ``aesthetic.py`` imports these names back.
"""

BACKBONE_REPO = "timm/vit_large_patch14_clip_224.openai"
BACKBONE_REPO_DIR = "models--timm--vit_large_patch14_clip_224.openai"
BACKBONE_FILENAMES = (
    "open_clip_model.safetensors",
    "pytorch_model.bin",
    "ViT-L-14.pt",
)
# The first two are what a Hugging Face snapshot folder holds; the third is
# open_clip's own cache file name.
BACKBONE_SNAPSHOT_FILENAMES = BACKBONE_FILENAMES[:2]
