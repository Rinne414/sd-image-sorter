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
    vlmActive: false,

    init() {
        this.bindTaggerBackendSwitch();
        this.bindExportPresetUI();
        this.bindLivePreview();
        this.interceptExportSubmit();
        this.interceptTagSubmit();
    },

    // ====================================================================
    // (A) VLM as tagger backend
    // ====================================================================

    bindTaggerBackendSwitch() {
        const select = document.getElementById('tag-model-select');
        const banner = document.getElementById('vlm-mode-banner');
        if (!select || !banner) return;

        const updateBanner = () => {
            this.vlmActive = (select.value === 'vlm');
            banner.style.display = this.vlmActive ? 'block' : 'none';

            // Hide/show WD14-specific config when VLM is active
            const wdSpecific = [
                'tagger-model-panel',  // model snapshot
                'tag-advanced-options',  // WD14 thresholds, custom profile
                'vlm-utility-tool',  // redundant utility strip (avoid duplicating banner)
            ];
            wdSpecific.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = this.vlmActive ? 'none' : '';
            });

            if (this.vlmActive) this.refreshVLMBannerStatus();
        };

        select.addEventListener('change', updateBanner);

        // Watch for the dropdown being rebuilt by app.js loadTaggerModels
        // — re-apply banner state whenever options change
        const observer = new MutationObserver(() => updateBanner());
        observer.observe(select, { childList: true });
        updateBanner();

        // Banner "VLM Settings" button reuses the existing VLM modal
        document.getElementById('btn-vlm-banner-settings')?.addEventListener('click', () => {
            if (window.VLMCaption?.openSettingsModal) {
                window.VLMCaption.openSettingsModal();
            } else {
                document.getElementById('btn-vlm-settings')?.click();
            }
        });
    },

    async refreshVLMBannerStatus() {
        const el = document.getElementById('vlm-banner-current');
        if (!el) return;
        const i18n = (key, fallback) => window.I18n?.t?.(key) || fallback;
        try {
            const res = await fetch('/api/vlm/settings');
            const s = await res.json();
            const provider = s.provider || 'openai_compat';
            const model = s.model || '—';
            const endpoint = s.endpoint || '—';
            if (s.api_key_display || s.endpoint) {
                el.textContent = `${provider} · ${model} · ${endpoint}`;
            } else {
                el.textContent = i18n('vlm.notConfigured', 'Not configured — click VLM Settings to set up');
            }
        } catch (e) {
            el.textContent = i18n('vlm.notConfigured', 'Not configured');
        }
    },

    /** Intercept the Tag button click — when VLM is selected, route to VLM batch endpoint */
    interceptTagSubmit() {
        // Wait for app to bind original handler, then attach our pre-handler in capture phase
        const startBtn = document.getElementById('btn-start-tagging');
        if (!startBtn) {
            // Try later
            setTimeout(() => this.interceptTagSubmit(), 500);
            return;
        }
        startBtn.addEventListener('click', (e) => {
            if (!this.vlmActive) return;  // local tagger path: no interception

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

        const updateVis = () => {
            const mode = contentSelect.value;
            grid.style.display = mode === 'template' ? 'grid' : 'none';
            // Refresh preview when content mode changes
            this.refreshPreview();
        };
        contentSelect.addEventListener('change', updateVis);
        updateVis();
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
    },

    /** Get up to 5 selected image_ids for preview */
    getPreviewImageIds() {
        // Try app-level selection store
        const sel = window.SelectionStore?.getSelectedIds?.();
        if (sel && sel.size > 0) {
            return [...sel].slice(0, 5);
        }
        // Fallback: any visible gallery items
        const items = document.querySelectorAll('.gallery-item[data-id]');
        return Array.from(items).slice(0, 5).map(el => parseInt(el.dataset.id)).filter(n => !isNaN(n));
    },

    async refreshPreview() {
        const list = document.getElementById('export-preview-list');
        if (!list) return;

        const contentMode = document.getElementById('batch-export-content-mode')?.value;
        const ids = this.getPreviewImageIds();
        if (!ids.length) {
            list.style.display = 'block';
            list.innerHTML = '<p style="padding:12px;text-align:center;color:var(--text-muted)">No images selected. Select images in Gallery first.</p>';
            return;
        }

        // For non-template modes, we can still call preview with a default preset just to show
        // current tag/caption content. For template mode, send full options.
        const opts = (contentMode === 'template') ? this.collectTemplateOptions() : {
            preset_id: 'custom',
            template_override: this._fallbackTemplateForMode(contentMode),
            trigger: '',
            blacklist: [],
            replace_rules: {},
            max_tags: 0,
            append: [],
        };

        list.style.display = 'block';
        list.innerHTML = '<p style="padding:8px;color:var(--text-muted)">Rendering preview…</p>';

        try {
            const r = await fetch('/api/tags/export-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_ids: ids, ...opts }),
            });
            if (!r.ok) {
                list.innerHTML = `<p style="padding:8px;color:var(--accent-danger)">Preview failed: HTTP ${r.status}</p>`;
                return;
            }
            const data = await r.json();
            this.previewCache.clear();
            for (const item of (data.results || [])) {
                this.previewCache.set(item.image_id, item.rendered);
            }
            this.renderPreviewList(data.results || []);
        } catch (e) {
            list.innerHTML = `<p style="padding:8px;color:var(--accent-danger)">Preview error: ${e.message}</p>`;
        }
    },

    /** For non-template content modes, give a quick template that approximates the same output. */
    _fallbackTemplateForMode(mode) {
        switch (mode) {
            case 'tags': return '{tags:filtered}';
            case 'prompt': return '{prompt}';
            case 'negative': return '{negative}';
            case 'nl_caption': return '{nl_caption}';
            case 'prompt_nl': return '{prompt}\n{nl_caption}';
            case 'caption_tags': return '{nl_caption}, {tags:filtered}';
            case 'caption_merged': return '{nl_caption}, {prompt}, {tags:filtered}';
            default: return '{tags:filtered}';
        }
    },

    renderPreviewList(results) {
        const list = document.getElementById('export-preview-list');
        if (!list) return;
        list.innerHTML = '';
        for (const item of results) {
            const row = document.createElement('div');
            row.className = 'export-preview-row';

            const img = document.createElement('img');
            img.className = 'export-preview-thumb';
            img.alt = item.filename || `Image ${item.image_id}`;
            img.src = window.API?.getThumbnailUrl?.(item.image_id, 200) || `/api/image-thumbnail/${item.image_id}?size=200`;
            img.loading = 'lazy';
            img.onerror = () => {
                // Keep layout but show placeholder background instead of hiding
                img.removeAttribute('src');
                img.style.background = 'linear-gradient(135deg, #1f2937 0%, #111827 100%)';
                img.alt = '🖼';
            };

            const content = document.createElement('div');
            content.className = 'export-preview-content';

            const fname = document.createElement('div');
            fname.className = 'export-preview-filename';
            fname.textContent = `#${item.image_id} · ${item.filename || ''}`;

            const ta = document.createElement('textarea');
            ta.className = 'export-preview-textarea';
            ta.value = this.editedCaptions.has(item.image_id)
                ? this.editedCaptions.get(item.image_id)
                : item.rendered;
            if (this.editedCaptions.has(item.image_id)) ta.classList.add('edited');
            ta.dataset.imageId = item.image_id;

            const editedBadge = document.createElement('span');
            editedBadge.className = 'export-preview-edited-badge';
            editedBadge.textContent = '✏ edited (will be used on export)';
            editedBadge.style.display = this.editedCaptions.has(item.image_id) ? 'inline-block' : 'none';

            ta.addEventListener('input', () => {
                const id = parseInt(ta.dataset.imageId);
                const auto = this.previewCache.get(id) || '';
                if (ta.value !== auto) {
                    this.editedCaptions.set(id, ta.value);
                    ta.classList.add('edited');
                    editedBadge.style.display = 'inline-block';
                } else {
                    this.editedCaptions.delete(id);
                    ta.classList.remove('edited');
                    editedBadge.style.display = 'none';
                }
            });

            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'btn btn-small btn-ghost';
            resetBtn.textContent = '↺ Reset';
            resetBtn.title = 'Revert to template-generated caption';
            resetBtn.addEventListener('click', () => {
                const id = parseInt(ta.dataset.imageId);
                ta.value = this.previewCache.get(id) || '';
                this.editedCaptions.delete(id);
                ta.classList.remove('edited');
                editedBadge.style.display = 'none';
            });

            content.append(fname, ta, editedBadge, resetBtn);
            row.append(img, content);
            list.appendChild(row);
        }
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
                    if (self.editedCaptions.size > 0) {
                        body.image_overrides = {};
                        for (const [id, text] of self.editedCaptions.entries()) {
                            body.image_overrides[id] = text;
                        }
                    }

                    options.body = JSON.stringify(body);
                } catch (e) {
                    console.warn('Failed to inject template_options', e);
                }
            }
            return origFetch(url, options);
        };
    },
};

document.addEventListener('DOMContentLoaded', () => V321Integration.init());

// Expose for debugging
window.V321Integration = V321Integration;
