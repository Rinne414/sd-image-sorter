(function () {
    'use strict';

    var UIRefresh = {
        _observer: null,
        _applyScheduled: false,
        _applying: false,
        _observerSuspended: false,
        _observerResumeHandle: null,

        _t: function (key, params, fallback) {
            if (window.I18n && typeof window.I18n.t === 'function') {
                var translated = window.I18n.t(key, params);
                if (translated && translated !== key) {
                    return translated;
                }
            }
            return fallback || key;
        },

        _escape: function (value) {
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        },

        _setText: function (selector, key, fallback) {
            var el = document.querySelector(selector);
            if (!el) return;
            el.textContent = this._t(key, null, fallback);
        },

        _setStaticText: function (selector, key, fallback) {
            var el = document.querySelector(selector);
            if (!el || !el.hasAttribute('data-i18n')) return;
            el.textContent = this._t(key, null, fallback);
        },

        _setTextAll: function (selector, keys) {
            var nodes = document.querySelectorAll(selector);
            for (var i = 0; i < nodes.length && i < keys.length; i++) {
                nodes[i].textContent = this._t(keys[i]);
            }
        },

        _setAttr: function (selector, attr, key, fallback) {
            var el = document.querySelector(selector);
            if (!el) return;
            el.setAttribute(attr, this._t(key, null, fallback));
        },

        _setPlaceholder: function (selector, key) {
            var el = document.querySelector(selector);
            if (!el) return;
            el.placeholder = this._t(key);
        },

        _setButton: function (selector, key, icon, titleKey) {
            var el = document.querySelector(selector);
            if (!el) return;
            var label = this._escape(this._t(key));
            var iconHtml = icon ? '<span aria-hidden="true">' + this._escape(icon) + '</span>' : '';
            el.innerHTML = iconHtml + '<span class="ui-label">' + label + '</span>';
            if (titleKey) {
                var text = this._t(titleKey);
                el.title = text;
                el.setAttribute('aria-label', text);
            }
        },

        _setCountButton: function (selector, key) {
            var button = document.querySelector(selector);
            if (!button) return;
            var count = button.querySelector('.gen-count');
            var countHtml = '';
            if (count) {
                countHtml = '<span class="gen-count" id="' + count.id + '">' + this._escape(count.textContent) + '</span>';
            }
            button.innerHTML = this._escape(this._t(key)) + ' ' + countHtml;
        },

        _setOptionText: function (selectSelector, optionMap) {
            var select = document.querySelector(selectSelector);
            if (!select) return;
            Object.keys(optionMap).forEach(function (value) {
                var option = select.querySelector('option[value="' + value + '"]');
                if (option) {
                    option.textContent = UIRefresh._t(optionMap[value]);
                }
            });
        },

        _setCheckboxTexts: function (selector, keys) {
            var nodes = document.querySelectorAll(selector + ' .checkbox-text');
            for (var i = 0; i < nodes.length && i < keys.length; i++) {
                nodes[i].textContent = this._t(keys[i]);
            }
        },

        _setSummaryStrongs: function (selector, keys) {
            var nodes = document.querySelectorAll(selector + ' strong');
            for (var i = 0; i < nodes.length && i < keys.length; i++) {
                nodes[i].textContent = this._t(keys[i]) + ':';
            }
        },

        _setViewToggle: function (selector, key) {
            var button = document.querySelector(selector);
            if (!button) return;
            button.textContent = this._t(key);
        },

        _setToggleHeader: function (selector, key) {
            var el = document.querySelector(selector);
            if (!el) return;

            var icon = el.querySelector('.collapse-icon');
            if (!icon) {
                el.textContent = this._t(key);
                return;
            }

            el.innerHTML = this._escape(this._t(key)) + ' <span class="collapse-icon">' + this._escape(icon.textContent || '▼') + '</span>';
        },

        _translateGallery: function () {
            this._setCountButton('#generator-tabs .gen-tab[data-gen="all"]', 'generator.all');
            this._setCountButton('#generator-tabs .gen-tab[data-gen="nai"]', 'generator.nai');
            this._setCountButton('#generator-tabs .gen-tab[data-gen="comfyui"]', 'generator.comfyui');
            this._setCountButton('#generator-tabs .gen-tab[data-gen="forge"]', 'generator.forge');
            this._setCountButton('#generator-tabs .gen-tab[data-gen="webui"]', 'generator.webui');
            this._setCountButton('#generator-tabs .gen-tab[data-gen="unknown"]', 'generator.unknown');

            this._setOptionText('#gallery-sort', {
                newest: 'sort.newest',
                oldest: 'sort.oldest',
                name_asc: 'sort.nameAsc',
                name_desc: 'sort.nameDesc',
                generator: 'sort.generator',
                prompt_length: 'sort.promptLength',
                tag_count: 'sort.tagCount',
                rating: 'sort.rating',
                character_count: 'sort.characterCount',
                file_size: 'sort.fileSize',
                file_size_asc: 'sort.fileSizeAsc',
                aesthetic: 'sort.aesthetic',
                random: 'sort.random'
            });

            this._setText('#gallery-empty-state h3', 'gallery.noImages');
            this._setText('#gallery-empty-state p', 'gallery.scanPrompt');
            this._setButton('#empty-state-scan-btn', 'action.scan', '📂', 'action.scan');
            this._setText('#load-more-btn', 'gallery.loadMore');
            this._setText('#gallery-loading span', 'gallery.loading');
            this._setSummaryStrongs('#autosep-filter-summary', [
                'summary.generators',
                'summary.tags',
                'summary.ratings',
                'summary.checkpoints',
                'summary.loras',
                'summary.prompts',
                'summary.dimensions'
            ]);
            this._setSummaryStrongs('#manual-sort-filter-summary', [
                'summary.generators',
                'summary.tags',
                'summary.ratings',
                'summary.checkpoints',
                'summary.loras',
                'summary.prompts',
                'summary.dimensions'
            ]);
            this._setTextAll('#filter-summary .summary-label', [
                'summary.generators',
                'summary.ratings',
                'summary.tags',
                'summary.checkpoints',
                'summary.loras',
                'summary.prompt',
                'summary.artist'
            ]);
        },

        _translateAutoSeparate: function () {
            this._setText('#view-autosep .panel-title', 'autosep.title');
            this._setText('#view-autosep .panel-description', 'autosep.description');
            this._setText('#view-autosep .filter-header-compact h4', 'filter.criteria');
            this._setButton('#btn-autosep-filters', 'gallery.editFilters', '🔍', 'gallery.editFilters');
            this._setText('#autosep-scope-note', 'autosep.scopeNote');
            this._setText('#view-autosep .filter-section:nth-of-type(2) h4', 'autosep.destination');
            this._setButton('#btn-browse-destination', 'common.browse', null, 'common.browse');
            this._setPlaceholder('#autosep-destination', 'modal.folderPath');
            this._setText('#view-autosep .preview-section h4', 'autosep.preview');
            this._setText('#autosep-preview .stat-label', 'common.images', 'images');
            this._setText('#autosep-preview-list .autosep-preview-empty', 'autosep.previewEmpty');
            this._setText('#view-autosep .autosep-preview-hint', 'autosep.previewHint');
            this._setButton('#btn-preview-autosep', 'autosep.previewBtn', null, 'autosep.previewBtn');
            this._setButton('#btn-execute-autosep', 'autosep.moveBtn', '📁', 'autosep.moveBtn');
        },

        _translateManual: function () {
            this._setText('#manual-sort-mobile-warning h3', 'manual.keyboardRequired');
            this._setText('#manual-sort-mobile-warning p', 'manual.keyboardMsg');
            this._setButton('#return-to-gallery-btn', 'manual.returnToGallery');
            this._setText('#view-manual .setup-title', 'manual.title');
            this._setText('#view-manual .setup-description', 'manual.description');
            this._setText('#manual-sort-scope-note', 'manual.scopeNote');
            this._setText('#view-manual .space-indicator span', 'manual.skip');
            this._setText('#view-manual .filter-header-compact h4', 'filter.imagesToSort');
            this._setButton('#btn-manual-sort-filters', 'gallery.editFilters', '🔍', 'gallery.editFilters');
            this._setButton('#btn-start-sorting', 'manual.startSorting', '🎮', 'manual.startSorting');
            this._setText('#gallery-preview-bar .minimap-label', 'manual.minimap');
            this._setTextAll('.minimap-legend .legend-item', ['manual.current', 'manual.sorted', 'manual.pending']);
            this._setTextAll('.progress-stat-label', ['manual.sorted', 'manual.skipped', 'manual.progress', 'manual.remaining', 'manual.speed']);
            this._setText('.progress-hint', 'manual.progressHint');
        },

        _translateSimilar: function () {
            this._setText('#view-similar .similar-header h3', 'similar.title');
            this._setButton('#btn-similar-embed', 'similar.generateEmbed');
            this._setText('#view-similar .similar-tab[data-target="panel-similar-search"]', 'similar.search');
            this._setText('#view-similar .similar-tab[data-target="panel-similar-duplicates"]', 'similar.duplicates');
            this._setPlaceholder('#similar-search-id', 'similar.searchById');
            this._setButton('#btn-similar-search', 'similar.searchById');
            this._setButton('#btn-similar-upload', 'similar.upload');
            this._setStaticText('#similar-results .empty-state', 'similar.searchEmpty');
            this._setText('#panel-similar-duplicates label', 'similar.threshold');
            this._setButton('#btn-similar-duplicates', 'similar.findDuplicates');
            this._setStaticText('#similar-duplicates .empty-state', 'similar.duplicatesEmpty');
        },

        _translatePromptLab: function () {
            this._setText('#view-promptlab .promptlab-browser-header h4', 'promptlab.categories');
            this._setPlaceholder('#promptlab-search', 'promptlab.searchTags');
            this._setText('#view-promptlab .tagset-selector label', 'promptlab.tagSet');
            this._setOptionText('#promptlab-set-select', { '': 'promptlab.selectTagSet' });
            this._setButton('#btn-promptlab-apply-tagset', 'promptlab.applyTagSet');
            this._setText('#view-promptlab .promptlab-builder-header h4', 'promptlab.slots');
            this._setButton('#btn-promptlab-random', 'promptlab.randomize', '🎲', 'promptlab.randomize');
            this._setButton('#btn-promptlab-clear', 'promptlab.clear', '🗑️', 'promptlab.clear');
            this._setText('#view-promptlab .promptlab-output-header h4', 'promptlab.output');
            this._setButton('#btn-promptlab-use-gallery', 'promptlab.useInGallery', '🔎', 'promptlab.useInGallery');
            this._setButton('#btn-promptlab-generate', 'promptlab.generate');
            this._setButton('#btn-promptlab-copy', 'promptlab.copy', '📋', 'promptlab.copy');
            this._setButton('#btn-promptlab-validate', 'promptlab.validate', '✅', 'promptlab.validate');
            this._setPlaceholder('#promptlab-output', 'promptlab.outputPlaceholder');
            this._setText('#view-promptlab .promptlab-presets-header h5', 'promptlab.presets');
            this._setButton('#btn-promptlab-save-preset', 'promptlab.savePreset', '💾', 'promptlab.savePreset');
            this._setStaticText('#promptlab-categories .empty-state', 'promptlab.loadingCategories');
            this._setStaticText('#promptlab-slots .empty-state', 'promptlab.loadingSlots');
            this._setStaticText('#promptlab-presets .preset-empty', 'promptlab.noPresets');
        },

        _translateArtist: function () {
            this._setText('#view-artist .artist-results-header-note', 'artist.experimental');
            this._setTextAll('#artist-stats .stat-label', ['artist.totalImages', 'artist.identified', 'artist.undefined', 'artist.artistsFound']);
            this._setTextAll('#view-artist .control-section h3', ['artist.modelSettings', 'artist.identification', 'artist.actions']);
            this._setTextAll('#view-artist .control-section label', ['artist.modelSource', 'artist.localModelPath', 'artist.confidenceThreshold']);
            this._setOptionText('#artist-model-source', {
                huggingface: 'artist.huggingface',
                modelscope: 'artist.modelscope',
                local: 'artist.localModel'
            });
            this._setPlaceholder('#artist-model-path', 'artist.localModelPath');
            this._setText('#view-artist .control-section .helper-text', 'artist.belowThreshold');
            this._setButton('#btn-identify-all', 'artist.identifyAll', '🎨', 'artist.identifyAll');
            this._setButton('#btn-identify-selected', 'artist.identifySelected', '🎯', 'artist.identifySelected');
            this._setButton('#btn-refresh-artist-stats', 'artist.refreshStats', '🔄', 'artist.refreshStats');
            this._setButton('#btn-clear-artist-data', 'artist.clearPredictions', '🗑️', 'artist.clearPredictions');
            this._setText('#view-artist .results-header h3', 'artist.topArtists');
            this._setViewToggle('#view-artist .toggle-btn[data-view="grid"]', 'artist.grid');
            this._setViewToggle('#view-artist .toggle-btn[data-view="list"]', 'artist.list');
            this._setText('#artist-results-grid .empty-state p', 'artist.noArtists');
            this._setText('#artist-results-grid .empty-hint', 'artist.noArtistsHint');
            this._setText('#view-artist .artist-details h3', 'artist.details');
            this._setText('#artist-detail-content .detail-placeholder', 'artist.selectArtist');
        },

        _translateImageModal: function () {
            this._setButton('#modal-prev-image', 'modal.prev', '←', 'modal.prev');
            this._setButton('#modal-next-image', 'modal.next', '→', 'modal.next');
            this._setButton('#btn-copy-prompt', 'modal.copyPrompt');
            this._setButton('#btn-copy-negative', 'modal.copyNegative');
            this._setButton('#btn-copy-tags', 'modal.copyTags');
            this._setButton('#btn-copy-params', 'modal.copyParams');
            this._setButton('#btn-copy-all', 'modal.copyAll');
            this._setButton('#btn-reparse-metadata', 'modal.reparse');
            this._setTextAll('.modal-meta strong', ['modal.generator', 'modal.size', 'modal.checkpoint']);
            this._setText('#modal-loading-state', 'modal.loadingDetails');
            this._setText('#modal-img2img-badge', 'modal.img2img');
            this._setText('#modal-loras-section h4', 'modal.loras');
            this._setText('.modal-prompt h4', 'modal.prompt');
            this._setToggleHeader('#modal-negative-section h4', 'modal.negativePrompt');
            this._setText('#modal-characters-section h4', 'modal.characterPrompts');
            this._setToggleHeader('#modal-params-section h4', 'modal.genParams');
            this._setText('#modal-img2img-section h4', 'modal.img2imgDetails');
            this._setToggleHeader('#modal-nodes-section h4', 'modal.promptNodes');
            this._setToggleHeader('#modal-color-distribution h4', 'modal.colorDistribution');
            this._setText('.modal-tags-header h4', 'modal.tags');
        },

        _translateModalForms: function () {
            this._setText('#scan-modal-title', 'modal.scanFolder');
            this._setText('#scan-folder-path-label', 'modal.folderPath');
            this._setPlaceholder('#scan-folder-path', 'modal.folderPath');
            this._setText('#scan-modal .checkbox-text', 'modal.includeSubfolders');
            var scanCancelBtn = document.querySelector('#btn-cancel-scan');
            if (!scanCancelBtn || scanCancelBtn.dataset.liveLabel !== '1') {
                this._setButton('#btn-cancel-scan', 'modal.cancel');
            }
            this._setButton('#btn-start-scan', 'modal.startScan');
            // Do NOT reset #scan-progress-text here while a scan is live.
            // The app removes data-i18n during active scans so progress polling
            // can own this field without MutationObserver/i18n clobbering it.
            this._setStaticText('#scan-progress-text', 'modal.scanStarting');

            this._setText('#tag-modal-title', 'modal.tagTitle');
            this._setText('#tag-modal .modal-description', 'modal.tagDescription');
            this._setText('#tag-model-select-label', 'modal.tagModel');
            this._setOptionText('#tag-model-select', {
                custom: 'modal.tagCustomModel'
            });
            this._setText('#custom-model-group label', 'modal.tagCustomModelPath');
            this._setPlaceholder('#tag-model-path', 'modal.tagCustomModelPath');
            this._setText('#custom-model-group .helper-text', 'modal.tagCustomModelPathHelper');
            this._setText('#custom-tags-group label', 'modal.tagTagsCsvPath');
            this._setPlaceholder('#tag-tags-path', 'modal.tagTagsCsvPath');
            this._setText('#custom-tags-group .helper-text', 'modal.tagTagsCsvHelper');
            this._setTextAll('#tag-modal .form-group > label:not(.checkbox-label)', [
                'modal.tagModel',
                'modal.tagCustomModelPath',
                'modal.tagTagsCsvPath',
                'modal.tagGeneralThreshold',
                'modal.tagCharacterThreshold'
            ]);
            this._setCheckboxTexts('#tag-modal', ['modal.tagRetagAll', 'modal.tagUseGpu']);
            this._setText('#tag-modal .form-group:last-of-type .helper-text', 'modal.tagUseGpuHelper');
            // Do NOT reset #tag-progress-text here while tagging is live.
            // The app removes data-i18n during active runs so progress polling
            // can own this field without MutationObserver/i18n clobbering it.
            this._setStaticText('#tag-progress-text', 'modal.tagLoadingModel');
            this._setButton('#btn-export-tags', 'modal.tagExport', '📤', 'modal.tagExport');
            this._setButton('#btn-import-tags', 'modal.tagImport', '📥', 'modal.tagImport');
            this._setButton('#btn-cancel-tag', 'modal.tagCancel');
            this._setButton('#btn-start-tag', 'modal.tagStart');

            this._setText('#analytics-modal h3', 'modal.analytics');
            this._setTextAll('#analytics-modal h4', ['modal.topCheckpoints', 'modal.topLoras', 'modal.topTags']);

            this._setText('#export-title', 'modal.exportPrompts');
            this._setButton('#btn-export-tags-alt', 'modal.exportTagsAlt');
            this._setButton('#btn-copy-export', 'modal.copyToClipboard');

            this._setText('#confirm-title', 'modal.confirm');
            this._setText('#confirm-message', 'modal.confirmAction');
            this._setButton('#btn-confirm-cancel', 'modal.cancel');
            this._setButton('#btn-confirm-ok', 'modal.yes');

            this._setText('#input-modal-title', 'modal.enterValue');
            this._setButton('#btn-input-cancel', 'modal.cancel');
            this._setButton('#btn-input-ok', 'modal.ok');
        },

        _translateLibraryAndExport: function () {
            this._setText('#batch-export-modal h3', 'batchExport.title');
            this._setTextAll('#batch-export-modal label', ['batchExport.outputFolder', 'batchExport.tagPrefix', 'batchExport.tagBlacklist']);
            this._setPlaceholder('#batch-export-folder', 'batchExport.outputFolder');
            this._setPlaceholder('#batch-export-prefix', 'batchExport.tagPrefix');
            this._setPlaceholder('#batch-export-blacklist', 'batchExport.tagBlacklist');
            this._setTextAll('#batch-export-modal .helper-text', ['batchExport.outputFolderHelper', 'batchExport.tagPrefixHelper', 'batchExport.tagBlacklistHelper']);
            this._setText('#batch-export-progress-text', 'batchExport.exporting');
            this._setButton('#btn-cancel-batch-export', 'batchExport.cancel');
            this._setButton('#btn-start-batch-export', 'batchExport.exportFiles');

            this._setText('#rename-modal h3', 'rename.title');
            this._setText('#rename-modal .modal-description', 'rename.description');
            this._setText('#rename-modal .checkbox-text', 'rename.useOriginal');
            this._setText('#rename-modal .helper-text', 'rename.useOriginalHelper');
            this._setTextAll('#rename-modal .form-group label:not(.checkbox-label)', ['rename.baseName', 'rename.startingNumber', 'rename.preview']);
            this._setTextAll('#rename-modal .form-group .helper-text', ['rename.useOriginalHelper', 'rename.baseNameHelper', 'rename.startingNumberHelper']);
            this._setPlaceholder('#rename-base', 'rename.baseName');
            this._setText('.preview-hint', 'rename.andSoOn');
            this._setButton('#btn-cancel-rename', 'rename.cancel');
            this._setButton('#btn-apply-rename', 'rename.apply');

            this._setText('#save-options-modal h3', 'save.title');
            this._setText('#save-options-modal .modal-description', 'save.description');
            this._setTextAll('#save-options-modal label', ['save.outputFolder', 'save.metadataHandling', 'save.outputFormat']);
            this._setPlaceholder('#save-output-folder', 'save.outputFolder');
            this._setTextAll('#save-options-modal .helper-text', ['save.outputFolderHelper', 'save.metadataHelper', 'save.formatHelper']);
            this._setOptionText('#save-metadata-option', {
                strip: 'save.metadataStrip',
                keep: 'save.metadataKeep',
                minimal: 'save.metadataMinimal'
            });
            this._setOptionText('#save-format-option', {
                png: 'save.formatPng',
                webp: 'save.formatWebp'
            });
            this._setButton('#btn-cancel-save-options', 'save.cancel');
            this._setButton('#btn-confirm-save-options', 'save.saveAll', '💾', 'save.saveAll');

            this._setText('#model-select-title', 'modelSelect.title');
            this._setPlaceholder('#model-select-search', 'modelSelect.search');
            this._setButton('#btn-cancel-model-select', 'modelSelect.cancel');
            this._setButton('#btn-confirm-model-select', 'modelSelect.apply');

            this._setText('#tags-library-modal h3', 'library.title');
            this._setText('#tags-library-modal .modal-description', 'library.description');
            this._setButton('#library-tab-tags', 'library.tags', '🏷️', 'library.tags');
            this._setButton('#library-tab-prompts', 'library.prompts', '📝', 'library.prompts');
            this._setButton('#library-tab-loras', 'library.loras', '🧩', 'library.loras');
            this._setOptionText('#library-sort', {
                frequency: 'library.sortFrequency',
                alphabetical: 'library.sortAlpha'
            });
            this._setPlaceholder('#library-search', 'library.search');
            this._setText('#library-stats-text', 'library.loading');
            this._setButton('#btn-close-tags-library-2', 'library.close');
        },

        _translateSelectionAndFilters: function () {
            this._setButton('#btn-open-library-from-filter', 'filter.browseLibrary', '📚', 'filter.browseLibrary');
            this._setText('#filter-modal-title', 'filter.filterImages');
            this._setText('#generator-filters-heading', 'filter.generators');
            this._setCheckboxTexts('#modal-generator-filters', [
                'generator.comfyui',
                'generator.nai',
                'generator.webui',
                'generator.forge',
                'generator.unknown'
            ]);
            this._setText('#dimensions-heading', 'filter.dimensions');
            this._setPlaceholder('#filter-min-width', 'filter.widthMin');
            this._setPlaceholder('#filter-max-width', 'filter.widthMax');
            this._setPlaceholder('#filter-min-height', 'filter.heightMin');
            this._setPlaceholder('#filter-max-height', 'filter.heightMax');
            this._setButton('#btn-reset-filters', 'filter.reset');
            this._setButton('#btn-apply-modal-filters', 'filter.apply');
            this._setText('#filter-modal .filter-column:nth-of-type(2) .filter-section:nth-of-type(1) h4', 'filter.tags');
            this._setText('#filter-modal .filter-column:nth-of-type(2) .filter-section:nth-of-type(2) h4', 'filter.promptSearch');
            this._setText('#filter-modal .filter-column:nth-of-type(2) .filter-section:nth-of-type(3) h4', 'filter.checkpoints');
            this._setText('#filter-modal .filter-column:nth-of-type(2) .filter-section:nth-of-type(4) h4', 'filter.loras');
            this._setPlaceholder('#modal-tag-search', 'filter.searchTags');
            this._setPlaceholder('#modal-prompt-search', 'filter.searchPrompts');
            this._setPlaceholder('#modal-checkpoint-search', 'filter.searchCheckpoints');
            this._setPlaceholder('#modal-lora-search', 'filter.searchLoras');

            this._setButton('#btn-select-all', 'selection.selectAll', '✓✓', 'selection.selectAll');
            this._setButton('#btn-export-selected', 'selection.exportPrompts', '📤', 'selection.exportPrompts');
            this._setButton('#btn-export-tags-selected', 'selection.exportTags', '🏷️', 'selection.exportTags');
            this._setButton('#btn-batch-export-tags', 'selection.exportTagsToFiles', '📝', 'selection.exportTagsToFiles');
            this._setButton('#btn-send-to-censor', 'selection.censorEdit', '🔳', 'selection.censorEdit');
            this._setButton('#btn-clear-selection', 'selection.deselectAll');
        },

        _translateCommonState: function () {
            this._setText('#global-loading-msg', 'common.loading');
            this._setAttr('#btn-help', 'title', 'guide.title');
            this._setAttr('#btn-help', 'aria-label', 'guide.title');
            this._setAttr('#mobile-btn-language', 'title', 'lang.switchTitle');
            this._setAttr('#mobile-btn-language', 'aria-label', 'lang.switchLabel');
            this._setAttr('#btn-language-toggle', 'title', 'lang.switchTitle');
            this._setAttr('#btn-language-toggle', 'aria-label', 'lang.switchLabel');
        },

        _pauseObserver: function () {
            this._observerSuspended = true;
            if (this._observerResumeHandle != null) {
                cancelAnimationFrame(this._observerResumeHandle);
                this._observerResumeHandle = null;
            }
        },

        _resumeObserverSoon: function () {
            var self = this;
            if (this._observerResumeHandle != null) {
                cancelAnimationFrame(this._observerResumeHandle);
            }
            this._observerResumeHandle = requestAnimationFrame(function () {
                self._observerSuspended = false;
                self._observerResumeHandle = null;
            });
        },

        applyTranslations: function () {
            if (this._applying) return;
            this._applying = true;
            this._pauseObserver();

            try {
                if (window.I18n && typeof window.I18n.applyToDOM === 'function') {
                    window.I18n.applyToDOM();
                }

                this._translateGallery();
                this._translateAutoSeparate();
                this._translateManual();
                this._translateSimilar();
                this._translatePromptLab();
                this._translateArtist();
                this._translateImageModal();
                this._translateModalForms();
                this._translateLibraryAndExport();
                this._translateSelectionAndFilters();
                this._translateCommonState();
            } finally {
                this._applying = false;
                this._resumeObserverSoon();
            }
        },

        scheduleApply: function () {
            if (this._applyScheduled) return;
            this._applyScheduled = true;

            var self = this;
            requestAnimationFrame(function () {
                self._applyScheduled = false;
                self.applyTranslations();
            });
        },

        updateLanguageButtons: function () {
            var buttons = document.querySelectorAll('#btn-language-toggle, #mobile-btn-language');
            for (var i = 0; i < buttons.length; i++) {
                var button = buttons[i];
                var label = button.querySelector('span:last-child');
                if (label) {
                    label.textContent = this._t('lang.toggle');
                }
                button.title = this._t('lang.switchTitle');
                button.setAttribute('aria-label', this._t('lang.switchLabel'));
            }
        },

        initLanguageButtons: function () {
            var self = this;
            function bind(button) {
                if (!button || button.dataset.langBound === 'true') return;
                button.dataset.langBound = 'true';
                button.addEventListener('click', function () {
                    if (!window.I18n || typeof window.I18n.toggle !== 'function') return;
                    window.I18n.toggle();
                    if (button.id === 'mobile-btn-language' && typeof window.closeMobileMenu === 'function') {
                        window.closeMobileMenu();
                    }
                });
            }

            bind(document.getElementById('btn-language-toggle'));
            bind(document.getElementById('mobile-btn-language'));
            self.updateLanguageButtons();
        },

        observeChanges: function () {
            if (this._observer || !window.MutationObserver) return;
            var self = this;
            var root = document.getElementById('app');
            if (!root) return;

            this._observer = new MutationObserver(function () {
                if (!self._applying && !self._observerSuspended) {
                    self.scheduleApply();
                }
            });

            this._observer.observe(root, {
                childList: true,
                subtree: true,
                attributes: false
            });
        },

        init: function () {
            if (window.I18n && typeof window.I18n.init === 'function' && !window.I18n._initialized) {
                window.I18n.init();
            }

            document.documentElement.lang = window.I18n?.getLang?.() === 'zh-CN' ? 'zh-CN' : 'en';
            this.initLanguageButtons();
            this.applyTranslations();
            this.observeChanges();

            var self = this;
            document.addEventListener('languageChanged', function () {
                document.documentElement.lang = window.I18n?.getLang?.() === 'zh-CN' ? 'zh-CN' : 'en';
                self.updateLanguageButtons();
                self.scheduleApply();
            });

            setTimeout(function () { self.scheduleApply(); }, 120);
            setTimeout(function () { self.scheduleApply(); }, 500);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            UIRefresh.init();
        });
    } else {
        UIRefresh.init();
    }

    window.UIRefresh = UIRefresh;
})();
