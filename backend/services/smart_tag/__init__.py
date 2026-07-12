"""Smart-Tag orchestrator: WD14/OppaiOracle + VLM + noise-strip + trigger inject.

This module runs an automated "smart caption" pipeline against a list of
image IDs already in our gallery DB. The pipeline is:

    1. For each image, run a local tagger (WD14 / OppaiOracle / Camie / etc)
       to produce booru-style tags. If the image is already tagged in the DB
       (images.tagged_at set) and skip_existing is True, the whole image is
       skipped (no tagger call, no VLM caption) and counted as "skipped".
    2. Strip "noise" tags (quality / score / safety / meta / time markers)
       from the WD14 output before they go anywhere near the VLM. These are
       the tags LoRA trainers explicitly want to *anchor*, not have the VLM
       describe back as scene-content.
    3. Pick a VLM prompt preset based on the user's chosen training purpose:
        - style     -> describe subject / scene variation while omitting the
                       target style vocabulary
        - character -> describe pose / action / expression / framing,
                       explicitly NOT hair color / eye color / signature
                       outfit (those are baked into the latent)
        - general   -> 2-3 sentences covering subject / pose / clothing /
                       background / lighting
        - concept   -> describe the surrounding context without guessing which
                       detected tag is the target concept
    4. Call the configured VLM with the assembled prompt.
    5. Build the final caption: [rating] [trigger] [general_tags] [NL_text].
    6. Inject trigger word at the front (if user supplied one).
    7. Write the result back to the DB via the existing tagging service plumb.

Purpose presets are deliberately conservative. Training tools document how
captions, shuffling, and kept tokens are consumed, but they do not prescribe a
universal category-deletion table for each LoRA type. The service therefore
removes only targets it can identify reliably and preserves the rest as context.

This service is pure orchestration: it does not load models, it does not
own the DB connection. It calls into ``tagger.get_tagger`` /
``oppai_oracle_tagger.get_oppai_oracle_tagger`` / the VLM providers and
the existing tagging-service write path. That keeps it cheap to test,
easy to swap a tagger out, and lets the existing model-runtime safety
guards (chunk-size clamps, GPU fallback, BSOD-prevention session refresh)
keep working unchanged.
"""

# This package is the decomposition of the old ~2900-line
# services/smart_tag_service.py god-file (2026-07). Import through
# services.smart_tag_service (the compatibility facade) for existing code,
# or from the specific submodule for new code. Submodule map: consensus /
# prompts / request / jobs / results / sources / tagging / caption_phase /
# pipeline - see the facade docstring for ownership details.
