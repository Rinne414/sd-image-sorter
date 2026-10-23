/**
 * SD Image Sorter - Send to generator.
 *
 * One panel, opened from the preview's "Generator" button and the gallery
 * right-click menu, that hands a picture's recipe back to the tool that can
 * make it again:
 *   - WebUI / Forge: the parameters text its "read generation parameters"
 *     arrow understands (the picture's own text for WebUI pictures);
 *   - NovelAI: prompt, character slots and undesired content;
 *   - ComfyUI: the workflow (pastes onto the canvas with Ctrl+V), a .json
 *     file in output/workflows/, and "Run again" on the ComfyUI from Settings
 *     with a new or the same seed.
 * Recipes come from GET /api/images/{id}/generator-recipe. Prompt syntax
 * conversion (NovelAI <-> SD weights) reuses the preview's converter.
 */
(function () {
    'use strict';

    const SEED_MODE_KEY = 'sd-send-to-generator-seed-mode';

    function t(key, fallback, params) {
        let text = fallback;
        const translated = window.I18n?.t?.(key, params);
        if (translated && translated !== key) return translated;
        Object.entries(params || {}).forEach(([name, value]) => {
            text = text.replace(`{${name}}`, String(value));
        });
        return text;
    }

    function readSeedMode() {
        try {
            return localStorage.getItem(SEED_MODE_KEY) === 'same' ? 'same' : 'new';
        } catch (_e) {
            return 'new';
        }
    }

    function writeSeedMode(mode) {
        try {
            localStorage.setItem(SEED_MODE_KEY, mode);
        } catch (_e) {
            /* the choice simply is not remembered */
        }
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function button(label, onClick, options = {}) {
        const node = el('button', `btn btn-small ${options.primary ? 'btn-primary' : 'btn-secondary'} stg-action`, label);
        node.type = 'button';
        if (options.id) node.id = options.id;
        if (options.title) node.title = options.title;
        if (options.disabled) node.disabled = true;
        node.addEventListener('click', onClick);
        return node;
    }

    function row(label, ...controls) {
        const line = el('div', 'stg-row');
        line.append(el('span', 'stg-row-label', label));
        const actions = el('div', 'stg-row-actions');
        controls.filter(Boolean).forEach((control) => actions.append(control));
        line.append(actions);
        return line;
    }

    function convertedView(image, target) {
        const gallery = window.Gallery;
        if (!image || !gallery?._buildPromptView) return null;
        return gallery._buildPromptView(image, gallery._extractParsedData(image), target);
    }

    function composeWebui(prompt, negative, settingsLine) {
        const parts = [String(prompt || '').trim()];
        if (String(negative || '').trim()) parts.push(`Negative prompt: ${String(negative).trim()}`);
        if (settingsLine) parts.push(settingsLine);
        return parts.join('\n').trim();
    }

    function webuiText(recipe, image) {
        if (recipe.source_format !== 'nai' || recipe.webui_is_original) return recipe.webui_text;
        const view = convertedView(image, 'sd');
        return view ? composeWebui(view.promptText, view.negativeText, recipe.webui_settings_line) : recipe.webui_text;
    }

    function naiText(recipe, image) {
        if (recipe.nai_text) return recipe.nai_text;
        const view = convertedView(image, 'nai');
        if (!view) return '';
        const blocks = [String(view.promptText || '').trim()];
        if (String(view.negativeText || '').trim()) blocks.push(`Undesired Content: ${view.negativeText.trim()}`);
        return blocks.filter(Boolean).join('\n\n');
    }

    const SendToGenerator = {
        _panel: null,
        _imageId: null,
        _requestId: 0,

        /** Open the panel for one picture, next to `anchor` (or at x/y). */
        async open(imageId, { anchor = null, x = null, y = null } = {}) {
            this.close();
            const requestId = ++this._requestId;
            this._imageId = Number(imageId);
            const panel = el('div', 'stg-panel');
            panel.id = 'send-to-generator-panel';
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-label', t('sendGen.title', 'Send to generator'));
            panel.append(el('div', 'stg-loading', t('sendGen.loading', 'Reading the recipe…')));
            document.body.append(panel);
            this._panel = panel;
            this._anchor = anchor;
            this._point = { x, y };
            this._position();
            this._bindDismiss();
            try {
                const [recipe, detail] = await Promise.all([
                    window.App.API.get(`/api/images/${this._imageId}/generator-recipe`),
                    window.App.API.getImage(this._imageId).catch(() => null),
                ]);
                if (requestId !== this._requestId) return;
                this._render(recipe, detail?.image || null);
            } catch (error) {
                if (requestId !== this._requestId) return;
                panel.replaceChildren(el('div', 'stg-status is-error', error?.message || t('sendGen.loadFailed', 'Could not read this picture.')));
            }
        },

        close() {
            this._requestId += 1;
            this._panel?.remove();
            this._panel = null;
            if (this._dismiss) {
                document.removeEventListener('mousedown', this._dismiss, true);
                window.removeEventListener('keydown', this._dismiss, true);
                this._dismiss = null;
            }
        },

        _bindDismiss() {
            this._dismiss = (event) => {
                if (!this._panel) return;
                if (event.type === 'keydown') {
                    if (event.key !== 'Escape') return;
                    // Esc closes this panel only, not the preview under it.
                    if (typeof claimEscape === 'function') claimEscape(event);
                    event.stopImmediatePropagation();
                    event.preventDefault();
                    this.close();
                    return;
                }
                if (this._panel.contains(event.target)) return;
                this.close();
            };
            document.addEventListener('mousedown', this._dismiss, true);
            window.addEventListener('keydown', this._dismiss, true);
        },

        _position() {
            if (!this._panel || !window.PopupPosition?.place) return;
            if (this._anchor?.isConnected) {
                window.PopupPosition.place(this._panel, { anchor: this._anchor, placement: 'bottom-start', gap: 6 });
            } else {
                window.PopupPosition.place(this._panel, { x: this._point.x ?? 8, y: this._point.y ?? 8, placement: 'point' });
            }
        },

        _render(recipe, image) {
            const panel = this._panel;
            const head = el('div', 'stg-head');
            head.append(el('strong', '', t('sendGen.title', 'Send to generator')));
            if (recipe.metadata_source === 'stored') {
                head.append(el('span', 'stg-note', t('sendGen.fromStored', 'File not found: using the copy kept in the library')));
            }
            const status = el('div', 'stg-status');
            status.setAttribute('aria-live', 'polite');
            this._status = status;
            panel.replaceChildren(head, ...this._copyRows(recipe, image), ...this._comfyRows(recipe), status);
            this._position();
        },

        _copyRows(recipe, image) {
            const noPrompt = t('sendGen.noPrompt', 'This picture has no prompt to copy');
            const webui = button(t('sendGen.copyWebui', 'Copy parameters'), () => this._copy(webuiText(recipe, image), t('sendGen.webuiCopied', 'WebUI parameters copied. Paste into the prompt box, then press the arrow under Generate (Read generation parameters).')), {
                id: 'stg-copy-webui',
                disabled: !recipe.has_prompt,
                title: recipe.has_prompt ? t('sendGen.copyWebuiTip', 'Prompt, negative prompt and settings in the text WebUI and Forge read back') : noPrompt,
            });
            const nai = button(t('sendGen.copyNai', 'Copy prompt + undesired'), () => this._copy(naiText(recipe, image), t('sendGen.naiCopied', 'NovelAI prompt and undesired content copied')), {
                id: 'stg-copy-nai',
                disabled: !recipe.has_prompt,
                title: recipe.has_prompt ? t('sendGen.copyNaiTip', 'NovelAI weights ({ } and n::), with the undesired content labelled') : noPrompt,
            });
            return [row('WebUI / Forge', webui), row('NovelAI', nai)];
        },

        _comfyRows(recipe) {
            const comfy = recipe.comfyui || {};
            if (!comfy.has_api_prompt && !comfy.has_workflow) {
                return [row('ComfyUI', el('span', 'stg-note', t('sendGen.noComfy', 'No ComfyUI recipe in this picture. Use the copy buttons above.')))];
            }
            const copy = button(t('sendGen.copyWorkflow', 'Copy workflow'), () => this._copy(JSON.stringify(comfy.workflow), t('sendGen.workflowCopied', 'Workflow copied. Click the ComfyUI canvas and press Ctrl+V.')), {
                id: 'stg-copy-workflow',
                disabled: !comfy.has_workflow,
                title: comfy.has_workflow ? t('sendGen.copyWorkflowTip', 'Paste onto the ComfyUI canvas with Ctrl+V') : t('sendGen.onlyApi', 'This picture keeps only the run recipe. Save it as .json and drop the file on ComfyUI.'),
            });
            const save = button(t('sendGen.saveWorkflow', 'Save .json'), (event) => this._saveWorkflow(event.currentTarget), {
                id: 'stg-save-workflow',
                title: t('sendGen.saveWorkflowTip', 'Save into the workflows output folder; drop the file on ComfyUI to load it'),
            });
            const rows = [row('ComfyUI', copy, save)];
            if (comfy.has_api_prompt) rows.push(this._runRow(recipe));
            return rows;
        },

        _runRow(recipe) {
            const seedMode = readSeedMode();
            const group = el('div', 'stg-choice');
            group.setAttribute('role', 'group');
            group.setAttribute('aria-label', t('sendGen.seedLabel', 'Seed'));
            [['new', t('sendGen.seedNew', 'New seed')], ['same', t('sendGen.seedSame', 'Same seed')]].forEach(([mode, label]) => {
                const option = el('button', 'stg-choice-option', label);
                option.type = 'button';
                option.dataset.seedMode = mode;
                option.setAttribute('aria-pressed', String(mode === seedMode));
                option.addEventListener('click', () => {
                    writeSeedMode(mode);
                    group.querySelectorAll('.stg-choice-option').forEach((node) => node.setAttribute('aria-pressed', String(node === option)));
                });
                group.append(option);
            });
            const run = button(t('sendGen.runAgain', 'Run in ComfyUI'), (event) => this._queue(event.currentTarget), {
                id: 'stg-run-comfyui',
                primary: true,
                title: t('sendGen.runTip', 'Queue this recipe on {url}', { url: recipe.comfyui_url || '?' }),
            });
            const where = el('span', 'stg-note stg-address', t('sendGen.address', 'ComfyUI at {url} · change in Settings', { url: recipe.comfyui_url || '?' }));
            const line = row(t('sendGen.runLabel', 'Run again'), group, run);
            line.append(where);
            return line;
        },

        async _copy(text, message) {
            if (!text) {
                this._say(t('sendGen.nothingToCopy', 'Nothing to copy for this picture'), true);
                return;
            }
            const copied = await window.App.copyTextToClipboard(text, message);
            this._say(copied ? message : t('modal.copyFailed', 'Failed to copy text'), !copied);
        },

        async _saveWorkflow(trigger) {
            trigger.disabled = true;
            try {
                const result = await window.App.API.post(`/api/images/${this._imageId}/comfyui/workflow-file`, {});
                const message = t('sendGen.workflowSaved', 'Saved {name} in {folder}', {
                    name: result.filename,
                    folder: result.path.slice(0, result.path.length - result.filename.length),
                });
                this._say(message, false);
                window.App.showToast?.(message, 'success');
            } catch (error) {
                this._say(error?.message || String(error), true);
            } finally {
                trigger.disabled = false;
            }
        },

        async _queue(trigger) {
            const seedMode = readSeedMode();
            trigger.disabled = true;
            this._say(t('sendGen.queueing', 'Sending to ComfyUI…'), false);
            try {
                const result = await window.App.API.post(`/api/images/${this._imageId}/comfyui/queue`, { seed_mode: seedMode });
                const message = seedMode === 'new'
                    ? t('sendGen.queuedNew', 'Queued in ComfyUI with a new seed (seed inputs changed: {count})', { count: result.seeds_changed })
                    : t('sendGen.queuedSame', 'Queued in ComfyUI with the same seed');
                this._say(message, false);
                window.App.showToast?.(message, 'success');
            } catch (error) {
                this._say(this._queueError(error), true);
            } finally {
                trigger.disabled = false;
            }
        },

        _queueError(error) {
            const data = error?.apiData || {};
            // error.message is already in the UI language (apiError.<code>);
            // a missing recipe reads differently here than for Save.
            const message = data.code === 'no_comfyui_recipe'
                ? t('sendGen.noComfyRun', 'This picture has no ComfyUI recipe to run. Its prompt can still be copied.')
                : (error?.message || String(error));
            const details = Array.isArray(data.details) ? data.details : [];
            return [message, ...details].join('\n');
        },

        _say(message, isError) {
            if (!this._status) return;
            this._status.textContent = message;
            this._status.classList.toggle('is-error', Boolean(isError));
        },
    };

    // Settings > ComfyUI address. Empty field = the default address.
    const ComfyUISetting = {
        // force: put the saved address back even while the field has focus
        // (after a refused address, the field must not keep the bad text).
        async sync(force = false) {
            const input = document.getElementById('settings-comfyui-url');
            if (!input) return;
            try {
                const data = await window.App.API.get('/api/settings/comfyui');
                if (force || document.activeElement !== input) input.value = data.custom_url || '';
                input.placeholder = data.default_url;
            } catch (_error) {
                window.App.showToast?.(t('settings.comfyuiLoadFailed', 'Could not read the ComfyUI address.'), 'error');
            }
        },

        async save(url) {
            let refused = false;
            try {
                await window.App.API.patch('/api/settings/comfyui', { url });
                window.App.showToast?.(t('settings.comfyuiSaved', 'ComfyUI address saved'), 'success');
            } catch (error) {
                refused = true;
                window.App.showToast?.(t('settings.comfyuiRefused', 'Not saved: {reason}', { reason: error?.message || String(error) }), 'error');
            }
            await this.sync(refused);
        },

        init() {
            const input = document.getElementById('settings-comfyui-url');
            if (!input || input.dataset.bound === '1') return;
            input.dataset.bound = '1';
            input.addEventListener('change', () => this.save(input.value.trim()));
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') input.blur();
            });
            input.addEventListener('focus', () => this.sync(), { once: true });
            document.getElementById('btn-settings-comfyui-reset')?.addEventListener('click', () => {
                input.value = '';
                this.save('');
            });
            this.sync();
        },
    };

    window.SendToGenerator = SendToGenerator;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => ComfyUISetting.init(), { once: true });
    } else {
        ComfyUISetting.init();
    }
})();
