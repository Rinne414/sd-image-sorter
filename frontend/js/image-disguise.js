/**
 * SD Image Sorter - Chat disguise mode of the Privacy Tools page.
 *
 * A chat disguise shows a cover in the chat list and the real picture when
 * it is opened. This module is the third mode of the same page as the
 * obfuscation modes: it reuses ImageObfuscator's queue, drop zone, paste,
 * library hand-off, download and zip, and only adds the cover settings,
 * the server calls, and copying the result as a FILE (a browser copy would
 * paste a one-frame bitmap and lose the hidden picture).
 */

(function () {
    'use strict';

    const MODE_VALUE = 'chat_disguise';
    const STORAGE_PREFIX = 'disguise_';
    const DEFAULT_MAX_SIDE = 1600;
    const DEFAULT_FRAME_SECONDS = 1;

    function readSetting(key, fallback) {
        try {
            const value = localStorage.getItem(STORAGE_PREFIX + key);
            return value === null ? fallback : value;
        } catch (_) {
            return fallback;
        }
    }

    function writeSetting(key, value) {
        try {
            localStorage.setItem(STORAGE_PREFIX + key, String(value));
        } catch (_) {
            // Private window or blocked storage: settings just are not remembered.
        }
    }

    function byId(id) {
        return document.getElementById(id);
    }

    const ImageDisguise = {
        _obfuscator: null,
        _uploadCover: null,
        _uploadCoverUrl: '',
        _hasDefaultCover: false,
        _packResult: null,
        _afterDefaultCover: null,
        _bound: false,

        init(obfuscator) {
            this._obfuscator = obfuscator;
            if (this._bound) return;
            this._bound = true;
            this._restoreSettings();
            this._bindSettings();
            this._refreshDefaultCover();
        },

        isActive() {
            return byId('obfuscate-compat-mode')?.value === MODE_VALUE;
        },

        _t(key, fallback, params) {
            const value = window.I18n?.t?.(key, params);
            if (value && value !== key) return value;
            return String(fallback).replace(/\{(\w+)\}/g, (_, name) => (params && name in params ? params[name] : `{${name}}`));
        },

        // ── settings ────────────────────────────────────────────────

        _restoreSettings() {
            const set = (id, value) => { const el = byId(id); if (el) el.value = value; };
            set('disguise-cover-kind', readSetting('cover_kind', 'default'));
            set('disguise-text-input', readSetting('cover_text', this._t('disguise.defaultCoverText', 'Open to view')));
            set('disguise-text-bg', readSetting('cover_bg', '#26272b'));
            set('disguise-text-fg', readSetting('cover_fg', '#f2f2f2'));
            set('disguise-frame-seconds', readSetting('frame_seconds', String(DEFAULT_FRAME_SECONDS)));
            set('disguise-max-side', readSetting('max_side', String(DEFAULT_MAX_SIDE)));
            set('disguise-output-folder', readSetting('output_folder', ''));
            set('disguise-pack-format', readSetting('pack_format', 'disguise'));
            const pack = byId('disguise-pack');
            if (pack) pack.checked = readSetting('pack', '0') === '1';
            const scrub = byId('disguise-scrub');
            if (scrub) scrub.checked = readSetting('scrub', '1') === '1';
        },

        _bindSettings() {
            const remember = (id, key, read = (el) => el.value) => {
                byId(id)?.addEventListener('change', (event) => {
                    writeSetting(key, read(event.currentTarget));
                    this.syncUI();
                });
            };
            remember('disguise-cover-kind', 'cover_kind');
            remember('disguise-text-input', 'cover_text');
            remember('disguise-text-bg', 'cover_bg');
            remember('disguise-text-fg', 'cover_fg');
            remember('disguise-frame-seconds', 'frame_seconds');
            remember('disguise-max-side', 'max_side');
            remember('disguise-output-folder', 'output_folder');
            remember('disguise-pack-format', 'pack_format');
            remember('disguise-pack', 'pack', (el) => (el.checked ? '1' : '0'));
            remember('disguise-scrub', 'scrub', (el) => (el.checked ? '1' : '0'));
            byId('disguise-text-input')?.addEventListener('keydown', (event) => event.stopPropagation());
            byId('disguise-output-folder')?.addEventListener('keydown', (event) => event.stopPropagation());

            byId('disguise-upload-pick')?.addEventListener('click', () => byId('disguise-upload-file')?.click());
            byId('disguise-upload-file')?.addEventListener('change', (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) this._setUploadCover(file);
            });
            byId('disguise-upload-as-default')?.addEventListener('click', () => {
                if (this._uploadCover) this._saveDefaultCover(this._uploadCover);
            });
            byId('disguise-default-set')?.addEventListener('click', () => byId('disguise-default-file')?.click());
            byId('disguise-default-file')?.addEventListener('change', async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) await this._saveDefaultCover(file);
                if (this._afterDefaultCover) {
                    const next = this._afterDefaultCover;
                    this._afterDefaultCover = null;
                    if (this._hasDefaultCover) next();
                }
            });
            // Closing the picker without a file drops the pending "redo with default cover".
            byId('disguise-default-file')?.addEventListener('cancel', () => { this._afterDefaultCover = null; });
            byId('disguise-default-clear')?.addEventListener('click', () => this._clearDefaultCover());
            byId('disguise-redo-failed')?.addEventListener('click', () => this.redoWithDefaultCover('failed'));
            byId('disguise-redo-all')?.addEventListener('click', () => this.redoWithDefaultCover('all'));
            byId('disguise-btn-copy-all')?.addEventListener('click', () => this.copyAll());
            byId('disguise-pack-copy')?.addEventListener('click', () => this._packResult && this._copyTokens([this._packResult.token]));
            byId('disguise-pack-download')?.addEventListener('click', () => this._downloadPack());
            byId('disguise-pack-reveal')?.addEventListener('click', () => this._packResult && this.reveal(this._packResult.token));
        },

        _setUploadCover(file) {
            if (this._uploadCoverUrl) URL.revokeObjectURL(this._uploadCoverUrl);
            this._uploadCover = file;
            this._uploadCoverUrl = URL.createObjectURL(file);
            this.syncUI();
        },

        async _refreshDefaultCover() {
            try {
                const response = await fetch('/api/disguise/default-cover/info', { cache: 'no-store' });
                const info = response.ok ? await response.json() : { exists: false };
                this._hasDefaultCover = Boolean(info.exists);
                const thumb = byId('disguise-default-thumb');
                if (thumb && info.exists) thumb.src = `/api/disguise/default-cover?v=${info.version}`;
                else thumb?.removeAttribute('src');
            } catch (_) {
                this._hasDefaultCover = false;
            }
            this.syncUI();
        },

        async _saveDefaultCover(file) {
            const form = new FormData();
            form.append('file', file);
            const response = await fetch('/api/disguise/default-cover', { method: 'PUT', body: form });
            if (!response.ok) {
                this._toast(await this._errorText(response, this._t('disguise.defaultCoverFailed', 'Could not save the default cover')), 'error');
                return;
            }
            this._toast(this._t('disguise.defaultCoverSaved', 'Default cover saved'), 'success');
            await this._refreshDefaultCover();
        },

        async _clearDefaultCover() {
            await fetch('/api/disguise/default-cover', { method: 'DELETE' });
            await this._refreshDefaultCover();
        },

        _settings() {
            const seconds = Number.parseFloat(byId('disguise-frame-seconds')?.value || '');
            const maxSide = Number.parseInt(byId('disguise-max-side')?.value || '', 10);
            return {
                coverKind: byId('disguise-cover-kind')?.value || 'default',
                coverText: byId('disguise-text-input')?.value || '',
                coverBg: byId('disguise-text-bg')?.value || '#26272b',
                coverFg: byId('disguise-text-fg')?.value || '#f2f2f2',
                pack: Boolean(byId('disguise-pack')?.checked),
                // A pack can also be a plain looping GIF (no cover) for places without APNG.
                packFormat: byId('disguise-pack-format')?.value === 'gif' ? 'gif' : 'disguise',
                frameMs: Math.max(1, Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_FRAME_SECONDS) * 1000)),
                maxSide: Number.isFinite(maxSide) && maxSide >= 0 ? maxSide : DEFAULT_MAX_SIDE,
                scrub: byId('disguise-scrub')?.checked ?? true,
                outputFolder: (byId('disguise-output-folder')?.value || '').trim(),
            };
        },

        // The same detector the Censor page would use. A general YOLO model
        // would mosaic unrelated objects, so it falls back to NudeNet unless
        // the Censor page's selected YOLO model is a privacy-part detector.
        _detectorSettings() {
            const state = typeof CensorState !== 'undefined' ? CensorState : null;
            let modelType = byId('censor-model-type')?.value || 'nudenet';
            if (modelType === 'legacy') {
                const record = typeof getSelectedLegacyModelRecord === 'function' ? getSelectedLegacyModelRecord() : null;
                if (record?.profile !== 'privacy-censor') modelType = 'nudenet';
            }
            return {
                modelType,
                modelPath: modelType === 'legacy' || modelType === 'both' ? (state?.modelPath || '') : '',
                confidence: Number.isFinite(state?.confidence) ? state.confidence : 0.5,
                targets: Array.isArray(state?.targetClasses) ? state.targetClasses : [],
            };
        },

        syncUI() {
            const active = this.isActive();
            const settings = this._settings();
            const show = (id, visible) => { const el = byId(id); if (el) el.hidden = !visible; };

            show('disguise-settings', active);
            show('disguise-pack-format-row', settings.pack);
            show('disguise-cover-row', !(settings.pack && settings.packFormat === 'gif'));
            show('disguise-advanced', active);
            show('obfuscate-metadata-row', !active);
            show('obfuscate-legacy-row', !active);
            const password = byId('obfuscate-password');
            if (password && active) password.style.display = 'none';

            show('disguise-cover-default', settings.coverKind === 'default');
            show('disguise-cover-upload', settings.coverKind === 'upload');
            show('disguise-cover-text', settings.coverKind === 'text');
            show('disguise-cover-mosaic', settings.coverKind === 'mosaic');
            show('disguise-default-thumb', this._hasDefaultCover);
            show('disguise-default-empty', !this._hasDefaultCover);
            show('disguise-default-clear', this._hasDefaultCover);
            const uploadThumb = byId('disguise-upload-thumb');
            if (uploadThumb) {
                if (this._uploadCoverUrl) uploadThumb.src = this._uploadCoverUrl;
                else uploadThumb.removeAttribute('src');
                uploadThumb.hidden = !this._uploadCoverUrl;
            }
            show('disguise-upload-as-default', Boolean(this._uploadCover));
            const frameSeconds = byId('disguise-frame-seconds');
            if (frameSeconds) frameSeconds.disabled = !settings.pack;

            this._relabel('obfuscate-btn-encode', active ? 'disguise.make' : 'tools.encode', active ? 'Make disguise' : 'Protect');
            this._relabel('obfuscate-btn-decode', active ? 'disguise.restore' : 'tools.decode', 'Restore');
            const help = byId('obfuscate-compat-help');
            if (help && active) {
                help.dataset.i18nLocked = '1';
                help.textContent = this._t('disguise.help', 'The chat list shows the cover; opening the picture shows the real one.');
            }
            this.afterRender();
        },

        _relabel(buttonId, key, fallback) {
            const label = byId(buttonId)?.querySelector('span[data-i18n]');
            if (!label || label.dataset.i18n === key) return;
            label.dataset.i18n = key;
            label.textContent = this._t(key, fallback);
        },

        // ── running ─────────────────────────────────────────────────

        async run(mode, obfuscator) {
            this._obfuscator = obfuscator;
            if (!obfuscator._queue.length) {
                this._toast(this._t('tools.noQueue', 'No images in queue'), 'error');
                return;
            }
            if (obfuscator._processing) return;
            if (mode === 'decode') return this._guard(() => this._restoreAll());
            const settings = this._settings();
            const needsCover = !(settings.pack && settings.packFormat === 'gif');
            if (needsCover && settings.coverKind === 'upload' && !this._uploadCover) {
                this._toast(this._t('disguise.pickCoverFirst', 'Choose a cover picture first'), 'warning');
                return;
            }
            if (needsCover && settings.coverKind === 'mosaic') await this._ensureDetector();
            return this._guard(() => (settings.pack ? this._makePack(settings) : this._makeEach(obfuscator._queue, settings)));
        },

        async _guard(work) {
            const obfuscator = this._obfuscator;
            obfuscator._processing = true;
            try {
                await work();
            } finally {
                obfuscator._processing = false;
                obfuscator._renderQueue();
            }
        },

        async _ensureDetector() {
            const { modelType } = this._detectorSettings();
            if ((modelType === 'nudenet' || modelType === 'both') && typeof window.ensureFeatureModel === 'function') {
                // A missing detector is not fatal: those items come back as "needs a cover".
                await window.ensureFeatureModel('censor-nudenet', { label: 'NudeNet', sizeHint: '~12 MB', confirmBytes: 0 });
            }
        },

        _form(settings, items) {
            const form = new FormData();
            const sources = [];
            items.forEach((item) => {
                // A library image goes by id even if its file was fetched earlier:
                // the mosaic cover needs the library entry to run the detector.
                if (item.libraryImageId) {
                    sources.push({ image_id: item.libraryImageId });
                } else {
                    sources.push({ file_index: form.getAll('files').length });
                    form.append('files', item.file, item.name);
                }
            });
            form.append('sources', JSON.stringify(sources));
            form.append('cover_kind', settings.coverKind);
            if (settings.coverKind === 'upload' && this._uploadCover) form.append('cover_file', this._uploadCover);
            form.append('cover_text', settings.coverText);
            form.append('cover_background', settings.coverBg);
            form.append('cover_foreground', settings.coverFg);
            form.append('frame_ms', String(settings.frameMs));
            form.append('max_side', String(settings.maxSide));
            form.append('scrub', String(settings.scrub));
            form.append('output_folder', settings.outputFolder);
            if (items.length === 1) form.append('output_name', this._obfuscator._getBaseName(items[0]));
            if (settings.pack && settings.packFormat === 'gif') form.append('output_format', 'gif');
            if (settings.coverKind === 'mosaic') {
                const detector = this._detectorSettings();
                form.append('detect_model_type', detector.modelType);
                form.append('detect_model_path', detector.modelPath);
                form.append('detect_confidence', String(detector.confidence));
                form.append('detect_targets', JSON.stringify(detector.targets));
            }
            return form;
        },

        async _make(settings, items) {
            const response = await fetch('/api/disguise/make', { method: 'POST', body: this._form(settings, items) });
            if (!response.ok) {
                throw new Error(await this._errorText(response, this._t('tools.processingFailed', 'Processing failed')));
            }
            const body = await response.json();
            if (body.status !== 'ok') return body;
            const file = await fetch(body.file_url);
            if (!file.ok) throw new Error(this._t('tools.processingFailed', 'Processing failed'));
            return { ...body, blob: await file.blob() };
        },

        async _makeEach(items, settings) {
            const obfuscator = this._obfuscator;
            const progress = byId('obfuscate-progress');
            this._clearPackResult();
            let done = 0;
            let waiting = 0;
            for (const [position, item] of items.entries()) {
                item.status = 'processing';
                item.mode = 'encode';
                obfuscator._renderQueue();
                try {
                    const result = await this._make(settings, [item]);
                    this._applyResult(item, result);
                    if (result.status === 'ok') done += 1;
                    else waiting += 1;
                } catch (error) {
                    item.status = 'error';
                    item.disguiseError = String(error.message || error);
                }
                obfuscator._renderQueue();
                if (progress) progress.textContent = `${position + 1}/${items.length}`;
            }
            const message = waiting
                ? this._t('disguise.summaryWithWaiting', 'Made {done}; {waiting} need a cover', { done, waiting })
                : this._t('disguise.summary', 'Made {done} disguise image(s)', { done });
            this._toast(message, waiting ? 'warning' : (done ? 'success' : 'error'));
        },

        _applyResult(item, result) {
            if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
            item.resultUrl = '';
            item.resultBlob = null;
            item.resultThumbUrl = '';
            item.disguise = null;
            item.disguiseReason = '';
            item.disguiseError = '';
            // An earlier Simple-mode run would make downloads re-encode this APNG as JPEG.
            item.compatMode = null;
            if (result.status !== 'ok') {
                item.status = 'needs_cover';
                item.disguiseReason = result.reason || '';
                return;
            }
            item.status = 'done';
            item.resultBlob = result.blob;
            item.resultUrl = URL.createObjectURL(result.blob);
            item.resultThumbUrl = result.cover_preview;
            item.resultName = result.file_name;
            item.disguise = {
                token: result.token,
                fileName: result.file_name,
                width: result.width,
                height: result.height,
                bytes: result.bytes,
                frames: result.real_frames,
            };
        },

        async _makePack(settings) {
            const obfuscator = this._obfuscator;
            const items = obfuscator._queue;
            items.forEach((item) => { item.status = 'processing'; });
            obfuscator._renderQueue();
            this._clearPackResult();
            try {
                const result = await this._make(settings, items);
                if (result.status !== 'ok') {
                    items.forEach((item) => { item.status = 'pending'; });
                    this._toast(this._t('disguise.packNeedsCover', 'The pack needs a cover: {reason}', { reason: this.reasonLabel(result.reason) }), 'warning');
                    return;
                }
                this._packResult = { ...result, url: URL.createObjectURL(result.blob) };
                items.forEach((item) => { item.status = 'packed'; });
                this._toast(settings.packFormat === 'gif'
                    ? this._t('disguise.packGifSummary', 'Made one looping GIF from {count} pictures', { count: items.length })
                    : this._t('disguise.packSummary', 'Packed {count} pictures into one disguise', { count: items.length }), 'success');
            } catch (error) {
                items.forEach((item) => { item.status = 'error'; });
                this._toast(String(error.message || error), 'error');
            }
        },

        async _restoreAll() {
            const obfuscator = this._obfuscator;
            let restored = 0;
            for (const item of obfuscator._queue) {
                item.status = 'processing';
                item.mode = 'decode';
                obfuscator._renderQueue();
                try {
                    await obfuscator._ensureSourceFile(item);
                    const form = new FormData();
                    form.append('file', item.file, item.name);
                    const response = await fetch('/api/disguise/restore', { method: 'POST', body: form });
                    if (!response.ok) throw new Error(await this._errorText(response, this._t('disguise.notADisguise', 'Not a disguise image')));
                    const blob = await response.blob();
                    if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
                    item.disguise = null;
                    item.compatMode = null;
                    item.resultThumbUrl = '';
                    item.resultBlob = blob;
                    item.resultUrl = URL.createObjectURL(blob);
                    item.resultName = `${obfuscator._getBaseName(item)}_real.png`;
                    item.status = 'done';
                    restored += 1;
                } catch (error) {
                    item.status = 'error';
                    item.disguiseError = String(error.message || error);
                }
                obfuscator._renderQueue();
            }
            this._toast(
                this._t('disguise.restoreSummary', 'Restored {done}/{total}', { done: restored, total: obfuscator._queue.length }),
                restored ? 'success' : 'warning'
            );
        },

        async redoWithDefaultCover(scope) {
            const obfuscator = this._obfuscator;
            if (!obfuscator || obfuscator._processing) return;
            // It may have been set or removed since this page last looked (another tab).
            await this._refreshDefaultCover();
            if (!this._hasDefaultCover) {
                // Pick one now, then carry on with the same request.
                this._afterDefaultCover = () => this.redoWithDefaultCover(scope);
                byId('disguise-default-file')?.click();
                return;
            }
            const settings = { ...this._settings(), coverKind: 'default' };
            const items = scope === 'failed'
                ? obfuscator._queue.filter((item) => item.status === 'needs_cover')
                : obfuscator._queue;
            if (!items.length) return;
            await this._guard(() => (scope === 'all' && settings.pack ? this._makePack(settings) : this._makeEach(items, settings)));
        },

        // ── results ─────────────────────────────────────────────────

        async copyItem(item) {
            if (item?.disguise?.token) await this._copyTokens([item.disguise.token]);
        },

        async copyAll() {
            const tokens = (this._obfuscator?._queue || []).map((item) => item.disguise?.token).filter(Boolean);
            if (this._packResult) tokens.unshift(this._packResult.token);
            if (tokens.length) await this._copyTokens(tokens);
        },

        async _copyTokens(tokens) {
            const response = await fetch('/api/disguise/copy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tokens }),
            });
            if (response.ok) {
                this._toast(this._t('disguise.copied', 'Copied as file(s) - paste into the chat window', { count: tokens.length }), 'success');
                return;
            }
            const key = response.status === 501 ? 'disguise.copyUnsupported' : 'disguise.copyFailed';
            const fallback = response.status === 501
                ? 'This computer cannot copy files here. Use "Show in folder" and drag the file into the chat.'
                : 'Could not copy. Close other programs using the clipboard and try again.';
            this._toast(this._t(key, fallback), 'warning');
        },

        async reveal(token) {
            const response = await fetch('/api/disguise/reveal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
            });
            if (!response.ok) this._toast(await this._errorText(response, this._t('disguise.revealFailed', 'Could not open the folder')), 'error');
        },

        _downloadPack() {
            if (!this._packResult) return;
            this._obfuscator._triggerDownload(this._packResult.url, this._packResult.file_name);
        },

        _clearPackResult() {
            if (this._packResult?.url) URL.revokeObjectURL(this._packResult.url);
            this._packResult = null;
        },

        reset() {
            this._clearPackResult();
            this.afterRender();
        },

        reasonLabel(reason) {
            const labels = {
                nothing_detected: ['disguise.reasonNothingDetected', 'nothing to mosaic was found'],
                detector_unavailable: ['disguise.reasonDetectorUnavailable', 'the censor detector is not ready'],
                not_in_library: ['disguise.reasonNotInLibrary', 'auto mosaic works on library images only'],
                no_default_cover: ['disguise.reasonNoDefaultCover', 'no default cover is set'],
                no_upload: ['disguise.reasonNoUpload', 'no cover picture was chosen'],
            };
            const [key, fallback] = labels[reason] || ['disguise.reasonUnknown', reason || 'unknown'];
            return this._t(key, fallback);
        },

        /** Status line for a queue item in this mode, or '' to keep the default one. */
        statusText(item) {
            if (!this.isActive()) return '';
            if (item.status === 'needs_cover') {
                return this._t('disguise.statusNeedsCover', 'Needs a cover: {reason}', { reason: this.reasonLabel(item.disguiseReason) });
            }
            if (item.status === 'packed') return this._t('disguise.statusPacked', 'In the packed disguise');
            if (item.status === 'error' && item.disguiseError) return item.disguiseError;
            if (item.status === 'done' && item.disguise) {
                const info = item.disguise;
                return this._t('disguise.statusDone', 'Disguised · {width}×{height} · {size}', {
                    width: info.width,
                    height: info.height,
                    size: this._formatBytes(info.bytes),
                });
            }
            return '';
        },

        afterRender() {
            const queue = this._obfuscator?._queue || [];
            const active = this.isActive();
            const waiting = queue.filter((item) => item.status === 'needs_cover');
            const bar = byId('disguise-needs-cover-bar');
            if (bar) {
                bar.hidden = !active || !waiting.length;
                const text = byId('disguise-needs-cover-text');
                if (text && waiting.length) {
                    const reasons = [...new Set(waiting.map((item) => this.reasonLabel(item.disguiseReason)))].join('; ');
                    text.textContent = this._t('disguise.needsCoverBar', '{count} picture(s) need a cover ({reasons})', { count: waiting.length, reasons });
                }
            }
            const card = byId('disguise-pack-result');
            if (card) {
                card.hidden = !active || !this._packResult;
                if (this._packResult) {
                    const thumb = byId('disguise-pack-thumb');
                    if (thumb) thumb.src = this._packResult.cover_preview;
                    const info = byId('disguise-pack-info');
                    if (info) {
                        info.textContent = this._t('disguise.packInfo', '{name} · {frames} pictures · {width}×{height} · {size}', {
                            name: this._packResult.file_name,
                            frames: this._packResult.real_frames,
                            width: this._packResult.width,
                            height: this._packResult.height,
                            size: this._formatBytes(this._packResult.bytes),
                        });
                    }
                }
            }
            const copyAll = byId('disguise-btn-copy-all');
            if (copyAll) copyAll.hidden = !active || !(queue.some((item) => item.disguise) || this._packResult);
        },

        _formatBytes(bytes) {
            const value = Number(bytes) || 0;
            if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
            return `${Math.max(1, Math.round(value / 1024))} KB`;
        },

        async _errorText(response, fallback) {
            const body = await response.json().catch(() => ({}));
            return body.error || body.detail || fallback;
        },

        _toast(message, kind) {
            window.App?.showToast?.(message, kind);
        },
    };

    window.ImageDisguise = ImageDisguise;
})();
