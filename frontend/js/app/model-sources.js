/**
 * Model Center: the folders models may be read from (a ComfyUI install, a
 * Hugging Face cache, a NAS), what was found in them, and the one-time
 * question "add the ComfyUI I found?" (MS1c).
 *
 * The program only reads those files. The list lives in the backend
 * (/api/models/trusted-folders); what each folder holds comes from
 * /api/models/sources/detect. Classic script; globals used: API, appT,
 * escapeHtml, showToast, showConfirm, formatUserError, _formatBulkBytes,
 * lockDynamicI18nText, unlockDynamicI18nText, renderModelManager.
 */
(function () {
    'use strict';

    const LATER_KEY = 'sd-image-sorter-model-sources-later';
    const SCAN_POLL_MS = 1500;
    const SCAN_POLL_LIMIT = 40;
    const KIND_LABELS = {
        comfyui: ['models.sources.kind.comfyui', 'ComfyUI'],
        hf_cache: ['models.sources.kind.hf_cache', 'Hugging Face cache'],
        folder: ['models.sources.kind.folder', 'Folder'],
    };
    const VERIFY_LABELS = {
        sha: ['models.sourceVerify.sha', 'checksum matches'],
        revision: ['models.sourceVerify.revision', 'version matches'],
        size: ['models.sourceVerify.size', 'size matches'],
        name: ['models.sourceVerify.name', 'matched by file name'],
    };
    const WIDE_REASONS = {
        drive_root: ['models.sources.wide.drive_root', 'a whole drive'],
        share_root: ['models.sources.wide.share_root', 'a whole network share'],
        home: ['models.sources.wide.home', 'your user folder'],
        users_root: ['models.sources.wide.users_root', 'every user folder'],
        system: ['models.sources.wide.system', 'a system folder'],
    };

    const state = {
        detect: null,
        folders: null,
        failed: false,
        loading: false,
        formOpen: false,
        askedThisOpen: false,
        pollGeneration: 0,
        bound: false,
    };

    // ---- small helpers -----------------------------------------------------

    function section() {
        return document.getElementById('model-sources-section');
    }

    function label(table, key) {
        const entry = table[key] || table.folder || [key, String(key || '')];
        return appT(entry[0], entry[1]);
    }

    function kindLabel(kind) {
        return label(KIND_LABELS, kind);
    }

    function pathKey(path) {
        return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    /** "I:\ComfyUI\...\models\x.onnx" -> "I:\...\x.onnx" (the full path stays in the title). */
    function shortPath(path) {
        const text = String(path || '');
        const snapshot = /models--([^\\/]+?)--([^\\/]+)[\\/]snapshots[\\/]([0-9a-f]{7,40})/i.exec(text);
        if (snapshot) return `${snapshot[1]}/${snapshot[2]} @ ${snapshot[3].slice(0, 8)}`;
        if (text.length <= 52) return text;
        const parts = text.split(/[\\/]/).filter(Boolean);
        if (parts.length < 3) return text;
        const sep = text.includes('\\') ? '\\' : '/';
        return `${parts[0]}${sep}…${sep}${parts[parts.length - 1]}`;
    }

    function readLater() {
        try {
            const raw = JSON.parse(localStorage.getItem(LATER_KEY) || '[]');
            return new Set(Array.isArray(raw) ? raw.map(pathKey) : []);
        } catch (_error) {
            return new Set();
        }
    }

    function writeLater(roots) {
        try {
            if (!roots) {
                localStorage.removeItem(LATER_KEY);
                return;
            }
            const merged = new Set([...readLater(), ...roots.map(pathKey)]);
            localStorage.setItem(LATER_KEY, JSON.stringify([...merged]));
        } catch (_error) {
            // Private mode: the question just comes back next time.
        }
    }

    function isScanRunning() {
        return state.detect?.scan?.status === 'running';
    }

    function isModelsTabVisible() {
        const modal = document.getElementById('model-manager-modal');
        const panel = modal?.querySelector('[data-settings-panel="models"]');
        return Boolean(modal?.classList.contains('visible') && panel && !panel.hidden);
    }

    // ---- rows ----------------------------------------------------------------

    function buildRows() {
        const sources = Array.isArray(state.detect?.sources) ? state.detect.sources : [];
        const byKey = new Map(sources.map((source) => [pathKey(source.path), source]));
        const trusted = Array.isArray(state.folders)
            ? state.folders
            : sources.filter((source) => source.trusted && !source.network_not_trusted)
                .map((source) => ({ path: source.path, kind: source.is_network ? 'network' : 'local', exists: null }));
        return trusted.map((folder) => {
            const source = byKey.get(pathKey(folder.path));
            return {
                path: folder.path,
                kind: source?.kind || 'folder',
                version: source?.version || '',
                count: Number(source?.model_count) || 0,
                isNetwork: folder.kind === 'network' || Boolean(source?.is_network),
                pending: Boolean(source?.network_pending),
                missing: folder.exists === false,
            };
        });
    }

    function rowMeta(row) {
        const kind = kindLabel(row.kind);
        const parts = [row.version ? `${kind} ${row.version}` : kind];
        if (row.missing) {
            parts.push(appT('models.sources.notFound', 'folder not found'));
        } else if (row.pending) {
            parts.push(appT('models.sources.networkPending', 'checking the network drive…'));
        } else {
            parts.push(appT('models.sources.count', '{count} models', { count: row.count }));
        }
        if (row.isNetwork) parts.push(appT('models.sources.network', 'network drive, loads slowly'));
        return parts.join(' · ');
    }

    function rowHtml(row) {
        const dot = row.missing ? 'is-off' : (row.pending || row.isNetwork ? 'is-wait' : 'is-ok');
        return `
            <li class="model-sources-row" data-source-path="${escapeHtml(row.path)}">
                <span class="model-sources-dot ${dot}" aria-hidden="true"></span>
                <div class="model-sources-main">
                    <code class="model-sources-path" title="${escapeHtml(row.path)}">${escapeHtml(row.path)}</code>
                    <span class="model-sources-meta">${escapeHtml(rowMeta(row))}</span>
                </div>
                <button type="button" class="btn btn-ghost btn-small" data-ms-action="remove" data-path="${escapeHtml(row.path)}">${escapeHtml(appT('models.sources.remove', 'Remove'))}</button>
            </li>`;
    }

    function hintHtml(source) {
        return `
            <li class="model-sources-row is-hint" data-source-path="${escapeHtml(source.path)}">
                <span class="model-sources-dot is-wait" aria-hidden="true"></span>
                <div class="model-sources-main">
                    <code class="model-sources-path" title="${escapeHtml(source.path)}">${escapeHtml(source.path)}</code>
                    <span class="model-sources-meta">${escapeHtml(appT('models.sources.hintNotTrusted', 'COMFYUI_PATH points to this network folder. It is not read until you add it.'))}</span>
                </div>
                <button type="button" class="btn btn-ghost btn-small" data-ms-action="add-hint" data-path="${escapeHtml(source.path)}">${escapeHtml(appT('models.sources.addThisNas', 'Add this NAS'))}</button>
            </li>`;
    }

    function summaryText(rows) {
        if (state.failed && !state.detect) {
            return appT('models.sources.loadFailed', 'Could not read the model sources right now.');
        }
        if (isScanRunning()) {
            return appT('models.sources.scanningHint', 'Looking for ComfyUI on your drives…');
        }
        const matches = Array.isArray(state.detect?.matches) ? state.detect.matches : [];
        if (matches.length) {
            return appT(
                'models.sources.summaryUsing',
                'Using {count} ready-made models from these folders, saving about {size} of downloads.',
                { count: matches.length, size: _formatBulkBytes(state.detect.reusable_bytes) },
            );
        }
        return rows.length
            ? appT('models.sources.summaryNone', 'No model this program needs was found in these folders yet.')
            : appT('models.sources.summaryEmpty', 'Add your ComfyUI or model folder and the program uses the models already in it instead of downloading a second copy. It only reads those files and never changes them.');
    }

    // ---- render --------------------------------------------------------------

    function render() {
        const host = section();
        if (!host) return;
        const rows = buildRows();
        const hints = (state.detect?.sources || []).filter((source) => source.network_not_trusted);
        const scanning = isScanRunning();
        host.innerHTML = `
            <article class="model-card model-sources-card" data-testid="model-sources-card" aria-labelledby="model-sources-title">
                <div class="model-sources-head">
                    <div class="model-card-title" id="model-sources-title">${escapeHtml(appT('models.sources.title', 'Model sources'))}</div>
                    <div class="model-sources-head-actions">
                        <button type="button" class="btn btn-ghost btn-small" data-ms-action="rescan"${scanning ? ' disabled' : ''}>${escapeHtml(scanning ? appT('models.sources.scanning', 'Scanning…') : appT('models.sources.rescan', 'Rescan'))}</button>
                        <button type="button" class="btn btn-ghost btn-small" data-ms-action="toggle-add" aria-expanded="${state.formOpen ? 'true' : 'false'}">${escapeHtml(state.formOpen ? appT('models.sources.addClose', 'Cancel adding') : appT('models.sources.add', '+ Add folder'))}</button>
                    </div>
                </div>
                <div class="model-card-message" data-testid="model-sources-summary">${escapeHtml(summaryText(rows))}</div>
                ${rows.length || hints.length ? `<ul class="model-sources-list">${rows.map(rowHtml).join('')}${hints.map(hintHtml).join('')}</ul>` : ''}
                <form class="model-sources-add" data-ms-form="add"${state.formOpen ? '' : ' hidden'}>
                    <input type="text" class="input-field" name="model-source-path" id="model-source-path-input" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(appT('models.sources.addPlaceholder', 'Folder path, e.g. I:\\ComfyUI\\ComfyUI or \\\\NAS\\models'))}">
                    <button type="submit" class="btn btn-ghost btn-small">${escapeHtml(appT('models.sources.addSubmit', 'Add'))}</button>
                </form>
            </article>`;
        if (state.formOpen) host.querySelector('#model-source-path-input')?.focus();
    }

    // ---- loading ---------------------------------------------------------------

    async function load({ rescan = false } = {}) {
        state.loading = true;
        const [detect, folders] = await Promise.allSettled([
            API.getModelSources({ rescan }),
            API.getTrustedModelFolders(),
        ]);
        state.loading = false;
        state.failed = detect.status === 'rejected';
        if (detect.status === 'fulfilled') state.detect = detect.value;
        state.folders = folders.status === 'fulfilled' && Array.isArray(folders.value?.folders)
            ? folders.value.folders
            : null;
        render();
        return state;
    }

    async function watchScan(generation) {
        for (let attempt = 0; attempt < SCAN_POLL_LIMIT && isScanRunning(); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, SCAN_POLL_MS));
            if (generation !== state.pollGeneration) return;
            await load();
        }
    }

    /** Loads the card; waits for the drive scan to finish before asking about what it found. */
    async function refresh({ rescan = false } = {}) {
        state.pollGeneration += 1;
        const generation = state.pollGeneration;
        await load({ rescan });
        await watchScan(generation);
        if (generation === state.pollGeneration) await maybeAsk();
    }

    async function refreshAll() {
        try {
            const status = await API.getModelStatus();
            renderModelManager(status.models || []);
        } catch (_error) {
            // The card list keeps what it had; the sources card still refreshes.
        }
        await refresh();
        document.dispatchEvent(new CustomEvent('model-status-changed', { detail: { modelId: null } }));
    }

    // ---- adding and removing ---------------------------------------------------

    function confirmDialog({ title, message, okText, cancelText, align = 'left' }) {
        return new Promise((resolve) => {
            const restore = () => {
                unlockDynamicI18nText('#btn-confirm-ok', 'modal.yes', 'Yes, proceed');
                unlockDynamicI18nText('#btn-confirm-cancel', 'modal.cancel', 'Cancel');
                const messageEl = document.getElementById('confirm-message');
                if (messageEl) {
                    messageEl.style.whiteSpace = '';
                    messageEl.style.textAlign = '';
                }
            };
            showConfirm(title, message, () => { restore(); resolve(true); }, () => { restore(); resolve(false); }, { tone: 'primary' });
            const messageEl = document.getElementById('confirm-message');
            if (messageEl) {
                messageEl.style.whiteSpace = 'pre-line';
                messageEl.style.textAlign = align;
            }
            lockDynamicI18nText('#btn-confirm-ok', 'modal.yes');
            lockDynamicI18nText('#btn-confirm-cancel', 'modal.cancel');
            $('#btn-confirm-ok').textContent = okText;
            $('#btn-confirm-cancel').textContent = cancelText;
        });
    }

    function confirmWideFolder(path, reason) {
        const reasonText = label(WIDE_REASONS, reason);
        return confirmDialog({
            title: appT('models.sources.wideTitle', 'Trust this whole folder?'),
            message: `${path}\n${appT('models.sources.wideBody', 'This folder is very broad ({reason}): every file under it would be trusted for loading. Trust it anyway?', { reason: reasonText })}`,
            okText: appT('models.sources.wideOk', 'Trust it anyway'),
            cancelText: appT('modal.cancel', 'Cancel'),
        });
    }

    /** Adds one folder; a very broad one shows the reason and waits for the user's yes. */
    async function addFolder(path, confirm = false) {
        try {
            await API.addTrustedModelFolder(path, confirm);
            return true;
        } catch (error) {
            const data = error?.apiData || {};
            if (error?.apiStatus === 400 && data.needs_confirm && !confirm) {
                return (await confirmWideFolder(path, data.reason)) ? addFolder(path, true) : false;
            }
            showToast(formatUserError(error, appT('models.sources.addFailed', 'Could not add the folder')), 'error');
            return false;
        }
    }

    async function addAndRefresh(paths) {
        let added = 0;
        for (const path of paths) {
            if (await addFolder(path)) added += 1;
        }
        if (!added) return 0;
        showToast(
            added === 1
                ? appT('models.sources.added', 'Folder added. Models found in it are used from now on.')
                : appT('models.sources.addedMany', '{count} folders added. Models found in them are used from now on.', { count: added }),
            'success',
        );
        await refreshAll();
        return added;
    }

    async function removeFolder(path) {
        try {
            await API.removeTrustedModelFolder(path);
        } catch (error) {
            showToast(formatUserError(error, appT('models.sources.removeFailed', 'Could not remove the folder')), 'error');
            return;
        }
        showToast(appT('models.sources.removed', 'Folder removed. The program no longer reads it.'), 'success');
        await refreshAll();
    }

    // ---- the one-time question ---------------------------------------------------

    function pendingSuggestions() {
        const later = readLater();
        return (state.detect?.suggestions || []).filter((row) => !later.has(pathKey(row.root)));
    }

    function askMessage(rows) {
        const total = _formatBulkBytes(state.detect?.suggested_reusable_bytes);
        const count = (row) => (Array.isArray(row.models) ? row.models.length : 0);
        const all = rows.reduce((sum, row) => sum + count(row), 0);
        const name = kindLabel(rows[0].kind);
        const head = rows.length === 1
            ? appT('models.sources.askOne', '{path} holds {count} models this program uses (about {size}).', { path: rows[0].root, count: all, size: total })
            : [
                appT('models.sources.askMany', 'These folders hold {count} models this program uses (about {size}):', { count: all, size: total }),
                ...rows.map((row) => appT('models.sources.askLine', '• {path} — {count} models', { path: row.root, count: count(row) })),
            ].join('\n');
        return [
            head,
            appT('models.sources.askUse', 'Add it to the trusted folders and use them directly, without downloading them again.'),
            appT('models.sources.askReadOnly', 'The program only reads these files. It never changes {name}.', { name }),
        ].join('\n');
    }

    async function maybeAsk() {
        if (state.askedThisOpen || isScanRunning() || !isModelsTabVisible()) return;
        const rows = pendingSuggestions();
        if (!rows.length) return;
        state.askedThisOpen = true;
        const hasComfy = rows.some((row) => row.kind === 'comfyui');
        const yes = await confirmDialog({
            title: hasComfy
                ? appT('models.sources.askTitleComfy', 'Found ComfyUI')
                : appT('models.sources.askTitleModels', 'Found models you can reuse'),
            message: askMessage(rows),
            okText: appT('models.sources.askUseOk', 'Add and use'),
            cancelText: appT('models.sources.askLater', 'Later'),
            align: 'left',
        });
        if (!yes) {
            writeLater(rows.map((row) => row.root));
            return;
        }
        await addAndRefresh(rows.map((row) => row.root));
    }

    // ---- events --------------------------------------------------------------------

    async function onAction(button) {
        const action = button.dataset.msAction;
        if (action === 'rescan') {
            writeLater(null);
            state.askedThisOpen = false;
            await refresh({ rescan: true });
        } else if (action === 'toggle-add') {
            state.formOpen = !state.formOpen;
            render();
        } else if (action === 'remove') {
            await removeFolder(button.dataset.path);
        } else if (action === 'add-hint') {
            await addAndRefresh([button.dataset.path]);
        }
    }

    async function onSubmit(form) {
        const input = form.querySelector('input');
        const path = (window.unquotePath ? window.unquotePath(input.value) : input.value).trim();
        if (!path) {
            showToast(appT('models.sources.pathRequired', 'Enter a folder path first.'), 'warning');
            return;
        }
        if (await addAndRefresh([path])) state.formOpen = false;
        render();
    }

    function bind() {
        const host = section();
        if (!host || state.bound) return;
        state.bound = true;
        host.addEventListener('click', (event) => {
            const button = event.target.closest('[data-ms-action]');
            if (button && host.contains(button)) onAction(button);
        });
        host.addEventListener('submit', (event) => {
            event.preventDefault();
            const form = event.target.closest('[data-ms-form]');
            if (form) onSubmit(form);
        });
        document.addEventListener('languageChanged', () => { if (state.detect || state.failed) render(); });
        document.addEventListener('settings-tab-activated', (event) => {
            if (event.detail?.tab === 'models') maybeAsk();
        });
    }

    /** Called each time the Model Center opens. */
    function open() {
        bind();
        state.askedThisOpen = false;
        state.formOpen = false;
        return refresh();
    }

    window.ModelSources = { open, refresh, kindLabel, verifyLabel: (verify) => label(VERIFY_LABELS, verify), shortPath };
})();
