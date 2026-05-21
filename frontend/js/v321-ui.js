/**
 * SD Image Sorter v3.2.1 — UI integration for:
 * (A) VLM as a primary tagger backend in the Tag modal
 * (B) LoRA training preset selector + template options in batch export modal
 * (C) Live export preview with per-image edit and override on save
 */

const V321Integration = {
    // === Shared state ===
    presets: [],           // List of LoRA presets from /api/tags/export-presets
    selectedPreset: 'illustrious_pony',  // default
    previewCache: new Map(),  // image_id -> rendered caption (auto-generated)
    editedCaptions: new Map(),  // image_id -> user-edited caption
    previewResults: [],    // legacy array OR sparse metadata cache (kept for compat)
    previewMetadata: new Map(), // image_id -> {filename, thumbnail_path}
    queueImageIds: [],     // full ordered list of all selected image IDs
    queueTotalCount: 0,    // total count for display
    activePreviewImageId: null,
    previewLimit: null, // No artificial cap — virtual scroll handles any count
    vlmActive: false,
    _queueScrollContainer: null,
    _queueRenderVisible: null,
    _captionEditorKeyHandler: null,

    init() {
        this.bindTaggerBackendSwitch();
        this.bindExportPresetUI();
        this.bindLivePreview();
        this.interceptExportSubmit();
        this.interceptCombinedExportClick();
        this.interceptTagSubmit();
        this.bindHardRefreshButton();
    },

    /** Wire the navbar 🔄 button. Performs a real hard refresh:
     *    1. delete every Cache Storage entry
     *    2. unregister any service worker (we don't ship one but be robust)
     *    3. clear sessionStorage (per-tab volatile state only)
     *    4. navigate to the same URL with a fresh ``?_t=<now>`` query so
     *       intermediate proxies / CDNs cannot serve a stale index.html
     *
     *  localStorage stays intact because that is where the user's gallery
     *  filters, language preference, and last-seen app version live. The
     *  SQLite DB and data directory are obviously untouched (server-side).
     */
    bindHardRefreshButton() {
        const btn = document.getElementById('btn-refresh-ui');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                if (typeof caches !== 'undefined' && caches && typeof caches.keys === 'function') {
                    const keys = await caches.keys();
                    await Promise.all(keys.map((k) => caches.delete(k)));
                }
            } catch (_e) { /* best-effort */ }
            try {
                if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map((r) => r.unregister()));
                }
            } catch (_e) { /* best-effort */ }
            try { sessionStorage.clear(); } catch (_e) {}
            try {
                const u = new URL(window.location.href);
                u.searchParams.set('_t', Date.now().toString());
                window.location.replace(u.toString());
            } catch (_e) {
                window.location.reload();
            }
        });
    },

    // ====================================================================
    // (A) Tagger 3-tab redesign — Local / Natural Language / Aesthetic
    //     Replaces the old single-dropdown VLM-mode-banner approach.
    // ====================================================================

    /** Currently selected tab id ('local' | 'nl' | 'aesthetic'). */
    activeTaggerTab: 'local',
    localModelPickerOpen: false,

    bindTaggerBackendSwitch() {
        const tabsRow = document.querySelector('#tag-modal .tagger-tabs');
        const select = document.getElementById('tag-model-select');
        if (!tabsRow || !select) return;

        const tabButtons = Array.from(tabsRow.querySelectorAll('.tagger-tab[data-tagger-tab]'));

        // -- Tab click handler --
        for (const btn of tabButtons) {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.taggerTab;
                if (!tab) return;
                this.setTaggerTab(tab);
            });
        }

        // The dropdown is rebuilt asynchronously by app.js loadTaggerModels()
        // when the modal opens. Re-apply tab visibility every time options
        // change so ToriiGate / VLM filtering stays correct.
        const observer = new MutationObserver(() => {
            this.applyTaggerTab(this.activeTaggerTab, { silent: true });
        });
        observer.observe(select, { childList: true });

        select.addEventListener('change', () => {
            if (this.activeTaggerTab === 'local') {
                this.localModelPickerOpen = false;
            }
            this.renderTaggerModelChoices();
        });

        document.getElementById('tagger-model-current')?.addEventListener('click', () => {
            if (this.activeTaggerTab !== 'local') return;
            this.localModelPickerOpen = !this.localModelPickerOpen;
            this.renderTaggerModelChoices();
        });

        // The "Open VLM Settings" button used by the Natural Language flow.
        const openVlmSettings = () => {
            if (window.VLMCaption?.openSettingsModal) {
                window.VLMCaption.openSettingsModal();
            } else {
                document.getElementById('btn-vlm-settings')?.click();
            }
        };
        document.getElementById('btn-vlm-banner-settings')?.addEventListener('click', openVlmSettings);
        document.getElementById('btn-vlm-banner-settings-legacy')?.addEventListener('click', openVlmSettings);

        // Setup CTAs — open Model Manager (Task 5 will scroll + highlight).
        this._openTaggerSetup = (highlightId, toastKey) => {
            const closeTagger = () => {
                if (typeof window.hideModal === 'function') {
                    window.hideModal('tag-modal');
                } else {
                    document.getElementById('tag-modal')?.classList.remove('visible');
                }
            };
            const showSetup = () => {
                if (typeof window.openModelManager === 'function') {
                    window.openModelManager();
                } else {
                    document.getElementById('btn-open-model-manager')?.click();
                }
            };
            closeTagger();
            // Defer so the close animation finishes before the next modal opens.
            setTimeout(() => {
                showSetup();
                if (highlightId) {
                    this._highlightModelCard(highlightId);
                }
                if (toastKey && typeof window.showToast === 'function') {
                    const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
                    window.showToast(i18n(toastKey, ''), 'info');
                }
            }, 60);
        };
        document.getElementById('btn-tagger-aesthetic-setup')?.addEventListener('click', () => {
            this._openTaggerSetup('aesthetic', 'tagger.routedFromTagger');
        });

        // Aesthetic tab Start / Cancel — proxy to the legacy global buttons that
        // the rest of app.js already wires up. We mirror their disabled / hidden
        // state via a small observer.
        document.getElementById('btn-tagger-aesthetic-start')?.addEventListener('click', () => {
            document.getElementById('btn-score-aesthetic')?.click();
        });
        document.getElementById('btn-tagger-aesthetic-cancel')?.addEventListener('click', () => {
            document.getElementById('btn-cancel-aesthetic')?.click();
        });
        document.getElementById('btn-cancel-aesthetic-tab')?.addEventListener('click', () => {
            if (typeof window.hideModal === 'function') {
                window.hideModal('tag-modal');
            }
        });

        // Initial state.
        this.setTaggerTab('local');
    },

    /** Switch the active tab. Updates dropdown filter, panel visibility, status text. */
    setTaggerTab(tab) {
        if (!['local', 'nl', 'aesthetic', 'color'].includes(tab)) {
            tab = 'local';
        }
        this.activeTaggerTab = tab;
        this.vlmActive = (tab === 'nl');
        if (tab !== 'local') {
            this.localModelPickerOpen = false;
        }

        // Tab button active state.
        const tabsRow = document.querySelector('#tag-modal .tagger-tabs');
        if (tabsRow) {
            for (const b of tabsRow.querySelectorAll('.tagger-tab')) {
                const isActive = b.dataset.taggerTab === tab;
                b.classList.toggle('active', isActive);
                b.setAttribute('aria-selected', isActive ? 'true' : 'false');
            }
        }

        // Tab description line below the tab row.
        const desc = document.getElementById('tagger-tab-description');
        const modalDesc = document.querySelector('#tag-modal .modal-description');
        if (desc) {
            const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
            const map = {
                local: 'tagger.tabLocalDesc',
                nl: 'tagger.tabNlDesc',
                aesthetic: 'tagger.tabAestheticDesc',
                color: 'tagger.tabColorDesc',
            };
            desc.setAttribute('data-i18n', map[tab]);
            desc.textContent = i18n(map[tab], '');
        }
        if (modalDesc) {
            const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
            const map = {
                local: ['modal.tagDescription', 'Pick a supported tagger model and generate tags for images.'],
                nl: ['tagger.modalDescNl', 'Choose a natural-language backend and caption selected images.'],
                aesthetic: ['tagger.modalDescAesthetic', 'Score selected images with the local aesthetic model.'],
                color: ['tagger.modalDescColor', 'Run local color analysis to enable color sorts and filters.'],
            };
            const [key, fallback] = map[tab] || map.local;
            modalDesc.setAttribute('data-i18n', key);
            modalDesc.textContent = i18n(key, fallback);
        }
        const modelLabel = document.getElementById('tag-model-select-label');
        if (modelLabel) {
            const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
            const key = tab === 'nl' ? 'tagger.nlSourceLabel' : 'modal.tagModel';
            modelLabel.setAttribute('data-i18n', key);
            modelLabel.textContent = i18n(key, tab === 'nl' ? 'Natural language source' : 'Model');
        }

        this.applyTaggerTab(tab);

        if (tab === 'nl') {
            // Bind radio listeners (idempotent) + apply current selection.
            this._bindNlSubToggleOnce();
            this._applyNlSubSource();
            this.refreshVLMBannerStatus();
        }
        if (tab === 'aesthetic') {
            this._refreshAestheticTab();
        }
        if (tab === 'color') {
            this._refreshColorTab();
        }
        try { window.VLMCaption?.syncWorkflowVisibility?.(); } catch (_e) {}
    },

    /** Wire the ToriiGate / VLM API radio toggle inside the Natural Language tab. */
    _bindNlSubToggleOnce() {
        if (this._nlSubToggleBound) return;
        this._nlSubToggleBound = true;
        const radios = document.querySelectorAll('input[name="tagger-nl-source"]');
        for (const r of radios) {
            r.addEventListener('change', () => this._applyNlSubSource());
        }
    },

    /** Sync NL tab content to the chosen sub-source.
     *  ToriiGate: hide VLM banner + utility strip, set dropdown to toriigate-0.5.
     *  VLM API:   hide ToriiGate setup card, set dropdown to vlm.
     */
    _applyNlSubSource() {
        const checked = document.querySelector('input[name="tagger-nl-source"]:checked');
        const source = checked?.value || 'toriigate';
        const select = document.getElementById('tag-model-select');

        const toriiCard = document.getElementById('tagger-nl-toriigate-card');
        const vlmBanner = document.getElementById('vlm-mode-banner');
        const vlmStrip = document.querySelector('#tag-modal .tagger-utility-strip');

        if (source === 'toriigate') {
            if (toriiCard) toriiCard.style.display = '';
            if (vlmBanner) vlmBanner.style.display = 'none';
            if (vlmStrip) vlmStrip.style.display = 'none';
            if (select) {
                const torii = Array.from(select.querySelectorAll('option'))
                    .find((o) => (o.value || '').toLowerCase().includes('toriigate'));
                if (torii) {
                    select.value = torii.value;
                    select.dispatchEvent(new Event('change'));
                }
            }
        } else {
            if (toriiCard) toriiCard.style.display = 'none';
            if (vlmBanner) vlmBanner.style.display = '';
            if (vlmStrip) vlmStrip.style.display = '';
            if (select) {
                const vlmOpt = select.querySelector('option[value="vlm"]');
                if (vlmOpt) {
                    select.value = 'vlm';
                    select.dispatchEvent(new Event('change'));
                }
            }
        }
        this._syncNlWorkflow(source);
        this.renderTaggerModelChoices();
        try { window.VLMCaption?.syncWorkflowVisibility?.(); } catch (_e) {}
    },

    _syncNlWorkflow(source) {
        const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
        const title = document.getElementById('tagger-nl-workflow-title');
        const hint = document.getElementById('tagger-nl-workflow-hint');
        const vlmStatus = document.getElementById('vlm-banner-current');
        const startBtn = document.getElementById('btn-start-tag');
        const toriiCard = document.getElementById('tagger-nl-toriigate-card');
        const vlmBanner = document.getElementById('vlm-mode-banner');
        const vlmStrip = document.querySelector('#tag-modal .tagger-utility-strip');

        if (source === 'vlm') {
            if (toriiCard) toriiCard.style.display = 'none';
            if (vlmBanner) vlmBanner.style.display = 'none';
            if (vlmStrip) vlmStrip.style.display = 'none';
            if (title) {
                title.setAttribute('data-i18n', 'tagger.nlVlmApiTitle');
                title.textContent = i18n('tagger.nlVlmApiTitle', 'VLM API (Cloud / Ollama / OpenRouter)');
            }
            if (hint) {
                hint.setAttribute('data-i18n', 'tagger.nlVlmApiHint');
                hint.textContent = i18n('tagger.nlVlmApiHint', 'Send images to a remote VLM endpoint. Configure provider + model in VLM Settings.');
            }
            if (vlmStatus) vlmStatus.style.display = '';
            if (startBtn && !startBtn.disabled) {
                startBtn.dataset.i18nLocked = '1';
                startBtn.textContent = i18n('vlm.utilityStart', 'Caption');
            }
        } else {
            if (toriiCard) toriiCard.style.display = '';
            if (vlmBanner) vlmBanner.style.display = 'none';
            if (vlmStrip) vlmStrip.style.display = 'none';
            if (title) {
                title.setAttribute('data-i18n', 'tagger.nlToriiTitle');
                title.textContent = i18n('tagger.nlToriiTitle', 'ToriiGate (local model)');
            }
            if (hint) {
                hint.setAttribute('data-i18n', 'tagger.nlToriiHint');
                hint.textContent = i18n('tagger.nlToriiHint', 'Heavy local VLM. Needs a one-time ~5 GB model download from the Setup page.');
            }
            if (vlmStatus) vlmStatus.style.display = 'none';
            if (startBtn && !startBtn.disabled) {
                startBtn.dataset.i18nLocked = '1';
                startBtn.textContent = i18n('modal.tagStart', 'Start Tagging');
            }
        }
    },

    /** Show/hide tab-keyed sections + filter the model dropdown to the right entries. */
    applyTaggerTab(tab, _opts = {}) {
        const modal = document.getElementById('tag-modal');
        if (!modal) return;
        const modelSelector = document.querySelector('#tag-modal .tagger-model-selector');
        if (modelSelector) {
            modelSelector.dataset.activeTab = tab;
        }
        this._syncModalActionsForTab(tab);

        // Toggle every element with data-tagger-shows.
        // The attribute is a space-separated list of tab ids ("local nl"), and
        // an element is visible only if that list contains the active tab.
        const candidates = modal.querySelectorAll('[data-tagger-shows]');
        for (const el of candidates) {
            const shows = (el.dataset.taggerShows || '').split(/\s+/).filter(Boolean);
            const visible = shows.includes(tab);
            el.style.display = visible ? '' : 'none';
        }
        try { window.VLMCaption?.syncWorkflowVisibility?.(); } catch (_e) {}

        // Filter the dropdown options based on tab.
        const select = document.getElementById('tag-model-select');
        if (select) {
            for (const opt of select.querySelectorAll('option')) {
                const value = (opt.value || '').toLowerCase();
                const isVlm = value === 'vlm';
                const isTorii = value.includes('toriigate');
                let allowed;
                if (tab === 'local') {
                    allowed = !isVlm && !isTorii;
                } else if (tab === 'nl') {
                    allowed = isVlm || isTorii;
                } else {
                    allowed = false;
                }
                opt.hidden = !allowed;
                opt.disabled = opt.disabled && !opt.dataset.allowedByTab;
            }
            // Hide empty optgroups whose options are all hidden.
            for (const og of select.querySelectorAll('optgroup')) {
                const visibleChildren = Array.from(og.querySelectorAll('option'))
                    .filter((o) => !o.hidden);
                og.hidden = visibleChildren.length === 0;
            }
            // If the current value is filtered out, fall back to the first
            // allowed value so the select.value stays meaningful.
            const currentOpt = select.querySelector(`option[value="${CSS.escape(select.value || '')}"]`);
            if (!currentOpt || currentOpt.hidden) {
                const firstAllowed = Array.from(select.querySelectorAll('option'))
                    .find((o) => !o.hidden && !o.disabled);
                if (firstAllowed) {
                    select.value = firstAllowed.value;
                    select.dispatchEvent(new Event('change'));
                }
            }
        }
        this.renderTaggerModelChoices();
    },

    _syncModalActionsForTab(tab) {
        const localActions = document.querySelectorAll('#tag-modal .tagger-local-action');
        for (const action of localActions) {
            action.style.display = tab === 'local' ? '' : 'none';
        }
        const startBtn = document.getElementById('btn-start-tag');
        if (startBtn && !startBtn.disabled) {
            const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
            if (tab === 'nl') {
                startBtn.dataset.i18nLocked = '1';
                const source = document.querySelector('input[name="tagger-nl-source"]:checked')?.value || 'toriigate';
                startBtn.textContent = source === 'vlm'
                    ? i18n('vlm.utilityStart', 'Caption')
                    : i18n('modal.tagStart', 'Start Tagging');
            } else {
                delete startBtn.dataset.i18nLocked;
                startBtn.textContent = i18n('modal.tagStart', 'Start Tagging');
            }
        }
    },

    /** Render the visible tagger model/source selector as dark in-app cards.
     *  The native select remains in the DOM as the canonical value owner for
     *  app.js, folder-browser.js, and existing E2E tests, but users no longer
     *  interact with an OS-themed dropdown that breaks the modal styling.
     */
    renderTaggerModelChoices() {
        const select = document.getElementById('tag-model-select');
        const list = document.getElementById('tag-model-choice-list');
        if (!select || !list) return;

        const activeTab = this.activeTaggerTab || 'local';
        const options = Array.from(select.querySelectorAll('option'))
            .filter((opt) => !opt.hidden && !opt.closest('optgroup[hidden]'));
        const currentValue = select.value || '';
        const localClosed = activeTab === 'local' && !this.localModelPickerOpen;
        list.hidden = localClosed;
        list.setAttribute('aria-hidden', localClosed ? 'true' : 'false');

        list.innerHTML = options.map((opt) => {
            const value = opt.value || '';
            const selected = value === currentValue;
            const disabled = opt.disabled;
            const title = this._getModelChoiceTitle(opt);
            const meta = this._getModelChoiceMeta(value, opt, activeTab);
            const badge = this._getModelChoiceBadge(value, opt, activeTab);
            const icon = this._getModelChoiceIcon(value, activeTab);
            const actionHtml = this._getModelChoiceActionHtml(value, activeTab, selected, disabled);
            return `
                <div
                    class="tagger-model-choice${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}"
                    role="radio"
                    tabindex="${disabled ? '-1' : '0'}"
                    aria-checked="${selected ? 'true' : 'false'}"
                    aria-disabled="${disabled ? 'true' : 'false'}"
                    data-model-value="${this._escapeAttr(value)}"
                >
                    <span class="tagger-model-choice-icon" aria-hidden="true">${this._escapeHtml(icon)}</span>
                    <span class="tagger-model-choice-copy">
                        <span class="tagger-model-choice-title">${this._escapeHtml(title)}</span>
                        ${badge ? `<span class="tagger-model-choice-badge">${this._escapeHtml(badge)}</span>` : ''}
                        ${meta ? `<span class="tagger-model-choice-meta">${this._escapeHtml(meta)}</span>` : ''}
                        ${actionHtml}
                    </span>
                </div>
            `;
        }).join('');

        for (const btn of list.querySelectorAll('.tagger-model-choice')) {
            const activate = () => {
                const value = btn.dataset.modelValue || '';
                const option = Array.from(select.querySelectorAll('option'))
                    .find((opt) => opt.value === value);
                if (!option || option.disabled) return;

                select.value = value;
                this._syncNlRadioFromModelValue(value);
                select.dispatchEvent(new Event('change'));
                if (activeTab === 'nl') {
                    const source = value === 'vlm' ? 'vlm' : 'toriigate';
                    this._syncNlWorkflow(source);
                    this.refreshVLMBannerStatus();
                    try { window.VLMCaption?.syncWorkflowVisibility?.(); } catch (_e) {}
                }
            };
            btn.addEventListener('click', (event) => {
                if (event.target?.closest?.('.tagger-model-choice-actions')) return;
                activate();
            });
            btn.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                activate();
            });
        }
        list.querySelector('#btn-tagger-toriigate-setup')?.addEventListener('click', (event) => {
            event.stopPropagation();
            this._openTaggerSetup?.('toriigate', 'tagger.routedToriigate');
        });
        list.querySelector('#btn-vlm-banner-settings')?.addEventListener('click', (event) => {
            event.stopPropagation();
            if (window.VLMCaption?.openSettingsModal) {
                window.VLMCaption.openSettingsModal();
            } else {
                document.getElementById('btn-vlm-settings')?.click();
            }
        });
        this._syncCurrentVisibleCopy();
    },

    _syncCurrentVisibleCopy() {
        const tab = this.activeTaggerTab || 'local';
        const modalDesc = document.querySelector('#tag-modal .modal-description');
        if (modalDesc) {
            const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
            const map = {
                local: ['modal.tagDescription', 'Pick a supported tagger model and generate tags for images.'],
                nl: ['tagger.modalDescNl', 'Choose a natural-language backend and caption selected images.'],
                aesthetic: ['tagger.modalDescAesthetic', 'Score selected images with the local aesthetic model.'],
            };
            const [key, fallback] = map[tab] || map.local;
            modalDesc.setAttribute('data-i18n', key);
            modalDesc.textContent = i18n(key, fallback);
        }
        const modelLabel = document.getElementById('tag-model-select-label');
        if (modelLabel) {
            const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
            const key = tab === 'nl' ? 'tagger.nlSourceLabel' : 'modal.tagModel';
            modelLabel.setAttribute('data-i18n', key);
            modelLabel.textContent = i18n(key, tab === 'nl' ? 'Natural language source' : 'Model');
        }
        this._syncLocalModelSummary();
        if (tab === 'nl') {
            const source = document.querySelector('input[name="tagger-nl-source"]:checked')?.value || 'toriigate';
            this._syncNlWorkflow(source);
        }
        this._syncModalActionsForTab(tab);
    },

    _syncLocalModelSummary() {
        const current = document.getElementById('tagger-model-current');
        const titleEl = document.getElementById('tagger-model-current-title');
        const metaEl = document.getElementById('tagger-model-current-meta');
        const actionEl = current?.querySelector('.tagger-model-current-action');
        const select = document.getElementById('tag-model-select');
        if (!current || !select) return;

        const isLocal = this.activeTaggerTab === 'local';
        current.hidden = !isLocal;
        current.setAttribute('aria-hidden', isLocal ? 'false' : 'true');
        current.setAttribute('aria-expanded', this.localModelPickerOpen ? 'true' : 'false');
        current.classList.toggle('is-open', this.localModelPickerOpen);
        if (!isLocal) return;

        const opt = select.selectedOptions?.[0] || select.querySelector(`option[value="${CSS.escape(select.value || '')}"]`);
        if (titleEl) {
            titleEl.textContent = opt ? this._getModelChoiceTitle(opt) : (select.value || '');
        }
        if (metaEl) {
            metaEl.textContent = opt ? this._getModelChoiceMeta(opt.value || '', opt, 'local') : '';
        }
        if (actionEl) {
            const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
            actionEl.textContent = this.localModelPickerOpen
                ? i18n('tagger.hideModelList', 'Hide list')
                : i18n('tagger.changeModel', 'Change model');
        }
    },

    syncVisibleTaggerCopy() {
        this._syncCurrentVisibleCopy();
        this.renderTaggerModelChoices();
    },

    _syncNlRadioFromModelValue(value) {
        if (this.activeTaggerTab !== 'nl') return;
        const source = value === 'vlm' ? 'vlm' : 'toriigate';
        const radio = document.querySelector(`input[name="tagger-nl-source"][value="${source}"]`);
        if (radio) radio.checked = true;
    },

    _getModelChoiceTitle(opt) {
        const value = opt?.value || '';
        if (value === 'vlm') {
            return window.I18n?.t?.('tagger.nlVlmApiTitle') || 'VLM API (Cloud / Ollama / OpenRouter)';
        }
        if (value.toLowerCase().includes('toriigate')) {
            return window.I18n?.t?.('tagger.nlToriiTitle') || 'ToriiGate (local model)';
        }
        return (opt?.textContent || value || 'Model')
            .replace(/\s+\(Recommended\)\s*$/i, '')
            .replace(/\s+\(Unavailable\)\s*$/i, '')
            .trim();
    },

    _getModelChoiceMeta(value, opt, activeTab) {
        const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
        const lower = String(value || '').toLowerCase();
        if (value === 'vlm') {
            return i18n('tagger.nlVlmApiHint', 'Send images to a remote VLM endpoint. Configure provider + model in VLM Settings.');
        }
        if (lower.includes('toriigate')) {
            return i18n('tagger.nlToriiHint', 'Heavy local VLM. Needs a one-time ~5 GB model download from the Setup page.');
        }
        if (activeTab === 'local' && value === 'custom') {
            return i18n('tagger.customSubtitle', 'Custom local ONNX tagger with a selectable model profile.');
        }
        const meta = window.getTaggerModelMetaForV321?.(value) || null;
        if (meta?.description || meta?.summary || meta?.best_for) {
            const parts = [];
            if (meta.description || meta.summary) parts.push(meta.description || meta.summary);
            if (meta.best_for) parts.push(meta.best_for);
            return parts.join(' · ');
        }
        return opt?.title || '';
    },

    _getModelChoiceBadge(value, opt, activeTab) {
        const text = opt?.textContent || '';
        const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
        if (opt?.disabled) return i18n('tagger.chipCatalogOnly', 'Catalog Only');
        if (value === 'vlm') return i18n('tagger.tierVlm', 'VLM');
        if (String(value || '').toLowerCase().includes('toriigate')) return i18n('tagger.chipPytorchCuda', 'PyTorch CUDA');
        if (text.includes('(Recommended)')) return i18n('tagger.badgeRecommended', 'Recommended');
        if (activeTab === 'local' && value === 'custom') return i18n('tagger.customBadge', 'Custom');
        return '';
    },

    _getModelChoiceIcon(value, activeTab) {
        const lower = String(value || '').toLowerCase();
        if (value === 'vlm') return '☁';
        if (lower.includes('toriigate')) return '◎';
        if (value === 'custom') return '⚙';
        return activeTab === 'nl' ? '◇' : '✓';
    },

    _getModelChoiceActionHtml(value, activeTab, selected, disabled) {
        if (activeTab !== 'nl' || !selected || disabled) return '';
        const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
        if (value === 'vlm') {
            return `
                <span class="tagger-model-choice-actions">
                    <button type="button" class="btn btn-secondary btn-small" id="btn-vlm-banner-settings">
                        <span aria-hidden="true">⚙️</span>
                        <span>${this._escapeHtml(i18n('vlm.openSettings', 'VLM Settings'))}</span>
                    </button>
                    <button type="button" class="btn btn-ghost btn-small" data-vlm-debug-chat>
                        <span aria-hidden="true">💬</span>
                        <span>${this._escapeHtml(i18n('vlm.debugChat', 'API Chat'))}</span>
                    </button>
                </span>
            `;
        }
        if (String(value || '').toLowerCase().includes('toriigate')) {
            return `
                <span class="tagger-model-choice-actions">
                    <button type="button" class="btn btn-secondary btn-small" id="btn-tagger-toriigate-setup">
                        <span aria-hidden="true">🛠️</span>
                        <span>${this._escapeHtml(i18n('tagger.aestheticOpenSetup', 'Open Setup to install'))}</span>
                    </button>
                </span>
            `;
        }
        return '';
    },

    _escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch]));
    },

    _escapeAttr(value) {
        return this._escapeHtml(value);
    },

    /** Read aesthetic readiness from the live backend status endpoint. */
    async _refreshAestheticTab() {
        const titleEl = document.getElementById('tagger-aesthetic-status-title');
        const setupBtn = document.getElementById('btn-tagger-aesthetic-setup');
        const startBtn = document.getElementById('btn-tagger-aesthetic-start');
        const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;

        // Optimistic "checking..." state while the request is in flight so the
        // user does not see a stale ready/missing message from the previous
        // open of the modal.
        if (titleEl) {
            titleEl.textContent = i18n('models.checking', 'Checking…');
        }
        if (startBtn) startBtn.disabled = true;

        let isReady = false;
        let message = '';
        try {
            const r = await fetch('/api/aesthetic/status', { cache: 'no-store' });
            if (r.ok) {
                const data = await r.json();
                isReady = Boolean(data?.available);
                message = data?.message || '';
            }
        } catch (_e) {
            isReady = false;
        }

        // Cache for other modules (e.g. gallery quick-score button).
        try { window._aestheticStatus = { available: isReady, message }; } catch (_e) {}

        if (titleEl) {
            const key = isReady ? 'tagger.aestheticReady' : 'tagger.aestheticMissing';
            titleEl.setAttribute('data-i18n', key);
            const fallback = isReady
                ? 'Aesthetic scoring is ready on this machine.'
                : 'Aesthetic scoring needs a one-time setup (~2 GB) to install runtimes and models.';
            titleEl.textContent = (message && !isReady) ? message : i18n(key, fallback);
        }
        if (setupBtn) setupBtn.style.display = isReady ? 'none' : '';
        if (startBtn) startBtn.disabled = !isReady;
    },

    /** v3.2.1 task #26: Color analysis tab — show counts and wire start/cancel. */
    async _refreshColorTab() {
        const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
        const titleEl = document.getElementById('tagger-color-status-title');
        const countsEl = document.getElementById('tagger-color-status-counts');
        const startBtn = document.getElementById('btn-tagger-color-start');
        const cancelBtn = document.getElementById('btn-tagger-color-cancel');

        let totalImages = 0;
        let missingCount = 0;
        let running = false;
        try {
            const [missingRes, progressRes] = await Promise.all([
                fetch('/api/colors/missing-count', { cache: 'no-store' }),
                fetch('/api/colors/progress', { cache: 'no-store' }),
            ]);
            if (missingRes.ok) {
                const data = await missingRes.json();
                missingCount = Number(data?.missing) || 0;
                totalImages = Number(data?.total) || 0;
            }
            if (progressRes.ok) {
                const data = await progressRes.json();
                running = Boolean(data?.running);
            }
        } catch (_e) {
            // Non-fatal — leave counts at 0.
        }

        if (titleEl) {
            const titleKey = missingCount > 0 ? 'tagger.colorMissing' : 'tagger.colorReady';
            const titleFallback = missingCount > 0
                ? `${missingCount.toLocaleString()} images need color analysis.`
                : 'All analyzed — color sorts and filters are ready.';
            titleEl.setAttribute('data-i18n', titleKey);
            titleEl.textContent = i18n(titleKey, '') || titleFallback;
        }

        if (countsEl) {
            if (totalImages > 0) {
                const analyzed = Math.max(totalImages - missingCount, 0);
                const lang = window.I18n?.getLang?.() === 'zh-CN' ? 'zh-CN' : 'en';
                countsEl.textContent = lang === 'zh-CN'
                    ? `已分析 ${analyzed.toLocaleString()} / ${totalImages.toLocaleString()}（剩余 ${missingCount.toLocaleString()}）`
                    : `Analyzed ${analyzed.toLocaleString()} of ${totalImages.toLocaleString()} (${missingCount.toLocaleString()} remaining)`;
            } else {
                countsEl.textContent = '';
            }
        }

        if (startBtn) {
            startBtn.disabled = running || missingCount === 0;
            startBtn.onclick = async () => {
                if (window.ColorBackfill?.startAnalysis) {
                    await window.ColorBackfill.startAnalysis();
                    // Refresh tab UI after kickoff so cancel button surfaces.
                    setTimeout(() => this._refreshColorTab(), 600);
                }
            };
        }
        if (cancelBtn) {
            cancelBtn.style.display = running ? '' : 'none';
            cancelBtn.onclick = async () => {
                if (window.ColorBackfill?.cancelAnalysis) {
                    await window.ColorBackfill.cancelAnalysis();
                    setTimeout(() => this._refreshColorTab(), 600);
                }
            };
        }
    },

    /** Add a temporary highlight to a model card so the user sees where to click. */
    _highlightModelCard(modelId) {
        if (!modelId) return;
        const tryHighlight = (attempt) => {
            const card = document.querySelector(`.model-card[data-model-id="${CSS.escape(modelId)}"]`);
            if (!card) {
                if (attempt < 12) setTimeout(() => tryHighlight(attempt + 1), 250);
                return;
            }
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('is-highlighted');
            setTimeout(() => card.classList.remove('is-highlighted'), 2400);
        };
        tryHighlight(0);
    },

    async refreshVLMBannerStatus() {
        const el = document.getElementById('vlm-banner-current');
        const legacyEl = document.getElementById('vlm-banner-current-legacy');
        if (!el) return;
        const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
        const setText = (text) => {
            el.textContent = text;
            if (legacyEl) legacyEl.textContent = text;
        };
        try {
            const res = await fetch('/api/vlm/settings');
            const s = await res.json();
            const provider = s.provider || 'openai_compat';
            const model = s.model || '—';
            const endpoint = s.endpoint || '—';
            if (s.api_key_display || s.endpoint) {
                setText(`${provider} · ${model} · ${endpoint}`);
            } else {
                setText(i18n('vlm.notConfigured', 'Not configured — click VLM Settings to set up'));
            }
        } catch (e) {
            setText(i18n('vlm.notConfigured', 'Not configured'));
        }
    },

    /** Intercept the Tag button click — when VLM is selected, route to VLM batch endpoint */
    interceptTagSubmit() {
        // Wait for app to bind original handler, then attach our pre-handler in capture phase
        // The actual button id in index.html is #btn-start-tag (not btn-start-tagging).
        const startBtn = document.getElementById('btn-start-tag');
        if (!startBtn) {
            // Try later
            setTimeout(() => this.interceptTagSubmit(), 500);
            return;
        }
        startBtn.addEventListener('click', (e) => {
            // vlmActive is owned by the dropdown value, NOT by the active tab.
            // The Natural Language tab can have either ToriiGate or VLM
            // selected; only VLM should route to the VLM batch endpoint.
            const select = document.getElementById('tag-model-select');
            const isVlm = select && select.value === 'vlm';
            if (!isVlm) return;  // local + ToriiGate paths run the regular tagger pipeline

            // VLM path
            e.stopPropagation();
            e.preventDefault();

            // Trigger VLM batch instead
            if (window.VLMCaption?.startBatchCaption) {
                window.VLMCaption.startBatchCaption();
            } else {
                document.getElementById('btn-vlm-start')?.click();
            }
        }, true);  // capture phase to fire before existing listeners
    },

    // ====================================================================
    // (B) LoRA preset selector in export modal
    // ====================================================================

    async bindExportPresetUI() {
        const contentSelect = document.getElementById('batch-export-content-mode');
        const grid = document.getElementById('batch-export-grid');
        if (!contentSelect || !grid) return;

        // Load presets
        try {
            const r = await fetch('/api/tags/export-presets');
            const data = await r.json();
            this.presets = data.presets || [];
            this.renderPresetGrid();
        } catch (e) {
            console.warn('Failed to load export presets', e);
        }

        // v3.2.1: the per-image preview grid is now visible for *every*
        // content mode, not just LoRA template. The LoRA-specific config
        // section (preset chips, trigger word, replace rules, etc.) is
        // tucked behind the same `#lora-template-section` and is only
        // revealed when content_mode='template'. The right preview pane
        // is always rendered so users can review and tweak captions per
        // image before exporting any format (tags / prompt / caption /
        // negative / a1111 / json / template).
        const updateVis = () => {
            const mode = contentSelect.value;
            grid.style.display = 'grid';
            grid.dataset.contentMode = mode || 'caption_merged';
            const loraSection = document.getElementById('lora-template-section');
            if (loraSection) {
                loraSection.style.display = mode === 'template' ? '' : 'none';
            }
            // Refresh preview when content mode changes
            this.refreshPreview();
        };
        contentSelect.addEventListener('change', updateVis);
        updateVis();

        // v3.2.1: Output destination chooser. Adds the "save next to image"
        // / "save to folder" semantics from the existing radio group, plus
        // a new "Copy combined to clipboard" / "Download single combined
        // file" path that absorbs the legacy #export-modal use cases.
        this.bindOutputDestinationUI();
    },

    /** Toggle output destination UI. Updates the Start button label so the
     *  user always knows what will happen (write sidecars / copy / download).
     */
    bindOutputDestinationUI() {
        const radios = document.querySelectorAll('input[name="batch-export-output-mode"]');
        if (!radios.length) return;
        const folderGroup = document.getElementById('batch-export-folder-group');
        const folderInput = document.getElementById('batch-export-folder');
        const startBtn = document.getElementById('btn-start-batch-export');
        const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;

        const sync = () => {
            const checked = document.querySelector('input[name="batch-export-output-mode"]:checked');
            const value = checked?.value || 'beside_image';
            // Folder UI only matters for "save to one folder" sidecar mode.
            if (folderGroup) folderGroup.style.display = (value === 'folder') ? '' : 'none';
            if (folderInput) folderInput.disabled = (value !== 'folder');

            // We deliberately do NOT mutate the Start button's innerHTML here.
            // ui-refresh.js owns that node and re-asserts its label on every
            // languageChanged event via _setButton, which would wipe any
            // override we made. The destination is already obvious from the
            // selected radio in the segmented-control above. The actual
            // dispatch (sidecar vs clipboard vs download) lives in
            // interceptCombinedExportClick — see below.
        };
        for (const r of radios) {
            r.addEventListener('change', sync);
        }
        sync();
    },

    renderPresetGrid() {
        const grid = document.getElementById('lora-preset-grid');
        const desc = document.getElementById('lora-preset-description');
        if (!grid) return;
        grid.innerHTML = '';
        for (const preset of this.presets) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'lora-preset-chip';
            if (preset.id === this.selectedPreset) chip.classList.add('active');
            chip.textContent = preset.name;
            chip.title = preset.description;
            chip.dataset.presetId = preset.id;
            chip.addEventListener('click', () => {
                this.selectedPreset = preset.id;
                grid.querySelectorAll('.lora-preset-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                if (desc) desc.textContent = preset.description || '';
                // Auto-fill template override hint
                const tpl = document.getElementById('lora-template-override');
                if (tpl && !tpl.value) tpl.placeholder = preset.template || tpl.placeholder;
                this.refreshPreview();
            });
            grid.appendChild(chip);
        }
        if (desc) {
            const cur = this.presets.find(p => p.id === this.selectedPreset);
            if (cur) desc.textContent = cur.description || '';
        }
    },

    /** Build template_options object from the current UI state */
    collectTemplateOptions() {
        const trigger = document.getElementById('lora-trigger-word')?.value || '';
        const templateOverride = document.getElementById('lora-template-override')?.value || '';
        const replaceRaw = document.getElementById('lora-replace-rules')?.value || '';
        const maxTags = parseInt(document.getElementById('lora-max-tags')?.value || '0') || 0;
        const appendText = document.getElementById('lora-append-text')?.value || '';
        const blacklistText = document.getElementById('batch-export-blacklist')?.value || '';

        const replace_rules = {};
        for (const line of replaceRaw.split('\n')) {
            const m = line.split('->');
            if (m.length >= 2 && m[0].trim()) {
                replace_rules[m[0].trim()] = m.slice(1).join('->').trim();
            }
        }

        const blacklist = blacklistText.split(',').map(s => s.trim()).filter(Boolean);
        const append = appendText.split(',').map(s => s.trim()).filter(Boolean);

        return {
            preset_id: this.selectedPreset,
            template_override: templateOverride || null,
            trigger,
            blacklist,
            replace_rules,
            max_tags: maxTags,
            append,
        };
    },

    // ====================================================================
    // (C) Live preview with per-image edit
    // ====================================================================

    bindLivePreview() {
        document.getElementById('btn-refresh-preview')?.addEventListener('click', () => this.refreshPreview());

        // v3.2.1 task #33: open / close the dedicated full-screen Caption Editor modal
        document.getElementById('btn-open-caption-editor')?.addEventListener('click', () => this.openCaptionEditor());
        document.getElementById('btn-close-caption-editor')?.addEventListener('click', () => this.closeCaptionEditor());
        document.getElementById('btn-caption-editor-done')?.addEventListener('click', () => this.closeCaptionEditor());
        document.getElementById('btn-caption-editor-refresh')?.addEventListener('click', () => this.refreshPreview());
        // Click outside the modal-content (on the backdrop) closes the editor.
        document.querySelector('#caption-editor-modal .modal-backdrop')?.addEventListener('click', () => this.closeCaptionEditor());

        // Refresh when trigger / template changes
        const watchIds = ['lora-trigger-word', 'lora-template-override', 'lora-max-tags',
            'lora-append-text', 'batch-export-prefix', 'batch-export-blacklist'];
        for (const id of watchIds) {
            const el = document.getElementById(id);
            if (el) {
                let timer = null;
                el.addEventListener('input', () => {
                    clearTimeout(timer);
                    timer = setTimeout(() => this.refreshPreview(), 600);
                });
            }
        }

        // v3.2.1 follow-up: refresh preview immediately when the user toggles
        // the LoRA underscore checkbox so they can see the difference in real
        // time. Also persist the choice so it survives modal close/reopen.
        const normalizeCheckbox = document.getElementById('batch-export-normalize-underscores');
        if (normalizeCheckbox) {
            try {
                const stored = localStorage.getItem('batchExport.normalizeUnderscores');
                if (stored === '0' || stored === 'false') normalizeCheckbox.checked = false;
                else if (stored === '1' || stored === 'true') normalizeCheckbox.checked = true;
            } catch (_) { /* localStorage unavailable, keep default */ }
            normalizeCheckbox.addEventListener('change', () => {
                try { localStorage.setItem('batchExport.normalizeUnderscores', normalizeCheckbox.checked ? '1' : '0'); } catch (_) { /* noop */ }
                this.refreshPreview();
            });
        }
    },

    /** v3.2.1 task #33: open the dedicated full-screen Caption Editor. */
    async openCaptionEditor() {
        const modal = document.getElementById('caption-editor-modal');
        if (!modal) return;
        modal.classList.add('visible');
        modal.style.display = 'flex';
        document.body.classList.add('modal-open');
        // If the inline preview hasn't been generated yet, fetch first; otherwise re-render in big container.
        if ((!this.queueImageIds || !this.queueImageIds.length) && (!this.previewResults || !this.previewResults.length)) {
            await this.refreshPreview();
        } else {
            this._renderPreviewWorkbench();
        }
        // P2-2 / P2-2b: keyboard shortcuts for caption editor
        this._captionEditorKeyHandler = (e) => this._handleCaptionEditorKey(e);
        document.addEventListener('keydown', this._captionEditorKeyHandler);
    },

    /** v3.2.1 task #33: close the editor. Edits are kept in this.editedCaptions. */
    closeCaptionEditor() {
        const modal = document.getElementById('caption-editor-modal');
        if (!modal) return;
        modal.classList.remove('visible');
        modal.style.display = '';
        if (!document.querySelector('.modal.visible')) {
            document.body.classList.remove('modal-open');
        }
        // Remove keyboard listener
        if (this._captionEditorKeyHandler) {
            document.removeEventListener('keydown', this._captionEditorKeyHandler);
            this._captionEditorKeyHandler = null;
        }
        // Re-render workbench in the small inline pane so the user sees their edits there too.
        this._renderPreviewWorkbench();
    },

    /** P2-2 / P2-2b: keyboard handler for caption editor modal */
    _handleCaptionEditorKey(e) {
        const modal = document.getElementById('caption-editor-modal');
        if (!modal || !modal.classList.contains('visible')) return;
        const inTextarea = e.target?.tagName === 'TEXTAREA' || e.target?.tagName === 'INPUT';

        if (e.key === 'Escape') {
            e.preventDefault();
            this.closeCaptionEditor();
            return;
        }
        // Ctrl+Enter / Cmd+Enter: save + next; Ctrl+Shift+Enter: save + prev
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            this._navigateQueue(e.shiftKey ? -1 : 1);
            return;
        }
        // ArrowUp/ArrowDown without Ctrl: navigate queue (only when not typing in textarea)
        if (!inTextarea && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            this._navigateQueue(e.key === 'ArrowUp' ? -1 : 1);
        }
    },

    /** Navigate to adjacent queue item by delta (-1 = prev, +1 = next) */
    _navigateQueue(delta) {
        const ids = this.queueImageIds;
        if (!ids.length) return;
        const curIdx = ids.indexOf(Number(this.activePreviewImageId));
        const nextIdx = Math.max(0, Math.min(ids.length - 1, curIdx + delta));
        const newId = ids[nextIdx];
        if (newId == null || newId === Number(this.activePreviewImageId)) return;
        this.activePreviewImageId = newId;
        this._onQueueItemClick(newId);
    },

    _getSelectionState() {
        const storeState = window.App?.SelectionStore?.getState?.();
        if (storeState) return storeState;
        const appState = window.App?.AppState;
        if (!appState) return null;
        return {
            selectedIds: appState.selectedIds,
            scope: appState.selectionScope,
            filterKey: appState.selectionFilterKey,
            selectionToken: appState.selectionToken,
            selectionTotal: appState.selectionTotal,
        };
    },

    _getExplicitSelectedImageIds(cap = Infinity) {
        const state = this._getSelectionState();
        const source = state?.selectedIds;
        const ids = source instanceof Set
            ? Array.from(source)
            : Array.isArray(source)
                ? source
                : Array.from(source || []);
        return ids
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0)
            .slice(0, cap);
    },

    _getActiveSelectionTokenForExport() {
        const state = this._getSelectionState();
        const token = state?.selectionToken;
        if ((state?.scope || 'visible') !== 'filtered' || !token) {
            return null;
        }
        if (typeof window.App?.isFilteredSelectionActiveForCurrentFilters === 'function') {
            return window.App.isFilteredSelectionActiveForCurrentFilters() ? token : null;
        }
        return token;
    },

    /** Load ALL selected image_ids for the queue (no cap). */
    async _loadQueueImageIds() {
        const selectionToken = this._getActiveSelectionTokenForExport();
        if (selectionToken && window.App?.API?.getSelectionChunk) {
            try {
                const allIds = [];
                const pageSize = 5000;
                let offset = 0;
                let done = false;
                while (!done) {
                    const chunk = await window.App.API.getSelectionChunk(selectionToken, { offset, limit: pageSize });
                    const ids = Array.isArray(chunk?.image_ids) ? chunk.image_ids : [];
                    for (const id of ids) {
                        const n = Number(id);
                        if (Number.isFinite(n) && n > 0) allIds.push(n);
                    }
                    if (ids.length < pageSize) done = true;
                    else offset += pageSize;
                }
                if (allIds.length) {
                    this.queueImageIds = allIds;
                    return allIds;
                }
            } catch (error) {
                console.warn('Could not resolve filtered selection queue ids', error);
            }
        }
        const selectedIds = this._getExplicitSelectedImageIds(Infinity);
        if (selectedIds.length) {
            this.queueImageIds = selectedIds;
            return selectedIds;
        }
        const items = document.querySelectorAll('.gallery-item[data-id]');
        const fallback = Array.from(items).map(el => parseInt(el.dataset.id)).filter(n => !isNaN(n));
        this.queueImageIds = fallback;
        return fallback;
    },

    async refreshPreview() {
        // v3.2.1 task #33: target the editor modal's container if it's open
        const editorOpen = document.getElementById('caption-editor-modal')?.classList.contains('visible');
        const targetId = editorOpen ? 'caption-editor-list' : 'export-preview-list';
        const list = document.getElementById(targetId);
        if (!list) return;

        const contentMode = document.getElementById('batch-export-content-mode')?.value;
        const ids = await this._loadQueueImageIds();
        this.queueTotalCount = ids.length;
        if (!ids.length) {
            list.style.display = 'block';
            list.innerHTML = '<p style="padding:12px;text-align:center;color:var(--text-muted)">No images selected. Select images in Gallery first.</p>';
            return;
        }

        const opts = this._previewOptionsForContentMode(contentMode);

        list.style.display = 'block';
        list.innerHTML = '<p style="padding:8px;color:var(--text-muted)">Rendering preview…</p>';

        // Set active image if not already in queue
        if (!this.activePreviewImageId || !ids.includes(Number(this.activePreviewImageId))) {
            this.activePreviewImageId = ids[0] || null;
        }

        // Fetch captions for a small initial batch via export-preview (also gives us metadata)
        const initialBatch = ids.slice(0, 50);
        try {
            const r = await fetch('/api/tags/export-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_ids: initialBatch, ...opts }),
            });
            if (!r.ok) {
                list.innerHTML = `<p style="padding:8px;color:var(--accent-danger)">Preview failed: HTTP ${r.status}</p>`;
                return;
            }
            const data = await r.json();
            for (const item of (data.results || [])) {
                this.previewCache.set(item.image_id, item.rendered || '');
                this.previewMetadata.set(item.image_id, { filename: item.filename || '', thumbnail_path: item.thumbnail_path || '' });
            }
        } catch (e) {
            list.innerHTML = `<p style="padding:8px;color:var(--accent-danger)">Preview error: ${e.message}</p>`;
            return;
        }

        // Build legacy previewResults for compat with diagnostics/common-tags
        this.previewResults = initialBatch.map(id => {
            const meta = this.previewMetadata.get(id);
            return { image_id: id, filename: meta?.filename || '', rendered: this.previewCache.get(id) || '' };
        });

        this._renderPreviewWorkbench();
    },

    /** For non-template content modes, give a quick template that approximates the same output. */
    _fallbackTemplateForMode(mode) {
        switch (mode) {
            case 'tags': return '{tags:filtered}';
            case 'prompt': return '{prompt}';
            case 'negative': return '{negative}';
            case 'nl_caption': return '{nl_caption}';
            case 'tags_nl': return '{tags:filtered}, {nl_caption}';
            case 'prompt_nl': return '{prompt}\n{nl_caption}';
            case 'caption_tags': return '{nl_caption}, {tags:filtered}';
            case 'caption_merged': return '{nl_caption}, {prompt}, {tags:filtered}';
            default: return '{tags:filtered}';
        }
    },

    _previewOptionsForContentMode(contentMode) {
        // v3.2.1 follow-up: read the underscore checkbox once so both
        // template and non-template preview paths agree with the actual
        // export. The checkbox is the single source of truth for the
        // LoRA-friendly underscore convention.
        const normalizeCheckbox = document.getElementById('batch-export-normalize-underscores');
        const normalize = normalizeCheckbox ? normalizeCheckbox.checked : true;
        const danbooruTagModes = new Set(['tags', 'caption_tags', 'caption_merged', 'tags_nl']);
        const wantsNormalization = normalize && danbooruTagModes.has(contentMode);

        if (contentMode === 'template') {
            const opts = this.collectTemplateOptions();
            // For template mode the preset itself decides; only override
            // when the user explicitly toggles the checkbox to FALSE
            // (forces raw underscores for Pony / NoobAI workflows).
            if (!normalize) {
                opts.underscore_to_space_override = false;
                opts.preserve_underscore_prefixes_override = ['score_'];
            }
            return opts;
        }
        const blacklistText = document.getElementById('batch-export-blacklist')?.value || '';
        const prefix = document.getElementById('batch-export-prefix')?.value || '';
        const blacklist = blacklistText.split(',').map(s => s.trim()).filter(Boolean);
        const template = this._fallbackTemplateForMode(contentMode);
        const opts = {
            preset_id: 'custom',
            template_override: prefix && (contentMode === 'caption_tags' || contentMode === 'caption_merged' || contentMode === 'nl_caption' || contentMode === 'tags_nl' || contentMode === 'prompt_nl')
                ? `{trigger}, ${template}`
                : template,
            trigger: prefix,
            blacklist,
            replace_rules: {},
            max_tags: 0,
            append: [],
        };
        if (wantsNormalization) {
            opts.underscore_to_space_override = true;
            opts.preserve_underscore_prefixes_override = ['score_'];
        } else if (!normalize && danbooruTagModes.has(contentMode)) {
            opts.underscore_to_space_override = false;
            opts.preserve_underscore_prefixes_override = ['score_'];
        }
        return opts;
    },

    renderPreviewList(results) {
        const list = document.getElementById('export-preview-list');
        if (!list) return;
        this.previewResults = Array.isArray(results) ? results : [];
        // Populate metadata cache from results
        for (const item of this.previewResults) {
            const id = Number(item.image_id);
            this.previewMetadata.set(id, { filename: item.filename || '', thumbnail_path: item.thumbnail_path || '' });
            if (item.rendered) this.previewCache.set(id, item.rendered);
        }
        // If queueImageIds not yet populated, use results order
        if (!this.queueImageIds.length) {
            this.queueImageIds = this.previewResults.map(item => Number(item.image_id)).filter(id => Number.isFinite(id));
            this.queueTotalCount = this.queueImageIds.length;
        }
        const ids = this.queueImageIds;
        if (!ids.includes(Number(this.activePreviewImageId))) {
            this.activePreviewImageId = ids[0] || null;
        }
        this._renderPreviewWorkbench();
    },

    _renderPreviewWorkbench() {
        // v3.2.1 task #33: when the dedicated Caption Editor modal is open we
        // render the workbench INSIDE that modal instead of the small inline
        // preview, so the editor textarea has plenty of room. The inline
        // preview pane stays cleared while the editor is open to avoid
        // confusing dual UIs.
        const editorOpen = document.getElementById('caption-editor-modal')?.classList.contains('visible');
        const targetId = editorOpen ? 'caption-editor-list' : 'export-preview-list';
        const list = document.getElementById(targetId);
        if (!list) return;
        list.innerHTML = '';

        // Also clear the OTHER container so we don't end up with duplicate stale workbenches.
        const otherId = editorOpen ? 'export-preview-list' : 'caption-editor-list';
        const otherList = document.getElementById(otherId);
        if (otherList) {
            if (editorOpen) {
                // While editor is open, hint the user that edits live in the popup.
                otherList.innerHTML = `<p style="padding:12px;text-align:center;color:var(--text-muted)">${this._i18n('batchExport.editorOpenHint', 'Editing in the Caption Editor window — close it to return.')}</p>`;
            } else {
                otherList.innerHTML = '';
            }
        }

        const hasItems = this.queueImageIds.length || this.previewResults.length;
        if (!hasItems) {
            list.innerHTML = '<p style="padding:12px;text-align:center;color:var(--text-muted)">No preview rows.</p>';
            return;
        }

        const workbench = document.createElement('div');
        workbench.className = 'export-preview-workbench';
        if (editorOpen) {
            workbench.classList.add('export-preview-workbench--full');
        }
        workbench.append(
            this._buildPreviewQueue(),
            this._buildPreviewEditor(),
            this._buildPreviewTools(),
        );
        const note = document.createElement('div');
        note.className = 'export-preview-save-note';
        note.textContent = this._i18n(
            'batchExport.previewTemporaryNote',
            'Temporary edits: nothing is auto-saved to images or the database. Export / Copy / Download uses these edits.'
        );
        list.append(note, workbench);
    },

    _getPreviewItem(imageId = this.activePreviewImageId) {
        const id = Number(imageId);
        // Try metadata Map first (virtual scroll path)
        const meta = this.previewMetadata.get(id);
        if (meta) return { image_id: id, filename: meta.filename || '', thumbnail_path: meta.thumbnail_path || '', rendered: this.previewCache.get(id) || '' };
        // Legacy array fallback
        const found = this.previewResults.find((item) => Number(item.image_id) === id);
        if (found) return found;
        // Fallback to first item
        if (this.queueImageIds.length) {
            const firstId = this.queueImageIds[0];
            const firstMeta = this.previewMetadata.get(firstId);
            if (firstMeta) return { image_id: firstId, filename: firstMeta.filename || '', thumbnail_path: firstMeta.thumbnail_path || '', rendered: this.previewCache.get(firstId) || '' };
        }
        return this.previewResults[0] || null;
    },

    _getRenderedCaption(imageId) {
        const id = Number(imageId);
        if (this.editedCaptions.has(id)) return this.editedCaptions.get(id) || '';
        return this.previewCache.get(id) || this._getPreviewItem(id)?.rendered || '';
    },

    _setPreviewCaption(imageId, value) {
        const id = Number(imageId);
        const text = String(value || '');
        const auto = this.previewCache.get(id) || '';
        if (text !== auto) {
            this.editedCaptions.set(id, text);
        } else {
            this.editedCaptions.delete(id);
        }
    },

    _splitCaptionTokens(value) {
        return String(value || '')
            .replace(/\n/g, ',')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
    },

    _joinCaptionTokens(tokens) {
        const seen = new Set();
        const output = [];
        for (const raw of tokens || []) {
            const token = String(raw || '').trim();
            if (!token) continue;
            const key = token.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            output.push(token);
        }
        return output.join(', ');
    },

    _normalizeCaptionToken(token) {
        return String(token || '').split(/\s+/).join(' ').trim().toLowerCase();
    },

    _getBlacklistTokens() {
        const raw = document.getElementById('batch-export-blacklist')?.value || '';
        return raw.split(',').map((part) => part.trim()).filter(Boolean);
    },

    _getLoraBoilerplateTokens() {
        return [
            'newest', 'highres', 'normal quality',
            'score_1', 'score_2', 'score_3', 'score_4', 'score_5', 'score_6', 'score_7', 'score_8', 'score_9',
            'safe', 'sensitive', 'questionable', 'explicit',
            'rating_safe', 'rating_sensitive', 'rating_questionable', 'rating_explicit',
        ];
    },

    _applyTokenToCaption(imageId, token, mode) {
        const clean = String(token || '').trim();
        if (!clean) return;
        const id = Number(imageId);
        const tokens = this._splitCaptionTokens(this._getRenderedCaption(id));
        const key = clean.toLowerCase();
        const next = mode === 'remove'
            ? tokens.filter((part) => part.toLowerCase() !== key)
            : [...tokens, clean];
        this._setPreviewCaption(id, this._joinCaptionTokens(next));
    },

    _applyTokenToAll(token, mode) {
        const ids = this.queueImageIds.length ? this.queueImageIds : this.previewResults.map(item => Number(item.image_id));
        for (const id of ids) {
            this._applyTokenToCaption(id, token, mode);
        }
        this._renderPreviewWorkbench();
    },

    _cleanupPreviewCaption(imageId, options = {}) {
        const id = Number(imageId);
        let tokens = this._splitCaptionTokens(this._getRenderedCaption(id));
        const removeSet = new Set();
        if (options.blacklist) {
            for (const token of this._getBlacklistTokens()) removeSet.add(this._normalizeCaptionToken(token));
        }
        if (options.boilerplate) {
            for (const token of this._getLoraBoilerplateTokens()) removeSet.add(this._normalizeCaptionToken(token));
        }
        if (removeSet.size) {
            tokens = tokens.filter((token) => !removeSet.has(this._normalizeCaptionToken(token)));
        }
        if (options.dedupe || removeSet.size) {
            this._setPreviewCaption(id, this._joinCaptionTokens(tokens));
        }
    },

    _cleanupAllPreviewCaptions(options = {}) {
        const ids = this.queueImageIds.length ? this.queueImageIds : this.previewResults.map(item => Number(item.image_id));
        for (const id of ids) {
            this._cleanupPreviewCaption(id, options);
        }
        this._renderPreviewWorkbench();
    },

    async _copyCurrentPreviewCaption() {
        const active = this._getPreviewItem();
        if (!active) return;
        const text = this._getRenderedCaption(active.image_id);
        try {
            await navigator.clipboard.writeText(text);
            window.showToast?.(
                this._i18n('batchExport.copyCurrentCaptionDone', 'Current caption copied.'),
                'success'
            );
        } catch (error) {
            window.showToast?.(
                this._i18n('batchExport.copyCurrentCaptionFailed', 'Could not copy the current caption.'),
                'error'
            );
        }
    },

    _resetPreviewCaption(imageId) {
        this.editedCaptions.delete(Number(imageId));
        this._renderPreviewWorkbench();
    },

    _resetAllPreviewCaptions() {
        const ids = this.queueImageIds.length ? this.queueImageIds : this.previewResults.map(item => Number(item.image_id));
        for (const id of ids) {
            this.editedCaptions.delete(Number(id));
        }
        this._renderPreviewWorkbench();
    },

    collectEditedCaptionOverrides() {
        const overrides = {};
        for (const [id, text] of this.editedCaptions.entries()) {
            const numericId = Number(id);
            if (Number.isFinite(numericId) && numericId > 0) {
                overrides[numericId] = String(text || '');
            }
        }
        return Object.keys(overrides).length ? overrides : null;
    },

    _buildPreviewQueue() {
        const queue = document.createElement('div');
        queue.className = 'export-preview-queue';

        const head = document.createElement('div');
        head.className = 'export-preview-panel-head';
        const total = this.queueTotalCount || this.queueImageIds.length || this.previewResults.length;
        head.innerHTML = `<strong>${this._i18n('batchExport.previewQueue', 'Images')}</strong><span class="export-queue-count${total > 1000 ? ' export-queue-count--warn' : ''}">${total} images</span>`;
        queue.appendChild(head);

        const body = document.createElement('div');
        body.className = 'export-preview-queue-list';

        const ids = this.queueImageIds.length ? this.queueImageIds : this.previewResults.map(r => Number(r.image_id));
        const ITEM_HEIGHT = 60;

        // Virtual scroll: only render visible items
        const spacer = document.createElement('div');
        spacer.style.height = `${ids.length * ITEM_HEIGHT}px`;
        spacer.style.position = 'relative';

        const renderVisible = () => {
            const scrollTop = body.scrollTop;
            const viewHeight = body.clientHeight || 400;
            const startIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT));
            const endIdx = Math.min(startIdx + Math.ceil(viewHeight / ITEM_HEIGHT) + 2, ids.length);

            spacer.innerHTML = '';
            for (let i = startIdx; i < endIdx; i++) {
                const imageId = ids[i];
                const btn = this._buildQueueItem(imageId, i);
                btn.style.position = 'absolute';
                btn.style.top = `${i * ITEM_HEIGHT}px`;
                btn.style.left = '0';
                btn.style.right = '0';
                btn.style.height = `${ITEM_HEIGHT}px`;
                spacer.appendChild(btn);
            }

            // Prefetch metadata for visible items that are missing
            const visibleIds = ids.slice(startIdx, endIdx).filter(id => !this.previewMetadata.has(id));
            if (visibleIds.length) this._fetchQueueMetadata(visibleIds).then(() => renderVisible());
        };

        body.addEventListener('scroll', renderVisible);
        body.appendChild(spacer);
        queue.appendChild(body);

        requestAnimationFrame(renderVisible);
        this._queueScrollContainer = body;
        this._queueRenderVisible = renderVisible;
        return queue;
    },

    _buildQueueItem(imageId, index) {
        const id = Number(imageId);
        const meta = this.previewMetadata.get(id);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'export-preview-queue-item';
        if (id === Number(this.activePreviewImageId)) btn.classList.add('active');
        if (this.editedCaptions.has(id)) btn.classList.add('edited');
        btn.dataset.imageId = String(id);

        if (meta) {
            const img = this._createPreviewThumb({ image_id: id, filename: meta.filename }, 96);
            const copy = document.createElement('span');
            copy.className = 'export-preview-queue-copy';
            copy.innerHTML = `<span></span><strong></strong><small></small>`;
            copy.querySelector('span').textContent = `#${id}`;
            copy.querySelector('strong').textContent = meta.filename || '';
            copy.querySelector('small').textContent = this.editedCaptions.has(id)
                ? this._i18n('batchExport.previewEdited', 'Edited')
                : this._i18n('batchExport.previewGenerated', 'Generated');
            btn.append(img, copy);
        } else {
            const placeholder = document.createElement('span');
            placeholder.className = 'export-preview-queue-copy';
            placeholder.innerHTML = `<span>#${id}</span><strong>Loading…</strong><small></small>`;
            btn.appendChild(placeholder);
        }

        btn.addEventListener('click', () => {
            this.activePreviewImageId = id;
            this._onQueueItemClick(id);
        });
        return btn;
    },

    async _onQueueItemClick(imageId) {
        const id = Number(imageId);
        // Ensure metadata is available
        if (!this.previewMetadata.has(id)) {
            await this._fetchQueueMetadata([id]);
        }
        // Fetch caption if not cached
        const contentMode = document.getElementById('batch-export-content-mode')?.value;
        const opts = this._previewOptionsForContentMode(contentMode);
        await this._fetchCaptionForImage(id, opts);
        this._renderPreviewWorkbench();
    },

    async _fetchCaptionForImage(imageId, opts) {
        const id = Number(imageId);
        if (this.previewCache.has(id)) return this.previewCache.get(id);
        if (!opts) {
            const contentMode = document.getElementById('batch-export-content-mode')?.value;
            opts = this._previewOptionsForContentMode(contentMode);
        }
        try {
            const r = await fetch('/api/tags/export-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_ids: [id], ...opts }),
            });
            if (!r.ok) return '';
            const data = await r.json();
            for (const item of (data.results || [])) {
                this.previewCache.set(item.image_id, item.rendered || '');
                if (item.filename && !this.previewMetadata.has(item.image_id)) {
                    this.previewMetadata.set(item.image_id, { filename: item.filename, thumbnail_path: item.thumbnail_path || '' });
                }
            }
            return this.previewCache.get(id) || '';
        } catch (e) {
            console.warn('_fetchCaptionForImage failed', e);
            return '';
        }
    },

    async _fetchQueueMetadata(imageIds) {
        if (!imageIds.length) return;
        // Filter out already-cached IDs
        const needed = imageIds.filter(id => !this.previewMetadata.has(id));
        if (!needed.length) return;
        // Use export-preview to get metadata (filename) — it's the only endpoint
        // guaranteed to return filename without triggering individual detail requests
        const contentMode = document.getElementById('batch-export-content-mode')?.value;
        const opts = this._previewOptionsForContentMode(contentMode);
        try {
            const batch = needed.slice(0, 50);
            const r = await fetch('/api/tags/export-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_ids: batch, ...opts }),
            });
            if (r.ok) {
                const data = await r.json();
                for (const item of (data.results || [])) {
                    this.previewMetadata.set(item.image_id, { filename: item.filename || '', thumbnail_path: item.thumbnail_path || '' });
                    if (item.rendered && !this.previewCache.has(item.image_id)) {
                        this.previewCache.set(item.image_id, item.rendered);
                    }
                }
            }
        } catch (e) {
            // Graceful fallback
        }
        // Set placeholder for any still-missing
        for (const id of needed) {
            if (!this.previewMetadata.has(id)) {
                this.previewMetadata.set(id, { filename: `Image ${id}`, thumbnail_path: '' });
            }
        }
    },

    _buildPreviewEditor() {
        const item = this._getPreviewItem();
        const panel = document.createElement('div');
        panel.className = 'export-preview-editor';
        if (!item) return panel;
        const id = Number(item.image_id);
        const caption = this._getRenderedCaption(id);

        const top = document.createElement('div');
        top.className = 'export-preview-current';
        top.appendChild(this._createPreviewThumb(item, 220));

        const meta = document.createElement('div');
        meta.className = 'export-preview-current-meta';
        const edited = this.editedCaptions.has(id);
        meta.innerHTML = `
            <span>${this._i18n('batchExport.previewCurrent', 'Current image')}</span>
            <strong></strong>
            <small>#${id}</small>
        `;
        meta.querySelector('strong').textContent = item.filename || '';
        if (edited) {
            const badge = document.createElement('em');
            badge.className = 'export-preview-edited-badge';
            badge.textContent = this._i18n('batchExport.previewEditedWillExport', 'Edited for export');
            meta.appendChild(badge);
        }
        top.appendChild(meta);

        const helper = document.createElement('p');
        helper.className = 'export-preview-editor-helper';
        helper.textContent = this._i18n(
            'batchExport.previewWorkbenchHelper',
            'Edit this caption here. Queue items marked Edited are used only when you export, copy, or download.'
        );

        const textarea = document.createElement('textarea');
        textarea.className = 'export-preview-textarea export-preview-main-textarea';
        if (edited) textarea.classList.add('edited');
        textarea.dataset.imageId = String(id);
        textarea.value = caption;
        textarea.addEventListener('input', () => {
            this._setPreviewCaption(id, textarea.value);
            textarea.classList.toggle('edited', this.editedCaptions.has(id));
        });
        textarea.addEventListener('blur', () => this._renderPreviewWorkbench());

        const chips = document.createElement('div');
        chips.className = 'export-preview-token-list';
        for (const token of this._splitCaptionTokens(caption)) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'export-preview-token';
            chip.title = this._i18n('batchExport.removeFromCurrent', 'Remove from current');
            chip.textContent = `${token} ×`;
            chip.addEventListener('click', () => {
                this._applyTokenToCaption(id, token, 'remove');
                this._renderPreviewWorkbench();
            });
            chips.appendChild(chip);
        }

        const actions = document.createElement('div');
        actions.className = 'export-preview-editor-actions';
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'btn btn-small btn-ghost';
        reset.textContent = this._i18n('batchExport.resetCurrentPreview', 'Reset current');
        reset.addEventListener('click', () => this._resetPreviewCaption(id));
        const resetAll = document.createElement('button');
        resetAll.type = 'button';
        resetAll.className = 'btn btn-small btn-ghost';
        resetAll.textContent = this._i18n('batchExport.resetAllPreview', 'Reset all');
        resetAll.addEventListener('click', () => this._resetAllPreviewCaptions());
        actions.append(reset, resetAll);

        panel.append(top, helper, textarea, chips, actions);
        return panel;
    },

    _buildPreviewTools() {
        const panel = document.createElement('div');
        panel.className = 'export-preview-tools';

        const common = this._getCommonPreviewTokens();
        const head = document.createElement('div');
        head.className = 'export-preview-panel-head';
        head.innerHTML = `<strong>${this._i18n('batchExport.commonTags', 'Common tags')}</strong><span>${common.length}</span>`;

        const helper = document.createElement('p');
        helper.className = 'export-preview-tools-helper';
        helper.textContent = this._i18n(
            'batchExport.commonTagsHelper',
            'Tags shared by preview images. Click a tag to add it to the current caption.'
        );

        const commonList = document.createElement('div');
        commonList.className = 'export-preview-common-tags';
        for (const item of common.slice(0, 80)) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'export-preview-common-tag';
            chip.title = this._i18n('batchExport.addToCurrent', 'Add to current');
            chip.innerHTML = `<span></span><small>${item.count}</small>`;
            chip.querySelector('span').textContent = item.token;
            chip.addEventListener('click', () => {
                const active = this._getPreviewItem();
                if (!active) return;
                this._applyTokenToCaption(active.image_id, item.token, 'add');
                this._renderPreviewWorkbench();
            });
            commonList.appendChild(chip);
        }
        if (!common.length) {
            const empty = document.createElement('p');
            empty.className = 'export-preview-empty-tools';
            empty.textContent = this._i18n('batchExport.noCommonTags', 'No tags');
            commonList.appendChild(empty);
        }

        const diagnostics = this._buildPreviewDiagnostics();
        const cleanup = this._buildPreviewCleanupTools();

        const form = document.createElement('div');
        form.className = 'export-preview-tag-form';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'input-field';
        input.id = 'export-preview-tag-input';
        input.placeholder = this._i18n('batchExport.tagToolPlaceholder', 'tag to add or remove');
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const active = this._getPreviewItem();
            if (!active) return;
            this._applyTokenToCaption(active.image_id, input.value, 'add');
            input.value = '';
            this._renderPreviewWorkbench();
        });

        const addCurrent = this._toolButton('batchExport.addToCurrent', 'Add', () => {
            const active = this._getPreviewItem();
            if (!active) return;
            this._applyTokenToCaption(active.image_id, input.value, 'add');
            input.value = '';
            this._renderPreviewWorkbench();
        });
        const removeCurrent = this._toolButton('batchExport.removeFromCurrent', 'Remove', () => {
            const active = this._getPreviewItem();
            if (!active) return;
            this._applyTokenToCaption(active.image_id, input.value, 'remove');
            input.value = '';
            this._renderPreviewWorkbench();
        });
        const addAll = this._toolButton('batchExport.addToAllPreview', 'Add all', () => {
            this._applyTokenToAll(input.value, 'add');
            input.value = '';
        });
        const removeAll = this._toolButton('batchExport.removeFromAllPreview', 'Remove all', () => {
            this._applyTokenToAll(input.value, 'remove');
            input.value = '';
        });
        form.append(input, addCurrent, removeCurrent, addAll, removeAll);

        panel.append(head, helper, commonList, diagnostics, cleanup, form);
        return panel;
    },

    _toolButton(key, fallback, handler, options = {}) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = options.className || 'btn btn-small btn-secondary';
        btn.dataset.i18nKey = key;
        if (options.tool) btn.dataset.previewTool = options.tool;
        btn.textContent = this._i18n(key, fallback);
        btn.addEventListener('click', handler);
        return btn;
    },

    _buildPreviewDiagnostics() {
        const metrics = this._getPreviewDiagnostics();
        const section = document.createElement('div');
        section.className = 'export-preview-checks';
        const title = document.createElement('strong');
        title.textContent = this._i18n('batchExport.previewChecks', 'Checks');
        const grid = document.createElement('div');
        grid.className = 'export-preview-stat-grid';
        const rows = [
            ['batchExport.previewEditedCount', 'Edited', `${metrics.edited}/${metrics.total}`, metrics.edited > 0],
            ['batchExport.previewEmptyCount', 'Empty', String(metrics.empty), metrics.empty > 0],
            ['batchExport.previewBlockedCount', 'Blacklist hits', String(metrics.blockedHits), metrics.blockedHits > 0],
            ['batchExport.previewDuplicateCount', 'Duplicates', String(metrics.duplicateHits), metrics.duplicateHits > 0],
            ['batchExport.previewMaxTokens', 'Max tokens', String(metrics.maxTokens), metrics.maxTokens > 75],
        ];
        for (const [key, label, value, warn] of rows) {
            const stat = document.createElement('div');
            stat.className = 'export-preview-stat';
            if (warn) stat.classList.add('warn');
            stat.innerHTML = `<span></span><strong></strong>`;
            stat.querySelector('span').textContent = this._i18n(key, label);
            stat.querySelector('strong').textContent = value;
            grid.appendChild(stat);
        }
        section.append(title, grid);
        return section;
    },

    _buildPreviewCleanupTools() {
        const section = document.createElement('div');
        section.className = 'export-preview-cleanup';
        const title = document.createElement('strong');
        title.textContent = this._i18n('batchExport.previewCleanupTools', 'Cleanup');
        const grid = document.createElement('div');
        grid.className = 'export-preview-cleanup-grid';
        const activeId = () => this._getPreviewItem()?.image_id;
        const addRow = (labelKey, labelFallback, currentKey, currentFallback, currentTool, currentHandler, allKey, allFallback, allTool, allHandler) => {
            const row = document.createElement('div');
            row.className = 'export-preview-cleanup-row';
            const label = document.createElement('span');
            label.textContent = this._i18n(labelKey, labelFallback);
            row.append(
                label,
                this._toolButton(currentKey, currentFallback, currentHandler, {
                    className: 'btn btn-small btn-ghost',
                    tool: currentTool,
                }),
                this._toolButton(allKey, allFallback, allHandler, {
                    className: 'btn btn-small btn-ghost',
                    tool: allTool,
                }),
            );
            grid.appendChild(row);
        };
        addRow('batchExport.cleanupDedupeLabel', 'Dedupe', 'batchExport.cleanupCurrent', 'Current', 'dedupe-current', () => {
            const id = activeId();
            if (!id) return;
            this._cleanupPreviewCaption(id, { dedupe: true });
            this._renderPreviewWorkbench();
        }, 'batchExport.cleanupAll', 'All', 'dedupe-all', () => this._cleanupAllPreviewCaptions({ dedupe: true }));
        addRow('batchExport.cleanupBlacklistLabel', 'Blacklist', 'batchExport.cleanupCurrent', 'Current', 'blacklist-current', () => {
            const id = activeId();
            if (!id) return;
            this._cleanupPreviewCaption(id, { blacklist: true, dedupe: true });
            this._renderPreviewWorkbench();
        }, 'batchExport.cleanupAll', 'All', 'blacklist-all', () => this._cleanupAllPreviewCaptions({ blacklist: true, dedupe: true }));
        addRow('batchExport.cleanupBoilerplateLabel', 'Quality/rating', 'batchExport.cleanupCurrent', 'Current', 'boilerplate-current', () => {
            const id = activeId();
            if (!id) return;
            this._cleanupPreviewCaption(id, { boilerplate: true, dedupe: true });
            this._renderPreviewWorkbench();
        }, 'batchExport.cleanupAll', 'All', 'boilerplate-all', () => this._cleanupAllPreviewCaptions({ boilerplate: true, dedupe: true }));
        const copyRow = document.createElement('div');
        copyRow.className = 'export-preview-cleanup-row export-preview-cleanup-row-single';
        copyRow.appendChild(this._toolButton('batchExport.copyCurrentCaption', 'Copy current', () => this._copyCurrentPreviewCaption(), {
            className: 'btn btn-small btn-ghost',
            tool: 'copy-current',
        }));
        grid.appendChild(copyRow);
        section.append(title, grid);
        return section;
    },

    _getPreviewDiagnostics() {
        const blacklist = new Set(this._getBlacklistTokens().map((token) => this._normalizeCaptionToken(token)));
        let empty = 0;
        let blockedHits = 0;
        let duplicateHits = 0;
        let maxTokens = 0;
        // Use previewResults for diagnostics (only covers loaded items)
        for (const item of this.previewResults) {
            const tokens = this._splitCaptionTokens(this._getRenderedCaption(item.image_id));
            if (!tokens.length) empty += 1;
            maxTokens = Math.max(maxTokens, tokens.length);
            const seen = new Set();
            for (const token of tokens) {
                const key = this._normalizeCaptionToken(token);
                if (blacklist.has(key)) blockedHits += 1;
                if (seen.has(key)) duplicateHits += 1;
                seen.add(key);
            }
        }
        return {
            total: this.queueTotalCount || this.queueImageIds.length || this.previewResults.length,
            edited: this.editedCaptions.size,
            empty,
            blockedHits,
            duplicateHits,
            maxTokens,
        };
    },

    _getCommonPreviewTokens() {
        const counts = new Map();
        for (const item of this.previewResults) {
            const seen = new Set();
            for (const token of this._splitCaptionTokens(this._getRenderedCaption(item.image_id))) {
                const key = token.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                const current = counts.get(key) || { token, count: 0 };
                current.count += 1;
                counts.set(key, current);
            }
        }
        const total = Math.max(1, this.previewResults.length);
        return Array.from(counts.values())
            .filter((item) => item.count > 1 || total === 1)
            .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
    },

    _createPreviewThumb(item, size) {
        const img = document.createElement('img');
        img.className = 'export-preview-thumb';
        img.alt = item.filename || `Image ${item.image_id}`;
        img.src = window.API?.getThumbnailUrl?.(item.image_id, size) || `/api/image-thumbnail/${item.image_id}?size=${size}`;
        img.loading = 'lazy';
        img.onerror = () => {
            img.removeAttribute('src');
            img.style.background = 'linear-gradient(135deg, #1f2937 0%, #111827 100%)';
            img.alt = 'image';
        };
        return img;
    },

    _i18n(key, fallback) {
        return window.I18n?.t?.(key) || fallback;
    },

    /** Hook into existing export submit — inject template_options + image_overrides */
    interceptExportSubmit() {
        const startBtn = document.getElementById('btn-start-batch-export');
        if (!startBtn) {
            setTimeout(() => this.interceptExportSubmit(), 500);
            return;
        }
        // Use a fetch wrapper instead of intercepting click — wrap window.fetch
        const origFetch = window.fetch.bind(window);
        const self = this;
        window.fetch = async function(url, options) {
            // Match the export-batch endpoint
            if (typeof url === 'string' && url.includes('/api/tags/export-batch') && options?.method === 'POST') {
                try {
                    const body = JSON.parse(options.body);
                    const mode = body.content_mode;

                    // Inject template_options when needed
                    if (mode === 'template') {
                        body.template_options = self.collectTemplateOptions();
                    }

                    // Inject image_overrides for any user-edited captions
                    const overrides = self.collectEditedCaptionOverrides();
                    if (overrides) {
                        body.image_overrides = overrides;
                    }

                    // v3.2.1 follow-up: forward the LoRA underscore checkbox.
                    // Default behavior (when the field is omitted) is the
                    // backend per-mode default (ON for danbooru-tag modes,
                    // OFF for prompt/NL/a1111). Only send a value when the
                    // checkbox exists, so older callers stay on default.
                    const normalizeCheckbox = document.getElementById('batch-export-normalize-underscores');
                    if (normalizeCheckbox) {
                        body.normalize_tag_underscores = !!normalizeCheckbox.checked;
                    }

                    options.body = JSON.stringify(body);
                } catch (e) {
                    console.warn('Failed to inject template_options', e);
                }
            }
            return origFetch(url, options);
        };
    },

    /** v3.2.1: short-circuit the Start button when the user picked clipboard
     *  or download as the output destination. Both paths build the combined
     *  text from the in-memory previewCache + editedCaptions and either copy
     *  to clipboard or save as a single file — no backend call to
     *  /api/tags/export-batch is needed in those cases.
     */
    interceptCombinedExportClick() {
        const startBtn = document.getElementById('btn-start-batch-export');
        if (!startBtn) {
            setTimeout(() => this.interceptCombinedExportClick(), 500);
            return;
        }
        startBtn.addEventListener('click', async (e) => {
            const checked = document.querySelector('input[name="batch-export-output-mode"]:checked');
            const value = checked?.value || 'beside_image';
            if (value !== 'clipboard' && value !== 'download') {
                return; // sidecar path: let app.js executeBatchExport handle it
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            try {
                await this._runCombinedExport(value);
            } catch (err) {
                const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
                if (typeof window.showToast === 'function') {
                    window.showToast(
                        i18n('batchExport.combinedCopyFailed', 'Could not copy combined export.'),
                        'error'
                    );
                } else {
                    window.console?.error?.('combined export failed', err);
                }
            }
        }, true); // capture phase so we run before the existing handler
    },

    /** Build the combined text by re-using the live preview pipeline: ask
     *  the backend to render every selected image, apply user edits, then
     *  concatenate. This guarantees the combined output matches what the
     *  user saw in the right preview pane character-for-character.
     */
    async _runCombinedExport(destination) {
        const i18n = (key, params, fallback) => window.I18n?.t?.(key, params) || fallback;
        const ids = await this._getAllSelectedImageIdsForExport();
        if (!ids.length) {
            if (typeof window.showToast === 'function') {
                window.showToast(i18n('selection.noImagesSelected', null, 'No images selected.'), 'warning');
            }
            return;
        }
        const contentMode = document.getElementById('batch-export-content-mode')?.value || 'caption_merged';
        const opts = this._previewOptionsForContentMode(contentMode);
        const startBtn = document.getElementById('btn-start-batch-export');
        const previousLabel = startBtn?.innerHTML;
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.innerHTML = '<span>' + i18n('export.inProgress', null, 'Working...') + '</span>';
        }
        try {
            // Render in chunks to avoid asking the backend for ten thousand
            // captions at once. /api/tags/export-preview already trims, but
            // we batch defensively.
            const chunkSize = 20;
            const renderedById = new Map();
            for (let i = 0; i < ids.length; i += chunkSize) {
                const slice = ids.slice(i, i + chunkSize);
                const r = await fetch('/api/tags/export-preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_ids: slice, ...opts }),
                });
                if (!r.ok) throw new Error('preview HTTP ' + r.status);
                const data = await r.json();
                for (const item of (data.results || [])) {
                    renderedById.set(item.image_id, item.rendered);
                }
            }
            const ordered = ids.map((id) => {
                if (this.editedCaptions.has(id)) return this.editedCaptions.get(id);
                return renderedById.get(id) || '';
            });
            const combined = ordered.filter(Boolean).join('\n');

            if (destination === 'clipboard') {
                await navigator.clipboard.writeText(combined);
                if (typeof window.showToast === 'function') {
                    window.showToast(
                        i18n('batchExport.combinedCopied', null, 'Combined export copied to clipboard.'),
                        'success'
                    );
                }
            } else {
                const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const ext = (contentMode === 'json' || contentMode === 'jsonl') ? 'json' : 'txt';
                const filename = 'sd-image-sorter-export-' + stamp + '.' + ext;
                const blob = new Blob([combined], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                if (typeof window.showToast === 'function') {
                    window.showToast(
                        i18n('batchExport.combinedDownloaded', { filename }, 'Combined export saved as ' + filename),
                        'success'
                    );
                }
            }
            if (typeof window.hideModal === 'function') {
                window.hideModal('batch-export-modal');
            }
        } finally {
            if (startBtn) {
                startBtn.disabled = false;
                if (previousLabel) startBtn.innerHTML = previousLabel;
            }
        }
    },

    /** Fetch the full list of selected image ids for a combined export.
     *  In normal use SelectionStore holds the live selection; we cap the
     *  count defensively at 5000 to keep the preview server happy.
     */
    async _getAllSelectedImageIdsForExport() {
        // Use already-loaded queue if available (virtual scroll path)
        if (this.queueImageIds.length) return this.queueImageIds;
        const cap = 500000;
        const selectedIds = this._getExplicitSelectedImageIds(cap);
        if (selectedIds.length) {
            return selectedIds;
        }
        const selectionToken = this._getActiveSelectionTokenForExport();
        if (selectionToken && window.App?.API?.getSelectionChunk) {
            try {
                const allIds = [];
                const pageSize = 5000;
                let offset = 0;
                let done = false;
                while (!done) {
                    const chunk = await window.App.API.getSelectionChunk(selectionToken, { offset, limit: pageSize });
                    const ids = Array.isArray(chunk?.image_ids) ? chunk.image_ids : [];
                    for (const id of ids) {
                        const n = Number(id);
                        if (Number.isFinite(n) && n > 0) allIds.push(n);
                    }
                    if (ids.length < pageSize) done = true;
                    else offset += pageSize;
                }
                if (allIds.length) return allIds;
            } catch (error) {
                console.warn('Could not resolve filtered selection for combined export', error);
            }
        }
        const items = document.querySelectorAll('.gallery-item[data-id]');
        return Array.from(items).slice(0, cap)
            .map((el) => parseInt(el.dataset.id))
            .filter((n) => !isNaN(n));
    },
};

document.addEventListener('DOMContentLoaded', () => V321Integration.init());

// Expose for debugging
window.V321Integration = V321Integration;
