/**
 * gallery/generator-note.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 595-688 (of 4,708): generator label/normalize + AI-provider note + localized refresh.
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    _normalizeGenerator(generator) {
        const normalized = String(generator || 'unknown').trim().toLowerCase();
        return Object.prototype.hasOwnProperty.call(DEFAULT_GENERATOR_COLORS, normalized)
            ? normalized
            : 'unknown';
    },

    _formatGeneratorLabel(generator) {
        return window.App?.formatGeneratorLabel?.(generator, 'Unknown')
            || String(generator || 'unknown');
    },

    _setGeneratorText(element, generator) {
        if (!element) return;
        const normalized = this._normalizeGenerator(generator);
        element.dataset.generatorValue = normalized;
        element.textContent = this._formatGeneratorLabel(normalized);
    },

    /**
     * Show or hide the "metadata-only detection" hint shown for
     * closed-source AI providers (Gemini / gpt-image) where we
     * identified the source via Content Credentials / EXIF rather
     * than the in-pixel invisible watermark. The note keeps the user
     * aware that we have NOT verified Google's SynthID or OpenAI's
     * pixel signal directly. Stay in sync with
     * backend/metadata_parser.py::MetadataParser._maybe_detect_ai_provider.
     */
    _updateAiProviderNote(generator) {
        const note = document.getElementById('modal-ai-provider-note');
        if (!note) return;
        const text = document.getElementById('modal-ai-provider-text');
        const id = String(generator || '').trim().toLowerCase();
        if (id === 'gemini') {
            if (text) {
                text.setAttribute('data-i18n', 'modal.aiProviderNote.gemini');
                text.textContent = this._t(
                    'modal.aiProviderNote.gemini',
                    null,
                    'Identified via Content Credentials / EXIF metadata. Google\'s invisible SynthID watermark embedded in the pixels themselves is not yet checked by this app — planned for a future opt-in detector.'
                );
            }
            note.style.display = '';
            note.dataset.provider = 'gemini';
            return;
        }
        if (id === 'gpt-image') {
            if (text) {
                // Swap the data-i18n attribute so the global i18n
                // re-translate cycle (which honours data-i18n on every
                // child element) updates the gpt-image text instead of
                // resetting it to the gemini key the HTML markup ships
                // with.
                text.setAttribute('data-i18n', 'modal.aiProviderNote.gptImage');
                text.textContent = this._t(
                    'modal.aiProviderNote.gptImage',
                    null,
                    'Identified via Content Credentials / EXIF metadata. OpenAI\'s invisible in-pixel watermark is not yet checked by this app and currently has no public open-source detector.'
                );
            }
            note.style.display = '';
            note.dataset.provider = 'gpt-image';
            return;
        }
        note.style.display = 'none';
        delete note.dataset.provider;
    },

    refreshLocalizedContent() {
        const { AppState } = getGalleryAppContext();
        document.querySelectorAll('#gallery-grid .gallery-item').forEach((item) => {
            const imageId = item.dataset.id;
            const image = AppState.images.find((entry) => String(entry.id) === String(imageId));
            const generator = image?.generator || item.querySelector('.gallery-item-generator')?.dataset.generatorValue || 'unknown';
            const generatorLabel = this._formatGeneratorLabel(generator);
            const generatorEl = item.querySelector('.gallery-item-generator');
            if (generatorEl) {
                this._setGeneratorText(generatorEl, generator);
            }
            item.setAttribute('aria-label', `${image?.filename || 'Image'} - ${generatorLabel}`);
        });

        const modalGenerator = document.getElementById('modal-generator');
        if (modalGenerator?.dataset.generatorValue) {
            modalGenerator.textContent = this._formatGeneratorLabel(modalGenerator.dataset.generatorValue);
        }
    },

    _bindLanguageUpdates() {
        if (this._languageBound) return;
        document.addEventListener('languageChanged', () => this.refreshLocalizedContent());
        this._languageBound = true;
    },

});
