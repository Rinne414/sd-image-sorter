/**
 * smart-tag/form.js — smart-tag.js decomposition.
 * Extracted VERBATIM from frontend/js/smart-tag.js pre-split lines
 * 641-729: readForm (the POST /api/smart-tag/start payload assembly —
 * single vs dual-tagger consensus branch) plus the postJson/getJson
 * fetch helpers. Hosts the contract literals pinned by
 * backend/tests/test_frontend_contract.py: vlm_grounding,
 * toriigate_grounding, `image_paths: sources.imagePaths`,
 * `selection_token: sources.selectionToken`,
 * `dataset_scan_token: sources.datasetScanToken` (all verbatim).
 * Classic script; family renames applied ($ -> smartTag$).
 */
'use strict';
    function readForm() {
        const consensusMode = smartTag$('#smart-tag-consensus-mode')?.value || 'or';
        const booruEnabled = !!smartTag$('#smart-tag-enable-wd14')?.checked;
        const naturalEnabled = !!smartTag$('#smart-tag-enable-vlm')?.checked;
        const generalThreshold = toFiniteThreshold(smartTag$('#smart-tag-general-threshold')?.value, 0.35);
        const characterThreshold = toFiniteThreshold(smartTag$('#smart-tag-character-threshold')?.value, 0.85);
        const copyrightThreshold = toFiniteThreshold(smartTag$('#smart-tag-copyright-threshold')?.value, generalThreshold);
        const tagger1 = (smartTag$('#smart-tag-tagger-1')?.value || '').trim();
        const tagger2 = (smartTag$('#smart-tag-tagger-2')?.value || '').trim();
        const selectedTaggers = booruEnabled ? [tagger1, tagger2].filter(Boolean) : [];
        const uniqueTaggers = Array.from(new Set(selectedTaggers));
        const maxTagsPerImage = getPayloadMaxTagsForModels(uniqueTaggers);
        const sharedThresholds = {
            general_threshold: generalThreshold,
            character_threshold: characterThreshold,
            copyright_threshold: copyrightThreshold,
        };
        const primaryThresholds = getPayloadThresholdsForModel(uniqueTaggers[0] || '', sharedThresholds);
        const sources = getDatasetSources();
        const form = {
            image_ids: sources.imageIds,
            selection_token: sources.selectionToken || undefined,
            image_paths: sources.imagePaths,
            dataset_scan_token: sources.datasetScanToken || undefined,
            training_purpose: smartTag$('#smart-tag-purpose')?.value || 'general',
            trigger_word: (smartTag$('#smart-tag-trigger')?.value || '').trim(),
            merge_strategy: smartTag$('#smart-tag-merge')?.value || 'replace',
            auto_strip_noise: !!smartTag$('#smart-tag-strip-noise')?.checked,
            skip_existing: !!smartTag$('#smart-tag-skip-existing')?.checked,
            enable_wd14: booruEnabled,
            enable_vlm: naturalEnabled,
            natural_language_mode: smartTag$('#smart-tag-nl-mode')?.value || 'vlm',
            use_gpu: !!smartTag$('#smart-tag-use-gpu')?.checked,
            toriigate_caption_length: smartTag$('#smart-tag-torii-length')?.value || 'detailed',
            vlm_grounding: smartTag$('#smart-tag-vlm-grounding')
                ? !!smartTag$('#smart-tag-vlm-grounding').checked
                : true,
            toriigate_grounding: smartTag$('#smart-tag-torii-grounding')
                ? !!smartTag$('#smart-tag-torii-grounding').checked
                : true,
            general_threshold: primaryThresholds.general_threshold,
            character_threshold: primaryThresholds.character_threshold,
            copyright_threshold: primaryThresholds.copyright_threshold,
            max_tags_per_image: maxTagsPerImage,
            // Empty tagger_model is still allowed as the backend default fallback.
            tagger_model: uniqueTaggers[0] || '',
            consensus_min: consensusMode === 'and' ? 2 : 1,
        };
        if (uniqueTaggers.length >= 2) {
            form.tagger_model = '';
            form.taggers = uniqueTaggers.slice(0, 2).map((model) => ({
                ...getPayloadThresholdsForModel(model, sharedThresholds),
                model,
                weight: 1,
            }));
            form.consensus_min = consensusMode === 'and' ? 2 : 1;
            form.consensus_skip_categories = ['character', 'copyright'];
        }
        return form;
    }

    async function postJson(url, body) {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body == null ? null : JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const detail = data && data.detail ? data.detail : `HTTP ${resp.status}`;
            const err = new Error(detail);
            err.status = resp.status;
            err.payload = data;
            throw err;
        }
        return data;
    }

    async function getJson(url) {
        const resp = await fetch(url);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const err = new Error(data?.detail || `HTTP ${resp.status}`);
            err.status = resp.status;
            throw err;
        }
        return data;
    }

