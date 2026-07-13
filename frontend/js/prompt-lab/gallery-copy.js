/**
 * prompt-lab/gallery-copy.js - prompt-lab.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/prompt-lab.js pre-cut lines 1495-1559 (of 2,485):
 * the Prompt Lab to Gallery round-trip (usePromptInGallery), copyPrompt, and
 * clearAll.
 * Classic script: joins the ONE unsealed window.PromptLab object declared
 * in prompt-lab/base.js (loads FIRST); prompt-lab/boot.js declares the
 * initPromptLab boot LAST; index.html lists the family in original line order.
 */
Object.assign(window.PromptLab, {
    // ============== Copy ==============

    // Prompt Lab -> Gallery round-trip: take the composed/active prompt and use
    // it as the gallery's prompt filter, then switch to the Gallery view.
    // The prompt is split on commas into individual terms (same convention as the
    // gallery prompt-filter input), so 'exact' match mode ANDs across tags.
    usePromptInGallery() {
        const App = window.App;
        if (!App) return;

        const raw = (document.getElementById('promptlab-output')?.value || this.generatedPrompt || '').trim();
        if (!raw) {
            App.showToast?.(
                this._t('promptlab.findInGalleryEmpty', 'Build or type a prompt first, then find it in the gallery.'),
                'info'
            );
            return;
        }

        const terms = [];
        const seen = new Set();
        for (const part of raw.split(',')) {
            const term = part.trim();
            if (!term) continue;
            const key = term.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            terms.push(term);
        }
        if (terms.length === 0) {
            App.showToast?.(
                this._t('promptlab.findInGalleryEmpty', 'Build or type a prompt first, then find it in the gallery.'),
                'info'
            );
            return;
        }

        App.updateFilters?.((filters) => {
            filters.prompts = terms;
            filters.promptMatchMode = 'exact';
        });
        App.updateFilterSummary?.();
        App.switchView?.('gallery');
        App.loadImages?.();
        App.showToast?.(
            this._t('promptlab.findInGalleryDone', 'Gallery filtered by this prompt'),
            'success'
        );
    },

    copyPrompt() {
        const output = document.getElementById('promptlab-output');
        if (!output?.value) return;
        copyTextToClipboard(output.value, this._t('promptlab.promptCopied', 'Prompt copied'));
    },

    clearAll() {
        this.slots = {};
        this.weights = {};
        this.locked = {};
        this.renderCategoryBrowser();
        this.renderSlotBuilder();
        this.invalidateGeneratedPrompt();
    },

});
