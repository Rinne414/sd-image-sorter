/**
 * SD Image Sorter — Publish Set workbench (v3.5.0 Tier 1, Pixiv 成套發布).
 *
 * Flow: pick images in the gallery (selection bar → More → Publish set…),
 * drag them into publish order, pair each with its censored variant
 * ({stem}{suffix}.{ext} — resolved by POST /api/publish/censor-pairs), then
 * export as sequentially named files (01.png, 02.jpg, …) plus an optional
 * caption.txt via POST /api/publish/export.
 *
 * The workbench is deliberately stateless on the backend: the list order in
 * this modal IS the publish order sent to the export endpoint.
 *
 * From Censor Edit the queue arrives with its results: each censored image
 * was rendered into a staging folder and its file travels with the entry
 * (pair.source === 'censor'), together with any name given there. Nothing
 * goes out uncensored without the user picking that in the check before
 * export, and generation info is removed unless the user keeps it.
 */
(function () {
    'use strict';

    const SETTINGS_KEY = 'sd-sorter-publish-settings';
    const METADATA_OPTIONS = ['strip', 'keep', 'minimal'];

    const STATE = {
        items: [],        // {id, filename, path, width, height, fileSize, pair, useCensored, outputName, censorFailed}
        handoff: new Map(), // id -> {censoredPath, censoredName, outputName, censorFailed} from Censor Edit
        loading: false,
        exporting: false,
        dragIndex: -1,
        pendingCheck: null, // resolver of the open "not censored" check
    };

    function $(id) { return document.getElementById(id); }

    function t(key, fallback, params) {
        const i18n = window.I18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params);
            if (value && value !== key) return value;
        }
        let text = fallback || key;
        if (params) {
            Object.keys(params).forEach((name) => {
                text = text.split('{' + name + '}').join(String(params[name]));
            });
        }
        return text;
    }

    function showToast(message, kind) {
        if (typeof window.showToast === 'function') {
            window.showToast(message, kind || 'info');
        }
    }

    // ------------------------------------------------------------------
    // Settings persistence (folder / prefix / numbering / suffix / overwrite)
    // ------------------------------------------------------------------

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            const saved = raw ? JSON.parse(raw) : null;
            if (!saved || typeof saved !== 'object') return;
            if (typeof saved.folder === 'string') $('pub-folder').value = saved.folder;
            if (typeof saved.prefix === 'string') $('pub-prefix').value = saved.prefix;
            if (Number.isFinite(saved.start)) $('pub-start').value = String(saved.start);
            if (saved.pad && ['1', '2', '3', '4'].includes(String(saved.pad))) {
                $('pub-pad').value = String(saved.pad);
            }
            if (typeof saved.suffix === 'string' && saved.suffix) $('pub-suffix').value = saved.suffix;
            $('pub-overwrite').checked = !!saved.overwrite;
            $('pub-watermark-enabled').checked = !!saved.watermarkEnabled;
            if (typeof saved.watermarkText === 'string') $('pub-watermark-text').value = saved.watermarkText;
            if (typeof saved.watermarkPosition === 'string') $('pub-watermark-position').value = saved.watermarkPosition;
            if (Number.isFinite(saved.watermarkOpacity)) $('pub-watermark-opacity').value = String(saved.watermarkOpacity);
            if (Number.isFinite(saved.watermarkSize)) $('pub-watermark-size').value = String(saved.watermarkSize);
            if (Number.isFinite(saved.watermarkMargin)) $('pub-watermark-margin').value = String(saved.watermarkMargin);
            if (typeof saved.watermarkColor === 'string') $('pub-watermark-color').value = saved.watermarkColor;
            if (METADATA_OPTIONS.includes(saved.metadataOption)) $('pub-metadata-option').value = saved.metadataOption;
            syncWatermarkControls();
        } catch (err) { /* corrupted settings are non-fatal */ }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({
                folder: $('pub-folder').value,
                prefix: $('pub-prefix').value,
                start: parseInt($('pub-start').value, 10) || 1,
                pad: $('pub-pad').value,
                suffix: $('pub-suffix').value,
                overwrite: $('pub-overwrite').checked,
                watermarkEnabled: $('pub-watermark-enabled').checked,
                watermarkText: $('pub-watermark-text').value,
                watermarkPosition: $('pub-watermark-position').value,
                watermarkOpacity: Number($('pub-watermark-opacity').value),
                watermarkSize: Number($('pub-watermark-size').value),
                watermarkMargin: Number($('pub-watermark-margin').value),
                watermarkColor: $('pub-watermark-color').value,
                metadataOption: currentMetadataOption(),
            }));
        } catch (err) { /* storage full/blocked is non-fatal */ }
    }

    // Generation info leaves the set unless the user keeps it on purpose.
    function currentMetadataOption() {
        const value = $('pub-metadata-option')?.value;
        return METADATA_OPTIONS.includes(value) ? value : 'strip';
    }

    // ------------------------------------------------------------------
    // Data loading + pairing
    // ------------------------------------------------------------------

    function currentSuffix() {
        const raw = ($('pub-suffix').value || '').trim();
        return raw || '_censored';
    }

    function readWatermarkInteger(id, minimum, maximum) {
        const value = Number($(id).value);
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
            throw new Error(`${id} must be an integer from ${minimum} to ${maximum}`);
        }
        return value;
    }

    function currentWatermark() {
        const enabled = $('pub-watermark-enabled').checked;
        const config = {
            enabled,
            text: $('pub-watermark-text').value || '',
            position: $('pub-watermark-position').value,
            opacity: readWatermarkInteger('pub-watermark-opacity', 1, 100),
            size_percent: readWatermarkInteger('pub-watermark-size', 1, 20),
            margin_percent: readWatermarkInteger('pub-watermark-margin', 0, 10),
            color: $('pub-watermark-color').value,
        };
        if (enabled && !config.text.trim()) {
            throw new Error(t('pub.watermarkTextRequired', 'Enter watermark text first'));
        }
        return config;
    }

    function syncWatermarkControls() {
        const enabled = $('pub-watermark-enabled')?.checked === true;
        const panel = $('pub-watermark-panel');
        if (panel) panel.open = enabled;
        [
            'pub-watermark-text', 'pub-watermark-position', 'pub-watermark-opacity',
            'pub-watermark-size', 'pub-watermark-margin', 'pub-watermark-color',
        ].forEach((id) => {
            if ($(id)) $(id).disabled = !enabled;
        });
    }

    async function fetchPairs(ids) {
        const response = await fetch('/api/publish/censor-pairs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_ids: ids, censor_suffix: currentSuffix() }),
        });
        if (!response.ok) throw new Error('censor-pairs HTTP ' + response.status);
        return response.json();
    }

    // A result handed over by Censor Edit wins over pairing by file name.
    function pairFromEntry(entry) {
        const handoff = STATE.handoff.get(entry.image_id);
        if (handoff && handoff.censoredPath) {
            return {
                path: handoff.censoredPath,
                filename: handoff.censoredName || entry.filename,
                source: 'censor',
            };
        }
        if (!entry.found) return null;
        return {
            path: entry.censored_path,
            filename: entry.censored_filename,
            source: entry.censored_source,
        };
    }

    async function loadItems(ids) {
        STATE.loading = true;
        renderStatus();
        try {
            const data = await fetchPairs(ids);
            const wantCensored = $('pub-master-censored').checked;
            const missing = data.pairs.filter((entry) => entry.missing).length;
            STATE.items = data.pairs
                .filter((entry) => !entry.missing)
                .map((entry) => {
                    const pair = pairFromEntry(entry);
                    const handoff = STATE.handoff.get(entry.image_id) || {};
                    return {
                        id: entry.image_id,
                        filename: entry.filename,
                        path: entry.path,
                        width: entry.width,
                        height: entry.height,
                        fileSize: entry.file_size,
                        pair: pair,
                        useCensored: wantCensored && !!pair,
                        outputName: handoff.outputName || '',
                        censorFailed: !!handoff.censorFailed,
                    };
                });
            if (missing > 0) {
                showToast(t('pub.missingSkipped', '{count} image(s) were not found in the library and were skipped', { count: missing }), 'warning');
            }
        } catch (err) {
            showToast(t('pub.loadFailed', 'Could not load the publish set'), 'error');
        } finally {
            STATE.loading = false;
            render();
        }
    }

    // The set can grow from the Gallery too: whatever is selected there now
    // (picked images or all matching) joins the end of the set.
    async function addGallerySelection() {
        if (STATE.loading) return;
        const expand = window.expandGallerySelectionIds;
        const picked = typeof expand === 'function' ? await expand() : [];
        if (!picked.length) {
            showToast(t('pub.nothingSelected', 'Nothing is selected in the Gallery yet'), 'info');
            return;
        }
        const existing = STATE.items.map((item) => item.id);
        const seen = new Set(existing);
        await loadItems(existing.concat(picked.filter((id) => !seen.has(id))));
    }

    async function rePair() {
        if (!STATE.items.length || STATE.loading) return;
        STATE.loading = true;
        renderStatus();
        try {
            const data = await fetchPairs(STATE.items.map((item) => item.id));
            const byId = new Map(data.pairs.map((entry) => [entry.image_id, entry]));
            STATE.items = STATE.items.map((item) => {
                const entry = byId.get(item.id);
                // A Censor Edit result survives; only name-based matches refresh.
                const pair = entry && !entry.missing ? pairFromEntry(entry) : null;
                return Object.assign({}, item, {
                    pair: pair,
                    useCensored: item.useCensored && !!pair,
                });
            });
            showToast(t('pub.repaired', 'Censor pairing refreshed'), 'success');
        } catch (err) {
            showToast(t('pub.loadFailed', 'Could not load the publish set'), 'error');
        } finally {
            STATE.loading = false;
            render();
        }
    }

    // ------------------------------------------------------------------
    // Rendering (createElement only — no HTML strings)
    // ------------------------------------------------------------------

    function fmtBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '';
        if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
        return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    }

    function numberingFor(position) {
        const start = Math.max(0, parseInt($('pub-start').value, 10) || 1);
        const pad = Math.min(4, Math.max(1, parseInt($('pub-pad').value, 10) || 2));
        return String(start + position).padStart(pad, '0');
    }

    function splitName(name) {
        const text = String(name || '');
        const dot = text.lastIndexOf('.');
        return dot > 0 ? { stem: text.slice(0, dot), ext: text.slice(dot).toLowerCase() } : { stem: text, ext: '' };
    }

    function useCensorNames() {
        return $('pub-use-censor-names').checked && STATE.items.some((item) => item.outputName);
    }

    // Mirrors the server: a Censor Edit name when one is used, else the
    // numbered name; the extension always follows the file that goes out.
    function exportNameFor(item, position) {
        const source = item.useCensored && item.pair ? item.pair.filename : item.filename;
        const ext = splitName(source).ext || '.png';
        if (useCensorNames() && item.outputName) return splitName(item.outputName).stem + ext;
        return ($('pub-prefix').value || '').trim() + numberingFor(position) + ext;
    }

    async function revealExportedFile(path) {
        try {
            const response = await fetch('/api/output-folders/reveal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path }),
            });
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                showToast(body.detail || t('pub.openFolderFailed', 'Could not open the folder'), 'warning');
            }
        } catch (err) {
            showToast(String(err && err.message || err), 'warning');
        }
    }

    // The empty folder field exports into output/publish; say where that is.
    async function refreshDefaultFolderPlaceholder() {
        try {
            const response = await fetch('/api/output-folders');
            if (!response.ok) return;
            const data = await response.json();
            if (data && data.folders && data.folders.publish) {
                $('pub-folder').placeholder = t('pub.folderDefault', 'Empty = {path}', { path: data.folders.publish });
            }
        } catch (err) { /* the placeholder is only a hint */ }
    }

    function makeEl(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function renderStatus() {
        const paired = STATE.items.filter((item) => item.pair).length;
        const count = $('pub-count');
        if (STATE.loading) {
            count.textContent = t('pub.loading', 'Loading…');
        } else if (STATE.items.length) {
            count.textContent = t('pub.countSummary', '{count} images · {paired} censored pairs', {
                count: STATE.items.length, paired: paired,
            });
        } else {
            count.textContent = '';
        }
        $('pub-empty').hidden = STATE.items.length > 0 || STATE.loading;
        $('pub-censor-names-label').hidden = !STATE.items.some((item) => item.outputName);
        $('btn-pub-export').disabled = STATE.exporting || STATE.loading || !STATE.items.length;
        $('btn-pub-repair').disabled = STATE.loading || !STATE.items.length;
        $('btn-pub-add-selection').disabled = STATE.loading;
    }

    function buildVariantToggle(item, index) {
        const wrap = makeEl('div', 'pub-variant-toggle');
        const original = makeEl('button', 'pub-variant-btn' + (item.useCensored ? '' : ' active'),
            t('pub.variantOriginal', 'Original'));
        original.type = 'button';
        original.addEventListener('click', () => {
            STATE.items[index].useCensored = false;
            render();
        });
        const censored = makeEl('button', 'pub-variant-btn' + (item.useCensored ? ' active' : ''),
            t('pub.variantCensored', 'Censored'));
        censored.type = 'button';
        censored.disabled = !item.pair;
        censored.addEventListener('click', () => {
            if (!STATE.items[index].pair) return;
            STATE.items[index].useCensored = true;
            render();
        });
        wrap.appendChild(original);
        wrap.appendChild(censored);
        return wrap;
    }

    function buildRow(item, index) {
        const row = makeEl('div', 'pub-item');
        row.draggable = true;
        row.dataset.index = String(index);
        row.dataset.imageId = String(item.id);

        row.addEventListener('dragstart', (event) => {
            STATE.dragIndex = index;
            row.classList.add('dragging');
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
            }
        });
        row.addEventListener('dragend', () => {
            STATE.dragIndex = -1;
            row.classList.remove('dragging');
            clearDropMarkers();
        });
        row.addEventListener('dragover', (event) => {
            if (STATE.dragIndex < 0) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            const rect = row.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            row.classList.toggle('pub-drop-before', before);
            row.classList.toggle('pub-drop-after', !before);
        });
        row.addEventListener('dragleave', () => {
            row.classList.remove('pub-drop-before', 'pub-drop-after');
        });
        row.addEventListener('drop', (event) => {
            if (STATE.dragIndex < 0) return;
            event.preventDefault();
            const rect = row.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            moveItem(STATE.dragIndex, index + (before ? 0 : 1));
        });

        const handle = makeEl('span', 'pub-item-handle', '≡');
        handle.setAttribute('aria-hidden', 'true');
        handle.title = t('pub.dragHint', 'Drag to reorder');
        row.appendChild(handle);

        row.appendChild(makeEl('span', 'pub-item-number', '#' + numberingFor(index)));

        const thumb = document.createElement('img');
        thumb.className = 'pub-item-thumb';
        thumb.loading = 'lazy';
        thumb.alt = item.filename || '';
        thumb.src = '/api/image-thumbnail/' + item.id + '?size=256';
        row.appendChild(thumb);

        const meta = makeEl('div', 'pub-item-meta');
        meta.appendChild(makeEl('div', 'pub-item-name', item.filename || ('#' + item.id)));
        const dims = (item.width && item.height) ? (item.width + '×' + item.height + ' · ') : '';
        meta.appendChild(makeEl('div', 'pub-item-facts', dims + fmtBytes(item.fileSize)));
        const pairLine = makeEl('div', 'pub-item-pair ' + (item.pair ? 'is-paired' : 'is-unpaired'));
        if (item.pair && item.pair.source === 'censor') {
            pairLine.textContent = t('pub.pairFromCensor', 'Censored in Censor Edit');
            pairLine.title = item.pair.path;
        } else if (item.pair) {
            pairLine.textContent = item.pair.filename;
            pairLine.title = item.pair.path;
        } else if (item.censorFailed) {
            pairLine.textContent = t('pub.censorPrepareFailed', '— the censored result could not be prepared');
        } else {
            pairLine.textContent = t('pub.noPair', '— no censored version found');
        }
        meta.appendChild(pairLine);
        meta.appendChild(makeEl('div', 'pub-item-outname',
            t('pub.exportsAs', 'Exports as {name}', { name: exportNameFor(item, index) })));
        row.appendChild(meta);

        row.appendChild(buildVariantToggle(item, index));

        const remove = makeEl('button', 'pub-item-remove', '✕');
        remove.type = 'button';
        remove.title = t('pub.removeItem', 'Remove from this set');
        remove.addEventListener('click', () => {
            STATE.items.splice(index, 1);
            render();
        });
        row.appendChild(remove);

        return row;
    }

    function clearDropMarkers() {
        document.querySelectorAll('.pub-item.pub-drop-before, .pub-item.pub-drop-after')
            .forEach((node) => node.classList.remove('pub-drop-before', 'pub-drop-after'));
    }

    function moveItem(from, to) {
        if (from < 0 || from >= STATE.items.length) return;
        const insertAt = from < to ? to - 1 : to;
        const clamped = Math.max(0, Math.min(STATE.items.length - 1, insertAt));
        if (clamped === from) { clearDropMarkers(); return; }
        const next = STATE.items.slice();
        const moved = next.splice(from, 1)[0];
        next.splice(clamped, 0, moved);
        STATE.items = next;
        render();
    }

    function render() {
        // The list the "not censored" check named may no longer be the set.
        answerUncensoredCheck('cancel');
        const list = $('pub-items');
        list.replaceChildren();
        STATE.items.forEach((item, index) => list.appendChild(buildRow(item, index)));
        renderStatus();
        syncNamingFields();
    }

    // Censor Edit names replace the numbered names, so prefix / start / digits
    // do nothing then; say so instead of leaving them looking active.
    function syncNamingFields() {
        const censorNames = useCensorNames();
        ['pub-prefix', 'pub-start', 'pub-pad'].forEach((id) => {
            const field = $(id);
            if (!field) return;
            field.disabled = censorNames;
            field.title = censorNames
                ? t('pub.namesFromCensorHint', 'The file names from Censor Edit are used, so prefix and numbering do not apply.')
                : '';
        });
    }

    // ------------------------------------------------------------------
    // Export
    // ------------------------------------------------------------------

    function metadataSummary(option) {
        if (option === 'keep') return t('pub.metadataKeptNote', 'original generation info kept');
        if (option === 'minimal') return t('pub.metadataMinimalNote', 'only basic info kept');
        return t('pub.metadataStrippedNote', 'generation info removed');
    }

    function renderExportResult(result, { leftOut = 0 } = {}) {
        const box = $('pub-result');
        box.replaceChildren();
        box.hidden = false;
        const summary = makeEl('div', 'pub-result-line pub-result-ok',
            t('pub.exportedSummary', 'Exported {count} file(s) to {folder}', {
                count: result.exported.length, folder: result.output_folder,
            }) + ' · ' + metadataSummary(result.metadata_option));
        box.appendChild(summary);
        if (result.reveal_path) {
            const reveal = makeEl('button', 'btn btn-ghost btn-small pub-result-open', t('pub.openFolder', 'Open folder'));
            reveal.type = 'button';
            reveal.addEventListener('click', () => revealExportedFile(result.reveal_path));
            summary.appendChild(reveal);
        }
        result.exported.forEach((entry) => {
            const variant = entry.used_censored
                ? t('pub.resultCensored', 'censored')
                : t('pub.resultOriginal', 'original, not censored');
            box.appendChild(makeEl('div',
                'pub-result-line pub-result-file' + (entry.used_censored ? '' : ' pub-result-warn'),
                entry.output_name + ' ← ' + variant));
        });
        if (result.caption_file) {
            box.appendChild(makeEl('div', 'pub-result-line',
                '📝 ' + t('pub.captionWritten', 'Caption saved as {name}', { name: result.caption_file })));
        }
        if (leftOut > 0) {
            box.appendChild(makeEl('div', 'pub-result-line pub-result-warn',
                t('pub.leftOutUncensored', '{count} picture(s) without a censored version were left out.', { count: leftOut })));
        }
        if (result.skipped_existing.length) {
            box.appendChild(makeEl('div', 'pub-result-line pub-result-warn',
                t('pub.skippedExisting', '{count} file(s) already existed and were skipped (enable Overwrite to replace)', {
                    count: result.skipped_existing.length,
                })));
        }
        result.errors.forEach((entry) => {
            const item = STATE.items.find((candidate) => candidate.id === entry.image_id);
            const name = item ? item.filename : (entry.image_id !== null ? '#' + entry.image_id : 'caption.txt');
            box.appendChild(makeEl('div', 'pub-result-line pub-result-error', '✗ ' + name + ' — ' + entry.error));
        });
    }

    function uncensoredReason(item) {
        if (item.censorFailed) return t('pub.reasonPrepareFailed', 'the censored result could not be prepared');
        if (!item.pair) return t('pub.reasonNoPair', 'no censored version found');
        return t('pub.reasonChoseOriginal', 'set to Original');
    }

    function answerUncensoredCheck(choice) {
        const resolve = STATE.pendingCheck;
        if (!resolve) return;
        STATE.pendingCheck = null;
        $('pub-uncensored-check').hidden = true;
        resolve(choice);
    }

    // Images that would go out uncensored are named before anything is
    // written. Cancel is the default; exporting them as they are is a choice.
    function askAboutUncensored(items) {
        answerUncensoredCheck('cancel');
        const panel = $('pub-uncensored-check');
        $('pub-uncensored-title').textContent = t('pub.uncensoredTitle',
            '{count} image(s) would be exported uncensored, with the original pixels:', { count: items.length });
        const list = $('pub-uncensored-list');
        list.replaceChildren();
        items.forEach((item) => {
            list.appendChild(makeEl('li', null, (item.filename || ('#' + item.id)) + ' — ' + uncensoredReason(item)));
        });
        $('btn-pub-uncensored-skip').hidden = items.length === STATE.items.length;
        panel.hidden = false;
        panel.scrollIntoView({ block: 'nearest' });
        $('btn-pub-uncensored-cancel').focus();
        return new Promise((resolve) => { STATE.pendingCheck = resolve; });
    }

    function exportItemPayload(item) {
        const payload = { image_id: item.id, use_censored: item.useCensored };
        if (item.useCensored && item.pair && item.pair.source === 'censor') payload.censored_path = item.pair.path;
        if (useCensorNames() && item.outputName) payload.output_name = item.outputName;
        return payload;
    }

    async function runExport() {
        if (!STATE.items.length || STATE.exporting) return;
        // An empty folder is allowed: the server exports into output/publish.
        const folder = ($('pub-folder').value || '').trim();
        saveSettings();
        let watermark;
        try {
            watermark = currentWatermark();
        } catch (err) {
            showToast(String(err && err.message || err), 'warning');
            $('pub-watermark-text')?.focus();
            return;
        }
        let exportItems = STATE.items;
        let leftOut = 0;
        const uncensored = STATE.items.filter((item) => !item.useCensored);
        if (uncensored.length) {
            const choice = await askAboutUncensored(uncensored);
            if (choice === 'cancel') return;
            if (choice === 'skip') {
                exportItems = STATE.items.filter((item) => item.useCensored);
                leftOut = uncensored.length;
            }
        }
        const metadataOption = currentMetadataOption();
        STATE.exporting = true;
        renderStatus();
        const button = $('btn-pub-export');
        button.textContent = t('pub.exporting', 'Exporting…');
        try {
            const response = await fetch('/api/publish/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items: exportItems.map(exportItemPayload),
                    metadata_option: metadataOption,
                    output_folder: folder,
                    name_prefix: $('pub-prefix').value || '',
                    start_index: Math.max(0, parseInt($('pub-start').value, 10) || 1),
                    pad_width: Math.min(4, Math.max(1, parseInt($('pub-pad').value, 10) || 2)),
                    caption_text: $('pub-caption').value || '',
                    censor_suffix: currentSuffix(),
                    overwrite: $('pub-overwrite').checked,
                    watermark,
                }),
            });
            if (!response.ok) {
                let detail = 'HTTP ' + response.status;
                try {
                    const body = await response.json();
                    if (body && body.detail) detail = String(body.detail);
                } catch (parseErr) { /* non-JSON error body */ }
                showToast(t('pub.exportFailed', 'Export failed: {error}', { error: detail }), 'error');
                return;
            }
            const result = await response.json();
            renderExportResult(result, { leftOut });
            if (result.success && result.exported.length) {
                const censoredCount = result.exported.filter((entry) => entry.used_censored).length;
                showToast(t('pub.exportDoneDetail',
                    'Publish set exported: {censored} censored, {original} original · {metadata}', {
                        censored: censoredCount,
                        original: result.exported.length - censoredCount,
                        metadata: metadataSummary(result.metadata_option),
                    }), censoredCount === result.exported.length ? 'success' : 'warning');
            } else if (result.errors.length) {
                showToast(t('pub.exportPartial', 'Export finished with {count} error(s); see details', {
                    count: result.errors.length,
                }), 'warning');
            }
        } catch (err) {
            showToast(t('pub.exportFailed', 'Export failed: {error}', { error: String(err && err.message || err) }), 'error');
        } finally {
            STATE.exporting = false;
            button.textContent = t('pub.export', 'Export set');
            renderStatus();
        }
    }

    // ------------------------------------------------------------------
    // Modal shell
    // ------------------------------------------------------------------

    function isOpen() {
        const modal = $('publish-set-modal');
        return !!modal && modal.classList.contains('visible');
    }

    // Entries are image ids (Gallery) or, from Censor Edit, objects carrying
    // the handed-over result: {id, censoredPath, censoredName, outputName, censorFailed}.
    function open(entries) {
        const modal = $('publish-set-modal');
        if (!modal) return;
        loadSettings();
        refreshDefaultFolderPlaceholder();
        modal.classList.add('visible');
        $('pub-result').hidden = true;
        $('pub-result').replaceChildren();
        STATE.handoff = new Map();
        const ids = [];
        (Array.isArray(entries) ? entries : []).forEach((entry) => {
            const isObject = entry !== null && typeof entry === 'object';
            const id = Number(isObject ? entry.id : entry);
            if (!Number.isFinite(id)) return;
            ids.push(id);
            if (isObject) {
                STATE.handoff.set(id, {
                    censoredPath: entry.censoredPath || '',
                    censoredName: entry.censoredName || '',
                    outputName: entry.outputName || '',
                    censorFailed: !!entry.censorFailed,
                });
            }
        });
        if (ids.length) {
            loadItems(ids);
        } else {
            STATE.items = [];
            render();
        }
    }

    function close() {
        answerUncensoredCheck('cancel');
        const modal = $('publish-set-modal');
        if (modal) modal.classList.remove('visible');
    }

    function onMasterToggle() {
        const wantCensored = $('pub-master-censored').checked;
        STATE.items = STATE.items.map((item) => Object.assign({}, item, {
            useCensored: wantCensored && !!item.pair,
        }));
        render();
    }

    function wire() {
        const modal = $('publish-set-modal');
        if (!modal) return;

        $('nav-tools-publish-set')?.addEventListener('click', () => {
            const menu = $('nav-tools-menu');
            if (menu) menu.hidden = true;
            open();
        });
        $('btn-close-publish-set')?.addEventListener('click', close);
        modal.querySelector('.modal-backdrop')?.addEventListener('click', close);
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !isOpen() || STATE.exporting) return;
            // Esc answers the open check first; the workbench stays open.
            if (STATE.pendingCheck) {
                event.preventDefault();
                answerUncensoredCheck('cancel');
                return;
            }
            close();
        });

        $('btn-pub-export')?.addEventListener('click', runExport);
        $('btn-pub-uncensored-cancel')?.addEventListener('click', () => answerUncensoredCheck('cancel'));
        $('btn-pub-uncensored-skip')?.addEventListener('click', () => answerUncensoredCheck('skip'));
        $('btn-pub-uncensored-include')?.addEventListener('click', () => answerUncensoredCheck('include'));
        $('pub-metadata-option')?.addEventListener('change', saveSettings);
        $('pub-use-censor-names')?.addEventListener('change', render);
        $('pub-prefix')?.addEventListener('change', render);
        $('btn-pub-repair')?.addEventListener('click', rePair);
        $('btn-pub-add-selection')?.addEventListener('click', addGallerySelection);
        $('pub-master-censored')?.addEventListener('change', onMasterToggle);
        $('pub-suffix')?.addEventListener('change', () => { saveSettings(); rePair(); });
        ['pub-start', 'pub-pad'].forEach((id) => {
            $(id)?.addEventListener('change', () => { saveSettings(); render(); });
        });
        ['pub-folder', 'pub-prefix', 'pub-overwrite'].forEach((id) => {
            $(id)?.addEventListener('change', saveSettings);
        });
        $('pub-watermark-enabled')?.addEventListener('change', () => {
            syncWatermarkControls();
            saveSettings();
        });
        [
            'pub-watermark-text', 'pub-watermark-position', 'pub-watermark-opacity',
            'pub-watermark-size', 'pub-watermark-margin', 'pub-watermark-color',
        ].forEach((id) => $(id)?.addEventListener('change', saveSettings));
        syncWatermarkControls();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }

    window.PublishSet = { open: open, close: close, isOpen: isOpen };
})();
