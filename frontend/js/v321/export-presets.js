/**
 * v321/export-presets.js - v321-ui.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/v321-ui.js pre-cut lines 960-1103
 * (of 3,164): (B) LoRA preset selector + output destination + template options.
 * Classic script: joins the ONE unsealed window.V321Integration object
 * declared in v321/base.js (loads FIRST); v321/boot.js registers the
 * DOMContentLoaded init LAST; index.html lists the family in original
 * line order.
 */
Object.assign(window.V321Integration, {

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
            // Clear manual edits since they were for the previous mode's format
            this.editedCaptions.clear();
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
        const i18n = (key, fallback) => { const v = window.I18n?.t?.(key); return (v && v !== key) ? v : fallback; };

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
});
