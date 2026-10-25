/**
 * vlm-caption/prompt-presets.js — the prompt presets of the VLM settings
 * dialog (GitHub issue #21).
 *
 * The list shows the shipped presets, then the user's own. Users save the
 * prompts in the boxes as a new preset, save edits back into one of theirs,
 * rename it and delete it. Applying a preset and deleting one can both be
 * undone from the line under the list. Built-in presets are read-only; the
 * backend refuses to change them. The preset the prompts came from is kept in
 * the VLM settings (prompt_preset_id), so the dialog reopens on it.
 *
 * Joins the ONE window.VLMCaption object from vlm-caption/core.js; loads
 * before vlm-caption/boot.js, whose bindEvents calls _bindPresetEvents.
 */
Object.assign(window.VLMCaption, {
    _presets: {},
    _presetOrder: [],
    _presetsProblem: '',
    _activePresetId: '',
    _presetUndo: null,
    _presetUndoKind: '',
    _presetNameMode: '',

    _BUILTIN_PRESET_LABEL_KEYS: {
        lora_training: 'vlmSettings.presetLora',
        anima_flux: 'vlmSettings.presetAnimaFlux',
        krea2_long_nl: 'vlmSettings.presetKrea2',
        short_caption: 'vlmSettings.presetShort',
        character_lora: 'vlmSettings.presetCharacterLora',
        nsfw_relaxed: 'vlmSettings.presetNsfw',
        vlm_danbooru: 'vlmSettings.presetDanbooru',
        vlm_hybrid: 'vlmSettings.presetHybrid',
    },

    _tp(key, fallback, params = {}) {
        let text = this._t(key, fallback);
        Object.entries(params).forEach(([name, value]) => {
            text = text.split(`{${name}}`).join(String(value));
        });
        return text;
    },

    _presetLabel(preset) {
        if (!preset) return '';
        if (!preset.builtin) return preset.name || '';
        const key = this._BUILTIN_PRESET_LABEL_KEYS[preset.id];
        return key ? this._t(key, preset.name || preset.id) : (preset.name || preset.id);
    },

    async loadPresets() {
        try {
            const resp = await fetch('/api/vlm/presets');
            if (!resp.ok) throw new Error(resp.statusText || String(resp.status));
            const data = await resp.json();
            const presets = data?.presets && typeof data.presets === 'object' ? data.presets : {};
            this._presets = {};
            this._presetOrder = [];
            Object.entries(presets).forEach(([id, preset]) => {
                if (!preset || typeof preset !== 'object') return;
                this._presets[id] = { ...preset, id, builtin: preset.builtin !== false };
                this._presetOrder.push(id);
            });
            this._presetsProblem = String(data?.custom_presets_problem || '');
        } catch (e) {
            this._showPresetStatus(this._tp('vlmSettings.presetLoadFailed',
                'Could not load the presets: {reason}', { reason: e.message }), 'error');
            return false;
        }
        this._renderPresetSelect();
        if (this._presetsProblem) this._showPresetStatus(this._presetsProblem, 'warning');
        return true;
    },

    _renderPresetSelect() {
        const select = document.getElementById('vlm-preset-select');
        if (!select) return;
        const builtins = this._presetOrder.filter((id) => this._presets[id].builtin);
        const mine = this._presetOrder.filter((id) => !this._presets[id].builtin);
        const option = (id) => {
            const el = document.createElement('option');
            el.value = id;
            el.textContent = this._presetLabel(this._presets[id]);
            return el;
        };
        const group = (labelKey, fallback, ids) => {
            const el = document.createElement('optgroup');
            el.label = this._t(labelKey, fallback);
            ids.forEach((id) => el.appendChild(option(id)));
            return el;
        };
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.setAttribute('data-i18n', 'vlmSettings.presetSelect');
        placeholder.textContent = this._t('vlmSettings.presetSelect', '— Select a preset —');
        select.replaceChildren(placeholder);
        if (builtins.length) select.appendChild(group('vlmSettings.presetGroupBuiltin', 'Built-in presets', builtins));
        if (mine.length) select.appendChild(group('vlmSettings.presetGroupMine', 'My presets', mine));
        if (!this._presets[this._activePresetId]) this._activePresetId = '';
        select.value = this._activePresetId;
        this._syncPresetControls();
    },

    _currentPromptFields() {
        return {
            output_format: this._getOutputFormat(),
            system_prompt: this._getVal('vlm-system-prompt'),
            user_prompt: this._getVal('vlm-user-prompt'),
            user_prompt_with_tags: this._getVal('vlm-user-prompt-with-tags'),
        };
    },

    _setPromptFields(fields) {
        this._setVal('vlm-system-prompt', fields.system_prompt || '');
        this._setVal('vlm-user-prompt', fields.user_prompt || '');
        this._setVal('vlm-user-prompt-with-tags', fields.user_prompt_with_tags || '');
        if (fields.output_format) this._setOutputFormat(fields.output_format);
    },

    _presetIsEdited(preset) {
        if (!preset) return false;
        const current = this._currentPromptFields();
        return ['system_prompt', 'user_prompt', 'user_prompt_with_tags'].some(
            (field) => (preset[field] || '') !== current[field],
        ) || (preset.output_format || 'nl_caption') !== current.output_format;
    },

    // Which buttons show, and whether the chosen preset still matches the boxes.
    _syncPresetControls() {
        const preset = this._presets[this._activePresetId];
        const isMine = !!preset && !preset.builtin;
        const edited = this._presetIsEdited(preset);
        const show = (id, visible) => { const el = document.getElementById(id); if (el) el.hidden = !visible; };
        show('btn-vlm-preset-save', isMine && edited);
        show('btn-vlm-preset-rename', isMine);
        show('btn-vlm-preset-delete', isMine);
        const select = document.getElementById('vlm-preset-select');
        const selected = select?.selectedOptions?.[0];
        if (selected && preset) {
            const label = this._presetLabel(preset);
            selected.textContent = edited
                ? this._tp('vlmSettings.presetEditedLabel', '{name} (edited)', { name: label })
                : label;
        }
    },

    _showPresetStatus(message, type = 'info', undo = null, undoKind = '') {
        const box = document.getElementById('vlm-preset-status');
        const text = document.getElementById('vlm-preset-status-text');
        const undoBtn = document.getElementById('btn-vlm-preset-undo');
        if (!box || !text) return;
        this._presetUndo = typeof undo === 'function' ? undo : null;
        this._presetUndoKind = this._presetUndo ? undoKind : '';
        text.textContent = message;
        box.className = `vlm-preset-status vlm-status vlm-status-${type}`;
        box.hidden = !message;
        if (undoBtn) undoBtn.hidden = !this._presetUndo;
    },

    _clearPresetStatus() {
        this._showPresetStatus('', 'info');
    },

    async _presetError(resp, fallback) {
        const body = await resp.json().catch(() => ({}));
        if (typeof window.apiErrorText === 'function') return window.apiErrorText(body, fallback);
        return body.message || body.error || fallback;
    },

    async applyPreset(presetId) {
        if (!presetId) {
            this._activePresetId = '';
            this._syncPresetControls();
            return;
        }
        if (!this._presets[presetId]) await this.loadPresets();
        const preset = this._presets[presetId];
        if (!preset) return;
        const before = { fields: this._currentPromptFields(), presetId: this._activePresetId };
        this._setPromptFields(preset);
        this._activePresetId = presetId;
        const select = document.getElementById('vlm-preset-select');
        if (select) select.value = presetId;
        this._syncPresetControls();
        const changed = JSON.stringify(before.fields) !== JSON.stringify(this._currentPromptFields());
        this._showPresetStatus(
            this._tp('vlmSettings.presetApplied', 'Applied “{name}”.', { name: this._presetLabel(preset) }),
            'success',
            changed ? () => this._restorePromptSnapshot(before) : null,
            'apply',
        );
    },

    _restorePromptSnapshot(snapshot) {
        this._setPromptFields(snapshot.fields);
        this._activePresetId = this._presets[snapshot.presetId] ? snapshot.presetId : '';
        const select = document.getElementById('vlm-preset-select');
        if (select) select.value = this._activePresetId;
        this._syncPresetControls();
        this._showPresetStatus(this._t('vlmSettings.presetPromptsRestored', 'Your earlier prompts are back.'), 'info');
    },

    _openPresetNameRow(mode) {
        const row = document.getElementById('vlm-preset-name-row');
        const input = document.getElementById('vlm-preset-name');
        const ok = document.getElementById('btn-vlm-preset-name-ok');
        if (!row || !input) return;
        this._presetNameMode = mode;
        const preset = this._presets[this._activePresetId];
        input.value = mode === 'rename' && preset ? preset.name : '';
        if (ok) {
            ok.textContent = mode === 'rename'
                ? this._t('vlmSettings.presetRenameSave', 'Rename')
                : this._t('vlmSettings.presetNameSave', 'Save preset');
        }
        row.hidden = false;
        input.focus();
        input.select();
    },

    _closePresetNameRow() {
        const row = document.getElementById('vlm-preset-name-row');
        if (row) row.hidden = true;
        this._presetNameMode = '';
    },

    async _submitPresetName() {
        const name = (this._getVal('vlm-preset-name') || '').trim();
        if (!name) {
            this._showPresetStatus(this._t('vlmSettings.presetNameRequired', 'Type a name for the preset.'), 'warning');
            document.getElementById('vlm-preset-name')?.focus();
            return;
        }
        if (this._presetNameMode === 'rename') await this._renameActivePreset(name);
        else await this._createPreset(name);
    },

    async _createPreset(name) {
        const resp = await fetch('/api/vlm/presets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, ...this._currentPromptFields() }),
        });
        if (resp.status === 409) {
            const body = await resp.json().catch(() => ({}));
            const existingId = body?.params?.existing_id;
            if (body?.code === 'vlm_preset_name_taken' && existingId) {
                this._confirmReplacePreset(existingId, body.params.name || name);
                return;
            }
            this._showPresetStatus(window.apiErrorText?.(body, resp.statusText) || resp.statusText, 'error');
            return;
        }
        if (!resp.ok) {
            this._showPresetStatus(await this._presetError(resp, this._t('vlmSettings.presetSaveFailed', 'The preset was not saved.')), 'error');
            return;
        }
        const { preset } = await resp.json();
        this._closePresetNameRow();
        this._activePresetId = preset.id;
        await this.loadPresets();
        this._showPresetStatus(this._tp('vlmSettings.presetSaved', 'Saved as “{name}”.', { name: preset.name }), 'success');
    },

    _confirmReplacePreset(existingId, name) {
        const confirm = window.App?.showConfirm;
        const replace = () => this._savePresetFields(existingId, { closeNameRow: true });
        if (typeof confirm !== 'function') {
            this._showPresetStatus(this._tp('vlmSettings.presetNameTaken', 'You already have a preset called “{name}”.', { name }), 'warning');
            return;
        }
        confirm(
            this._t('vlmSettings.presetReplaceTitle', 'Replace this preset?'),
            this._tp('vlmSettings.presetReplaceMessage',
                'You already have a preset called “{name}”. Replace its prompts with the ones in the boxes?', { name }),
            replace,
            null,
            { tone: 'primary' },
        );
    },

    async _savePresetFields(presetId, { closeNameRow = false } = {}) {
        const resp = await fetch(`/api/vlm/presets/${encodeURIComponent(presetId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this._currentPromptFields()),
        });
        if (!resp.ok) {
            this._showPresetStatus(await this._presetError(resp, this._t('vlmSettings.presetSaveFailed', 'The preset was not saved.')), 'error');
            return;
        }
        const { preset } = await resp.json();
        if (closeNameRow) this._closePresetNameRow();
        this._activePresetId = preset.id;
        await this.loadPresets();
        this._showPresetStatus(this._tp('vlmSettings.presetUpdated', 'Saved the changes to “{name}”.', { name: preset.name }), 'success');
    },

    async saveActivePresetChanges() {
        const preset = this._presets[this._activePresetId];
        if (!preset || preset.builtin) return;
        await this._savePresetFields(preset.id);
    },

    async _renameActivePreset(name) {
        const preset = this._presets[this._activePresetId];
        if (!preset || preset.builtin) return;
        const resp = await fetch(`/api/vlm/presets/${encodeURIComponent(preset.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        if (!resp.ok) {
            this._showPresetStatus(await this._presetError(resp, this._t('vlmSettings.presetRenameFailed', 'The preset was not renamed.')), 'error');
            return;
        }
        const { preset: renamed } = await resp.json();
        this._closePresetNameRow();
        await this.loadPresets();
        this._showPresetStatus(this._tp('vlmSettings.presetRenamed', 'Renamed to “{name}”.', { name: renamed.name }), 'success');
    },

    async deleteActivePreset() {
        const preset = this._presets[this._activePresetId];
        if (!preset || preset.builtin) return;
        const resp = await fetch(`/api/vlm/presets/${encodeURIComponent(preset.id)}`, { method: 'DELETE' });
        if (!resp.ok) {
            this._showPresetStatus(await this._presetError(resp, this._t('vlmSettings.presetDeleteFailed', 'The preset was not deleted.')), 'error');
            return;
        }
        const { deleted } = await resp.json();
        this._closePresetNameRow();
        this._activePresetId = '';
        await this.loadPresets();
        // The prompts stay in the boxes; Undo puts the preset itself back.
        this._showPresetStatus(
            this._tp('vlmSettings.presetDeleted', 'Deleted “{name}”. The prompts stay in the boxes.', { name: deleted.name }),
            'info',
            () => this._restoreDeletedPreset(deleted),
            'delete',
        );
    },

    async _restoreDeletedPreset(deleted) {
        const body = {
            id: deleted.id,
            name: deleted.name,
            output_format: deleted.output_format,
            system_prompt: deleted.system_prompt,
            user_prompt: deleted.user_prompt,
            user_prompt_with_tags: deleted.user_prompt_with_tags,
        };
        const resp = await fetch('/api/vlm/presets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            this._showPresetStatus(await this._presetError(resp, this._t('vlmSettings.presetRestoreFailed', 'The preset could not be brought back.')), 'error');
            return;
        }
        this._activePresetId = deleted.id;
        await this.loadPresets();
        this._showPresetStatus(this._tp('vlmSettings.presetRestored', '“{name}” is back.', { name: deleted.name }), 'success');
    },

    // The tags-variant prompt only matters while tags are sent as context.
    _refreshWithTagsPromptVisibility() {
        const group = document.getElementById('vlm-user-prompt-with-tags-group');
        if (group) group.hidden = !this._getChecked('vlm-include-tags');
    },

    // A request that never reaches the program (it was closed, the network
    // dropped) still ends in a readable line instead of a silent failure.
    async _guardPresetAction(action) {
        try {
            await action();
        } catch (e) {
            this._showPresetStatus(this._tp('vlmSettings.presetActionFailed',
                'That did not work: {reason}', { reason: e.message }), 'error');
        }
    },

    _bindPresetEvents() {
        const on = (id, type, handler) => document.getElementById(id)?.addEventListener(type, handler);
        const guarded = (action) => () => this._guardPresetAction(action);
        on('vlm-preset-select', 'change', (e) => this._guardPresetAction(() => this.applyPreset(e.target.value)));
        on('btn-vlm-preset-save', 'click', guarded(() => this.saveActivePresetChanges()));
        on('btn-vlm-preset-save-as', 'click', () => this._openPresetNameRow('create'));
        on('btn-vlm-preset-rename', 'click', () => this._openPresetNameRow('rename'));
        on('btn-vlm-preset-delete', 'click', guarded(() => this.deleteActivePreset()));
        on('btn-vlm-preset-name-ok', 'click', guarded(() => this._submitPresetName()));
        on('btn-vlm-preset-name-cancel', 'click', () => this._closePresetNameRow());
        on('btn-vlm-preset-undo', 'click', guarded(async () => {
            const undo = this._presetUndo;
            this._presetUndo = null;
            if (undo) await undo();
        }));
        on('vlm-preset-name', 'keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._guardPresetAction(() => this._submitPresetName());
            } else if (e.key === 'Escape') {
                // Esc closes the name field only, not the settings dialog.
                if (typeof claimEscape === 'function') claimEscape(e);
                e.preventDefault();
                this._closePresetNameRow();
            }
        });
        ['vlm-system-prompt', 'vlm-user-prompt', 'vlm-user-prompt-with-tags'].forEach((id) => {
            on(id, 'input', () => {
                // Typing again makes "undo the applied preset" stale: it would
                // throw away what was just typed.
                if (this._presetUndoKind === 'apply') this._clearPresetStatus();
                this._syncPresetControls();
            });
        });
        // On the group, so it runs after the buttons' own handlers have
        // switched the format.
        on('vlm-output-format', 'click', () => this._syncPresetControls());
        on('vlm-include-tags', 'change', () => this._refreshWithTagsPromptVisibility());
        document.addEventListener('languageChanged', () => {
            if (this._presetOrder.length) this._renderPresetSelect();
        });
    },
});
