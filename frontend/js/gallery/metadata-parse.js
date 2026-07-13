/**
 * gallery/metadata-parse.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 2065-2110 + 2414-2660 (of 4,708): _extractParsedData + _t + metadata value extraction.
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    /**
     * Extract parsed metadata from image, with JS fallback for old images.
     * Returns { generation_params, is_img2img, img2img_info, character_prompts, prompt_nodes }
     */
    _extractParsedData(image) {
        // Try to get _parsed from metadata_json
        let metaObj = null;
        if (image.metadata_json) {
            try {
                metaObj = typeof image.metadata_json === 'string'
                    ? JSON.parse(image.metadata_json)
                    : image.metadata_json;
            } catch (_) {
                metaObj = null;
            }
        }

        if (metaObj && metaObj._parsed) {
            return metaObj._parsed;
        }

        // Fallback: try to extract from raw metadata for old images
        return this._fallbackParseMeta(metaObj, image);
    },

    _fallbackParseMeta(metaObj, image) {
        return {
            generation_params: {},
            is_img2img: false,
            img2img_info: {},
            character_prompts: [],
            prompt_nodes: [],
            model_assets: null,
        };
    },

    _t(key, params, fallback) {
        if (window.I18n && typeof window.I18n.t === 'function') {
            const translated = window.I18n.t(key, params);
            if (translated && translated !== key) {
                return translated;
            }
        }
        return fallback || key;
    },

    _normalizeMetadataKey(key) {
        return String(key || '')
            .replace(/[\s_-]/g, '')
            .toLowerCase();
    },

    _getMetadataObject(image) {
        if (!image?.metadata_json) return {};

        try {
            const metadata = typeof image.metadata_json === 'string'
                ? JSON.parse(image.metadata_json)
                : image.metadata_json;
            return metadata && typeof metadata === 'object' ? metadata : {};
        } catch (_) {
            return {};
        }
    },

    _parseEmbeddedJson(value) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value;
        }

        if (typeof value !== 'string') return null;

        let text = value.trim();
        if (!text) return null;

        if (text.startsWith('ASCII') || text.startsWith('UNICODE')) {
            text = text.slice(7).trim();
        }

        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
            text = text.slice(jsonStart, jsonEnd + 1);
        }

        try {
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (_) {
            return null;
        }
    },

    _extractCommentData(image) {
        const metadata = this._getMetadataObject(image);
        return this._parseEmbeddedJson(metadata.Comment)
            || this._parseEmbeddedJson(metadata.UserComment)
            || null;
    },

    _findMetadataValue(sources, aliases) {
        const normalizedAliases = aliases.map(alias => this._normalizeMetadataKey(alias));

        for (const source of sources) {
            if (!source || typeof source !== 'object') continue;

            for (const alias of aliases) {
                if (Object.prototype.hasOwnProperty.call(source, alias) && source[alias] != null && source[alias] !== '') {
                    return source[alias];
                }
            }

            for (const [key, value] of Object.entries(source)) {
                if (value == null || value === '') continue;
                if (normalizedAliases.includes(this._normalizeMetadataKey(key))) {
                    return value;
                }
            }
        }

        return null;
    },

    _formatMetadataValue(value) {
        if (value == null) return '';

        if (Array.isArray(value)) {
            return value
                .map(item => this._formatMetadataValue(item))
                .filter(Boolean)
                .join(', ');
        }

        if (typeof value === 'number') {
            return Number.isInteger(value)
                ? String(value)
                : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
        }

        if (typeof value === 'boolean') {
            return value ? 'true' : 'false';
        }

        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            } catch (_) {
                return String(value);
            }
        }

        return String(value).trim();
    },

    _extractRawParameterText(image) {
        const metadata = this._getMetadataObject(image);
        const rawValue = this._findMetadataValue(
            [metadata],
            ['parameters', 'Parameters', 'ImageDescription']
        );

        if (typeof rawValue !== 'string') return '';

        const start = rawValue.search(/(?:^|\n)\s*Steps\s*:/i);
        if (start === -1) return '';

        return rawValue
            .slice(start)
            .replace(/\s*\n\s*/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
    },

    _summarizeWorkflowValue(value, image, parsedData) {
        const generator = String(image?.generator || '').toLowerCase();
        const workflowFallback = generator.includes('comfy')
            ? (parsedData?.is_img2img ? 'ComfyUI img2img workflow' : 'ComfyUI workflow')
            : '';

        if (value == null || value === '') {
            return workflowFallback;
        }

        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) {
                return workflowFallback;
            }

            if (/^\s*[\[{]/.test(trimmed)) {
                return workflowFallback;
            }

            if (/txt2img/i.test(trimmed)) return 'txt2img';
            if (/img2img/i.test(trimmed)) return 'img2img';
            if (/inpaint/i.test(trimmed)) return 'inpaint';
            if (trimmed.length > 80) {
                return workflowFallback || trimmed.slice(0, 80).trim() + '...';
            }

            return trimmed;
        }

        if (typeof value === 'object') {
            return workflowFallback;
        }

        return workflowFallback || String(value);
    },

    _buildGenerationParamEntries(image, parsedData) {
        const params = parsedData?.generation_params || {};
        const metadata = this._getMetadataObject(image);
        const commentData = this._extractCommentData(image);
        const imageExtras = {
            checkpoint: image?.checkpoint || null,
        };
        const sources = [params, commentData, imageExtras, metadata];
        const entries = [];
        const usedKeys = new Set();

        const pushEntry = (label, aliases) => {
            const aliasList = Array.isArray(aliases) ? aliases : [aliases];
            const rawValue = this._findMetadataValue(sources, aliasList);
            if (rawValue == null || rawValue === '') return;

            const displayValue = this._formatMetadataValue(rawValue);
            if (!displayValue) return;

            entries.push({ label, value: displayValue });
            aliasList.forEach(alias => usedKeys.add(this._normalizeMetadataKey(alias)));
        };

        pushEntry('Steps', ['steps']);
        pushEntry('CFG scale', ['cfg_scale', 'cfg', 'scale']);
        pushEntry('Sampler', ['sampler', 'sampler_name']);
        pushEntry('Scheduler', ['scheduler', 'noise_schedule', 'schedule_type']);
        pushEntry('Seed', ['seed', 'noise_seed']);
        pushEntry(parsedData?.is_img2img ? 'Denoising strength' : 'Denoise', ['denoising_strength', 'denoise', 'strength']);
        pushEntry('Noise', ['noise']);
        const workflowSummary = this._summarizeWorkflowValue(
            this._findMetadataValue([params, commentData], ['workflow', 'request_type']),
            image,
            parsedData
        );
        if (workflowSummary) {
            entries.push({ label: 'Workflow', value: workflowSummary });
            ['workflow', 'request_type'].forEach(alias => usedKeys.add(this._normalizeMetadataKey(alias)));
        }
        pushEntry('Size', ['size', 'resolution']);
        pushEntry('Input', ['input']);
        pushEntry('Output', ['output']);
        pushEntry('Priority', ['priority']);
        pushEntry('Quantity', ['quantity', 'n_samples']);
        pushEntry('Ecosystem', ['ecosystem']);
        pushEntry('Created Date', ['Created Date', 'created_date', 'createdDate', 'generation_time', 'Generation time']);
        pushEntry('Output Format', ['outputFormat', 'output_format']);
        pushEntry('Enhanced Compatibility', ['enhancedCompatibility', 'enhanced_compatibility']);
        pushEntry('Clip skip', ['clip_skip', 'clipSkip']);
        pushEntry('Model', ['model', 'checkpoint']);
        pushEntry('Model Hash', ['model_hash']);
        pushEntry('Hires Upscaler', ['hires_upscaler']);
        pushEntry('Hires Scale', ['hires_upscale']);
        pushEntry('Hires Steps', ['hires_steps']);
        pushEntry('SMEA', ['sm']);
        pushEntry('SMEA Dyn', ['sm_dyn']);
        pushEntry('CFG Rescale', ['cfg_rescale']);
        pushEntry('UC Preset', ['uc_preset', 'ucPreset']);
        pushEntry('Quality Toggle', ['quality_toggle', 'qualityToggle']);
        pushEntry('Dynamic Thresholding', ['dynamic_thresholding']);
        pushEntry('Uncond Scale', ['uncond_scale']);
        pushEntry('Skip CFG σ', ['skip_cfg_above_sigma']);
        pushEntry('Use Coords', ['use_coords']);
        pushEntry('Use Order', ['use_order']);

        Object.entries(params).forEach(([key, value]) => {
            const normalizedKey = this._normalizeMetadataKey(key);
            if (usedKeys.has(normalizedKey) || value == null || value === '') {
                return;
            }

            const label = key
                .replace(/_/g, ' ')
                .replace(/\b\w/g, char => char.toUpperCase());
            const displayValue = this._formatMetadataValue(value);
            if (!displayValue) return;

            entries.push({ label, value: displayValue });
        });

        return entries;
    },

});
