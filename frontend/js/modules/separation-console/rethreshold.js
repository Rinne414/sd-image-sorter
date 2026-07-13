/**
 * separation-console/rethreshold.js — separation-console.js decomposition
 * (verbatim Object.assign mixin). Method bodies moved BYTE-IDENTICAL from
 * frontend/js/modules/separation-console.js pre-cut lines 813-964 (of
 * 1,155): the BE-1-UI virtual re-threshold card — the _rtSeq/_rtTimer/
 * _rtModelsLoaded/_rtLastDryRun state fields plus _initRethreshold,
 * _rtEnsureModels, _rtScheduleDryRun (debounced dry-run), _rtDryRun and
 * _rtApply. Strict per-file (the original IIFE was strict). Joins the
 * ONE unsealed object declared in separation-console/core.js, which
 * loads FIRST; separation-console/boot.js publishes
 * window.SeparationConsole LAST. Family renames applied
 * (sepconT/sepconFold/SEPCON_* — see core.js).
 */
'use strict';
Object.assign(SeparationConsole, {
        // ---- BE-1-UI virtual re-threshold (zero inference) -------------------
        // Reads stored tag_scores back at a new cutoff instead of re-running
        // ONNX over the queue. Model list comes from the scores table; the
        // debounced dry-run previews the diff before anything is written.
        _rtSeq: 0,
        _rtTimer: null,
        _rtModelsLoaded: false,
        _rtLastDryRun: null,

        _initRethreshold(details) {
            const slider = document.getElementById('sepcon-rt-threshold');
            const valueEl = document.getElementById('sepcon-rt-threshold-value');
            const model = document.getElementById('sepcon-rt-model');
            const apply = document.getElementById('sepcon-rt-apply');
            if (!slider || !model || !apply) return;
            details?.addEventListener('toggle', () => {
                if (details.open) this._rtEnsureModels();
            });
            slider.addEventListener('input', () => {
                if (valueEl) valueEl.textContent = Number(slider.value).toFixed(2);
                this._rtScheduleDryRun();
            });
            model.addEventListener('change', () => this._rtScheduleDryRun(0));
            apply.addEventListener('click', () => this._rtApply());
        },

        async _rtEnsureModels() {
            if (this._rtModelsLoaded) return;
            const model = document.getElementById('sepcon-rt-model');
            const status = document.getElementById('sepcon-rt-status');
            if (!model) return;
            try {
                const response = await fetch('/api/tags/scores/stats');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const stats = await response.json();
                this._rtModelsLoaded = true;
                model.textContent = '';
                const models = (stats.models || []).map(entry => entry.model);
                for (const name of models) {
                    const option = document.createElement('option');
                    option.value = name;
                    option.textContent = name;
                    model.appendChild(option);
                }
                if (models.length >= 2) {
                    const option = document.createElement('option');
                    option.value = 'consensus';
                    option.textContent = sepconT('consensus (all models)', 'consensus（全模型投票）');
                    model.appendChild(option);
                }
                if (models.length === 0) {
                    model.disabled = true;
                    if (status) {
                        status.textContent = sepconT(
                            'No stored scores yet — images tagged from v3.5.x onward collect them automatically.',
                            '还没有分数记录 — 从 v3.5.x 起打标会自动收集，旧图重新打标即可。');
                    }
                } else {
                    this._rtScheduleDryRun(0);
                }
            } catch (e) {
                if (status) status.textContent = sepconT('Could not load score stats: ', '无法加载分数统计：') + String(e.message || e);
            }
        },

        _rtScheduleDryRun(delay = 400) {
            if (this._rtTimer) clearTimeout(this._rtTimer);
            this._rtTimer = setTimeout(() => {
                this._rtTimer = null;
                this._rtDryRun();
            }, delay);
        },

        async _rtDryRun() {
            const status = document.getElementById('sepcon-rt-status');
            const apply = document.getElementById('sepcon-rt-apply');
            const model = document.getElementById('sepcon-rt-model')?.value;
            const threshold = Number(document.getElementById('sepcon-rt-threshold')?.value || 0.35);
            const ids = this._queueIds().filter(id => id > 0);
            this._rtLastDryRun = null;
            if (apply) apply.disabled = true;
            if (!model || ids.length === 0) {
                if (status && ids.length === 0) {
                    status.textContent = sepconT('No gallery images in the queue.', '队列中没有图库图片。');
                }
                return;
            }
            const seq = ++this._rtSeq;
            if (status) status.textContent = sepconT('Previewing…', '预览中…');
            try {
                const response = await fetch('/api/tags/rethreshold', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image_ids: ids, model, threshold, dry_run: true,
                    }),
                });
                if (seq !== this._rtSeq) return;
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const report = await response.json();
                this._rtLastDryRun = report;
                if (status) {
                    status.textContent = sepconT(
                        `${report.with_scores}/${report.requested} images have scores · ${report.images_changed} would change (+${report.tags_added} / −${report.tags_removed} tags)`,
                        `${report.with_scores}/${report.requested} 张有分数记录 · ${report.images_changed} 张会变（+${report.tags_added} / −${report.tags_removed} 个标签）`);
                }
                if (apply) apply.disabled = !(report.with_scores > 0);
            } catch (e) {
                if (seq !== this._rtSeq) return;
                if (status) status.textContent = sepconT('Preview failed: ', '预览失败：') + String(e.message || e);
            }
        },

        async _rtApply() {
            const status = document.getElementById('sepcon-rt-status');
            const apply = document.getElementById('sepcon-rt-apply');
            const model = document.getElementById('sepcon-rt-model')?.value;
            const threshold = Number(document.getElementById('sepcon-rt-threshold')?.value || 0.35);
            const ids = this._queueIds().filter(id => id > 0);
            if (!model || ids.length === 0) return;
            if (apply) apply.disabled = true;
            if (status) status.textContent = sepconT('Applying…', '套用中…');
            try {
                const response = await fetch('/api/tags/rethreshold', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image_ids: ids, model, threshold, dry_run: false,
                    }),
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const report = await response.json();
                window.App?.showToast?.(
                    sepconT(`Re-threshold applied: ${report.images_changed} images updated (+${report.tags_added} / −${report.tags_removed})`,
                      `重定门槛已套用：更新 ${report.images_changed} 张（+${report.tags_added} / −${report.tags_removed}）`),
                    'success');
                if (status) {
                    status.textContent = sepconT(
                        'Applied. Sliding again re-previews — the stored scores are unchanged, so any cutoff stays reachable.',
                        '已套用。分数记录不变，随时可再拉滑杆改回任何门槛。');
                }
                // DB tag rows changed under the queue — re-pull captions so the
                // editor and console reflect the new cutoff.
                await this.dm?._refreshAllCaptions?.();
                this.refresh();
            } catch (e) {
                if (status) status.textContent = sepconT('Apply failed: ', '套用失败：') + String(e.message || e);
            } finally {
                if (apply) apply.disabled = false;
            }
        },

});
