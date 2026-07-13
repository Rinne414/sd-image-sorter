# =============================================================================
# metadata_parser.comfyui - metadata_parser decomposition stages 1+2 (2026-07-13).
# Extracted VERBATIM from backend/metadata_parser.py @ c06d374 (4,912 lines).
# Source line ranges (original file): .
# Sub-package facade: re-exports the four ComfyUI mixins.
# self.* calls and class-constant lookups resolve via MRO exactly as before.
# Patched seams (Image / open / _MAX_* / _sidecar_directory_cache): the readers
# live in metadata_parser/_runtime.py behind the package get/set proxy in
# __init__.py (stage 3); see tests/test_metadata_parser_pins.py.
from .assets import ComfyUIAssetsMixin
from .extract import ComfyUIExtractMixin
from .graph import ComfyUIGraphMixin
from .text_trace import ComfyUITextTraceMixin

__all__ = [
    "ComfyUIAssetsMixin",
    "ComfyUIExtractMixin",
    "ComfyUIGraphMixin",
    "ComfyUITextTraceMixin",
]
