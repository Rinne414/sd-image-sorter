/**
 * image-reader/extract.js — image-reader.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/image-reader.js pre-cut
 * lines 1158-1230 (of 1,749): the pure metadata extractors _getGenParams,
 * _getModelAssets, _getLoras (direct field → JSON string → <lora:...> prompt
 * fallback) and _getAllHashes (model / lora_hashes / ti_hashes keyed map).
 * Classic script: joins the ONE unsealed window.ImageReader object declared in
 * image-reader/core.js, which loads FIRST; index.html lists the family in
 * original line order (boot.js invokes init() LAST).
 */
'use strict';

Object.assign(window.ImageReader, {
        _getGenParams(result) {
            const metadata = result.metadata;
            if (!metadata) return {};
            try {
                const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
                return parsed?._parsed?.generation_params || parsed?.generation_params || {};
            } catch (_) {
                return {};
            }
        },

        _getModelAssets(result) {
            const metadata = result?.metadata;
            if (!metadata) return null;
            try {
                const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
                return parsed?._parsed?.model_assets || null;
            } catch (_) {
                return null;
            }
        },

        _getLoras(result) {
            // Try direct loras field first
            let loras = result.loras;
            if (typeof loras === 'string') {
                try { loras = JSON.parse(loras); } catch (_) { loras = []; }
            }
            if (Array.isArray(loras) && loras.length > 0) return loras;

            // Fallback: extract from prompt <lora:name:weight> patterns
            const prompt = result.prompt || '';
            const matches = prompt.match(/<lora:([^:>]+)(?::[^>]+)?>/gi);
            if (matches) {
                return matches.map(m => {
                    const match = m.match(/<lora:([^:>]+)/i);
                    return match ? match[1] : null;
                }).filter(Boolean);
            }

            return [];
        },

        _getAllHashes(result) {
            const gp = this._getGenParams(result);
            const hashes = {};

            // Model hash
            if (gp.model_hash) hashes.model = gp.model_hash;

            // Lora hashes (WebUI format: "loraName: hash, loraName2: hash2")
            const loraHashStr = gp.lora_hashes || gp['Lora hashes'] || '';
            if (loraHashStr) {
                const pairs = loraHashStr.split(',').map(s => s.trim());
                for (const pair of pairs) {
                    const [name, hash] = pair.split(':').map(s => s.trim());
                    if (name && hash) hashes[`lora:${name}`] = hash;
                }
            }

            // TI hashes
            const tiHashStr = gp.ti_hashes || gp['TI hashes'] || '';
            if (tiHashStr) {
                const pairs = tiHashStr.split(',').map(s => s.trim());
                for (const pair of pairs) {
                    const [name, hash] = pair.split(':').map(s => s.trim());
                    if (name && hash) hashes[`ti:${name}`] = hash;
                }
            }

            return hashes;
        },

});
