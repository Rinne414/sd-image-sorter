/**
 * gallery/prompt-convert.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 2111-2413 (of 4,708): prompt view + NAI<->SD weight conversion.
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    _getModalPromptView() {
        return this._modalPromptView || null;
    },

    _getPromptViewText() {
        const view = this._getModalPromptView();
        if (!view) {
            return {
                promptText: this._lastModalImage?.prompt || '',
                negativeText: this._lastModalImage?.negative_prompt || '',
                formatLabel: 'Original',
                isConverted: false,
                sourceFormat: this._detectPromptFormat(this._lastModalImage, this._lastParsedData),
                targetFormat: 'original',
                characterPrompts: [],
            };
        }
        return view;
    },

    _detectPromptFormat(image, parsedData) {
        const generator = String(image?.generator || '').toLowerCase();
        const combinedPrompt = [image?.prompt, image?.negative_prompt].filter(Boolean).join('\n');
        if (generator.includes('novel') || generator.includes('nai')) return 'nai';
        if (generator.includes('webui') || generator.includes('forge') || generator.includes('comfy')) return 'sd';
        if (parsedData?.character_prompts?.length) return 'nai';
        if (parsedData?.prompt_nodes?.length) return 'sd';
        if (/\b\d*\.?\d+\s*::/.test(combinedPrompt)) return 'nai';
        if (/[{][^{}]+[}]|\[[^\[\]]+\]/.test(combinedPrompt)) return 'nai';
        if (/<lora:[^>]+>/i.test(combinedPrompt)) return 'sd';
        if (/\((?:[^()\\]|\\.)+:\s*-?\d*\.?\d+\)/.test(combinedPrompt)) return 'sd';
        return 'unknown';
    },

    _normalizeCharacterPrompt(characterPrompt, index) {
        if (!characterPrompt) return null;

        const prompt = String(characterPrompt.prompt || '').trim();
        if (!prompt) return null;

        return {
            index: characterPrompt.index ?? index,
            prompt,
            negative_prompt: String(characterPrompt.negative_prompt || '').trim(),
            center: characterPrompt.center || null,
        };
    },

    _dedupePromptTokens(tokens) {
        const seen = new Set();
        const result = [];

        (tokens || []).forEach((token) => {
            const cleaned = String(token || '').trim();
            if (!cleaned) return;

            const normalized = cleaned.toLowerCase();
            if (seen.has(normalized)) return;

            seen.add(normalized);
            result.push(cleaned);
        });

        return result;
    },

    _collectPromptTextsFromNodes(parsedData, role) {
        if (!Array.isArray(parsedData?.prompt_nodes)) return [];

        return parsedData.prompt_nodes
            .filter((node) => {
                const nodeRole = String(node?.role || '').toLowerCase();
                return role === 'negative'
                    ? nodeRole.includes('negative')
                    : !nodeRole.includes('negative');
            })
            .map(node => String(node?.text || '').trim())
            .filter(Boolean);
    },

    _mergePromptSegments(segments) {
        const seen = new Set();
        const cleaned = [];

        (segments || []).forEach((segment) => {
            const text = String(segment || '').trim();
            if (!text) return;

            const normalized = text.toLowerCase();
            if (seen.has(normalized)) return;

            seen.add(normalized);
            cleaned.push(text);
        });

        return cleaned.join(', ');
    },

    _getPromptSourceBundle(image, parsedData) {
        const characterPrompts = Array.isArray(parsedData?.character_prompts)
            ? parsedData.character_prompts.map((entry, index) => this._normalizeCharacterPrompt(entry, index)).filter(Boolean)
            : [];
        const positiveSources = [image?.prompt];
        const negativeSources = [image?.negative_prompt];

        if (!String(image?.prompt || '').trim()) {
            positiveSources.push(...this._collectPromptTextsFromNodes(parsedData, 'positive'));
        }

        if (!String(image?.negative_prompt || '').trim()) {
            negativeSources.push(...this._collectPromptTextsFromNodes(parsedData, 'negative'));
        }

        if (characterPrompts.length > 0) {
            positiveSources.push(...characterPrompts.map(entry => entry.prompt));
            negativeSources.push(...characterPrompts.map(entry => entry.negative_prompt));
        }

        return {
            promptText: this._mergePromptSegments(positiveSources),
            negativeText: this._mergePromptSegments(negativeSources),
            characterPrompts,
        };
    },

    _formatPromptWeight(weight) {
        const numeric = Number(weight);
        if (!Number.isFinite(numeric)) return '';

        return (Math.round(numeric * 1000) / 1000)
            .toFixed(3)
            .replace(/0+$/, '')
            .replace(/\.$/, '');
    },

    _convertBracketRuns(text, openChar, closeChar, multiplier, transform) {
        const escapedOpen = openChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedClose = closeChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(${escapedOpen}+)([^${escapedOpen}${escapedClose}]+?)(${escapedClose}+)`, 'g');

        return String(text || '').replace(pattern, (match, openRun, content, closeRun) => {
            const trimmedContent = String(content || '').trim();
            if (!trimmedContent || openRun.length !== closeRun.length) {
                return match;
            }

            return transform(trimmedContent, Math.pow(multiplier, openRun.length), match);
        });
    },

    _convertNaiPromptTextToSd(text) {
        if (!text) return '';

        let converted = String(text);

        converted = converted.replace(/(^|[,\n]\s*|\s)(\d*\.?\d+)::\s*([\s\S]*?)\s*::(?=,|$|\n)/g, (match, prefix, weight, content) => {
            const trimmedContent = String(content || '').trim();
            const formattedWeight = this._formatPromptWeight(weight);
            if (!trimmedContent || !formattedWeight) return match;
            return `${prefix}(${trimmedContent}:${formattedWeight})`;
        });

        converted = this._convertBracketRuns(converted, '{', '}', 1.05, (content, weight) => {
            const formattedWeight = this._formatPromptWeight(weight);
            return formattedWeight ? `(${content}:${formattedWeight})` : content;
        });

        converted = this._convertBracketRuns(converted, '[', ']', 1 / 1.05, (content, weight) => {
            const formattedWeight = this._formatPromptWeight(weight);
            return formattedWeight ? `(${content}:${formattedWeight})` : content;
        });

        return converted.replace(/\s{2,}/g, ' ').trim();
    },

    _convertSdPromptTextToNai(text) {
        if (!text) return '';

        let converted = String(text);

        converted = converted.replace(/<lora:([^:>]+):([^>]+)>/gi, (match, name, weight) => {
            const formattedWeight = this._formatPromptWeight(weight);
            const trimmedName = String(name || '').trim();
            if (!trimmedName || !formattedWeight) return trimmedName || match;
            return `${formattedWeight}::${trimmedName}::`;
        });

        converted = converted.replace(/\(([^()]*?):\s*(-?\d*\.?\d+)\)/g, (match, content, weight) => {
            const trimmedContent = String(content || '').trim();
            const formattedWeight = this._formatPromptWeight(weight);
            if (!trimmedContent || !formattedWeight) return match;
            return `${formattedWeight}::${trimmedContent}::`;
        });

        converted = this._convertBracketRuns(converted, '(', ')', 1.1, (content, weight, originalMatch) => {
            if (/:\s*-?\d*\.?\d+\s*$/.test(content)) {
                return originalMatch;
            }

            const formattedWeight = this._formatPromptWeight(weight);
            return formattedWeight ? `${formattedWeight}::${content}::` : content;
        });

        converted = this._convertBracketRuns(converted, '[', ']', 1 / 1.1, (content, weight) => {
            const formattedWeight = this._formatPromptWeight(weight);
            return formattedWeight ? `${formattedWeight}::${content}::` : content;
        });

        return converted.replace(/\s{2,}/g, ' ').trim();
    },

    _convertPromptBundle(image, parsedData, targetFormat) {
        const sourceBundle = this._getPromptSourceBundle(image, parsedData);
        const sourceFormat = this._detectPromptFormat(image, parsedData);

        if (targetFormat === 'sd') {
            return {
                promptText: sourceFormat === 'nai'
                    ? this._convertNaiPromptTextToSd(sourceBundle.promptText)
                    : sourceBundle.promptText,
                negativeText: sourceFormat === 'nai'
                    ? this._convertNaiPromptTextToSd(sourceBundle.negativeText)
                    : sourceBundle.negativeText,
            };
        }

        if (targetFormat === 'nai') {
            return {
                promptText: sourceFormat === 'sd'
                    ? this._convertSdPromptTextToNai(sourceBundle.promptText)
                    : sourceBundle.promptText,
                negativeText: sourceFormat === 'sd'
                    ? this._convertSdPromptTextToNai(sourceBundle.negativeText)
                    : sourceBundle.negativeText,
            };
        }

        return {
            promptText: sourceBundle.promptText,
            negativeText: sourceBundle.negativeText,
        };
    },

    _buildPromptView(image, parsedData, targetFormat = 'original') {
        const sourceBundle = this._getPromptSourceBundle(image, parsedData);
        const promptText = sourceBundle.promptText;
        const negativeText = sourceBundle.negativeText;
        const sourceFormat = this._detectPromptFormat(image, parsedData);
        const normalizedTarget = ['original', 'sd', 'nai'].includes(targetFormat) ? targetFormat : 'original';
        const characterPrompts = sourceBundle.characterPrompts;

        if (normalizedTarget === 'original') {
            return {
                promptText,
                negativeText,
                formatLabel: 'Original',
                headerKey: 'modal.promptOriginal',
                sourceFormat,
                targetFormat: 'original',
                isConverted: false,
                characterPrompts,
            };
        }

        if (normalizedTarget === 'sd') {
            const converted = this._convertPromptBundle(image, parsedData, 'sd');

            return {
                promptText: converted.promptText || promptText,
                negativeText: converted.negativeText || negativeText,
                formatLabel: 'SD',
                headerKey: 'modal.promptSD',
                sourceFormat,
                targetFormat: 'sd',
                isConverted: sourceFormat !== 'sd',
                characterPrompts,
            };
        }

        const converted = this._convertPromptBundle(image, parsedData, 'nai');

        return {
            promptText: converted.promptText || promptText,
            negativeText: converted.negativeText || negativeText,
            formatLabel: 'NAI',
            headerKey: 'modal.promptNAI',
            sourceFormat,
            targetFormat: 'nai',
            isConverted: sourceFormat !== 'nai',
            characterPrompts,
        };
    },

    _buildConvertedPromptView(image, parsedData, targetFormat) {
        return this._buildPromptView(image, parsedData, targetFormat);
    },

    _getAlternatePromptTarget(sourceFormat) {
        if (sourceFormat === 'nai') return 'sd';
        if (sourceFormat === 'sd') return 'nai';
        return null;
    },

});
