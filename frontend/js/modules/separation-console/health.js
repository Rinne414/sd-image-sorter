/**
 * separation-console/health.js — separation-console.js decomposition
 * (verbatim Object.assign mixin). Method bodies moved BYTE-IDENTICAL from
 * frontend/js/modules/separation-console.js pre-cut lines 1037-1137 (of
 * 1,155): the BE-5' pre-training health check — runHealthCheck,
 * _renderHealth and _healthFixButton (the trigger-coverage one-click
 * fix). Strict per-file (the original IIFE was strict). Joins the ONE
 * unsealed object declared in separation-console/core.js, which loads
 * FIRST; separation-console/boot.js publishes window.SeparationConsole
 * LAST. Family renames applied (sepconT/sepconFold/SEPCON_* — see
 * core.js).
 */
'use strict';
Object.assign(SeparationConsole, {
        // ---- BE-5' health check ----------------------------------------------
        _healthEffectiveCaptions(ids) {
            const dm = this.dm;
            if (!dm) throw new TypeError('Dataset Maker is unavailable.');
            if (typeof dm._captionTypeFor !== 'function'
                || typeof dm._booruTextFor !== 'function'
                || typeof dm._nlTextFor !== 'function') {
                throw new TypeError('Dataset caption resolvers are unavailable.');
            }
            if (!window.CaptionCore || typeof window.CaptionCore.compose !== 'function') {
                throw new TypeError('Dataset health check requires CaptionCore.compose.');
            }
            return ids.map((imageId) => {
                const captionType = dm._captionTypeFor(imageId);
                const caption = window.CaptionCore.compose(
                    dm._booruTextFor(imageId),
                    dm._nlTextFor(imageId),
                    captionType,
                );
                return { image_id: imageId, caption: String(caption || '') };
            });
        },

        async runHealthCheck() {
            const out = document.getElementById('sepcon-health-results');
            const btn = document.getElementById('sepcon-health-run');
            if (!out) return;
            const ids = this._queueIds().filter(id => id > 0);
            const skipped = this._queueIds().length - ids.length;
            if (ids.length === 0) {
                out.hidden = false;
                out.textContent = sepconT('No gallery images in the queue (local imports are not in the DB yet).',
                    '队列中没有图库图片（本地导入的图片尚未入库）。');
                return;
            }
            if (btn) btn.disabled = true;
            out.hidden = false;
            out.textContent = sepconT('Running health check…', '正在健检…');
            try {
                const response = await fetch('/api/tags/consistency/report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image_ids: ids,
                        effective_captions: this._healthEffectiveCaptions(ids),
                        trigger: document.getElementById('dataset-trigger')?.value?.trim() || '',
                        training_purpose: document.getElementById('sepcon-purpose')?.value || 'character',
                    }),
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                this._lastHealthReport = await response.json();
                this._renderHealth(out, this._lastHealthReport, skipped);
            } catch (e) {
                out.textContent = sepconT('Health check failed: ', '健检失败：') + String(e.message || e);
            } finally {
                if (btn) btn.disabled = false;
            }
        },

        _renderHealth(out, report, skippedLocal) {
            out.textContent = '';
            const zh = sepconT('en', 'zh') === 'zh';
            const summary = document.createElement('div');
            summary.className = 'sepcon-health-summary';
            const findingCount = (report.findings || []).length;
            summary.textContent = findingCount === 0
                ? sepconT(`✅ ${report.images} images checked — no issues found.`,
                    `✅ 已检查 ${report.images} 张图 — 未发现问题。`)
                : sepconT(`${report.images} images checked — ${findingCount} finding(s):`,
                    `已检查 ${report.images} 张图 — ${findingCount} 项发现：`);
            out.appendChild(summary);
            if (skippedLocal > 0) {
                const note = document.createElement('div');
                note.className = 'sepcon-health-note';
                note.textContent = sepconT(`(${skippedLocal} local-import images skipped — not in the DB)`,
                    `（跳过 ${skippedLocal} 张本地导入图片 — 尚未入库）`);
                out.appendChild(note);
            }
            for (const finding of report.findings || []) {
                const card = document.createElement('div');
                card.className = `sepcon-finding sepcon-finding-${finding.severity}`;
                const title = document.createElement('div');
                title.className = 'sepcon-finding-title';
                title.textContent = `[${finding.severity}] ` + (zh ? finding.title_zh : finding.title_en);
                card.appendChild(title);
                const detail = document.createElement('div');
                detail.className = 'sepcon-finding-detail';
                detail.textContent = zh ? finding.detail_zh : finding.detail_en;
                card.appendChild(detail);
                if (finding.id === 'trigger-coverage'
                    && finding.fix?.action === 'add_trigger_to_captions'
                    && finding.fix?.image_ids?.length) {
                    card.appendChild(this._healthFixButton(finding));
                }
                out.appendChild(card);
            }
        },

        _healthFixButton(finding) {
            const imageIds = finding.fix.image_ids;
            const trigger = finding.fix.trigger;
            if (!Array.isArray(imageIds)
                || imageIds.some((imageId) => !Number.isSafeInteger(imageId) || imageId <= 0)) {
                throw new TypeError('Trigger coverage fix image_ids must be positive safe integers.');
            }
            if (typeof trigger !== 'string' || !trigger.trim()) {
                throw new TypeError('Trigger coverage fix trigger must be a non-empty string.');
            }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-secondary btn-small';
            btn.textContent = sepconT(`Add trigger to ${imageIds.length} images`,
                `一键给 ${imageIds.length} 张图补触发词`);
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    const dm = this.dm;
                    if (!dm || typeof dm._addTriggerToCaptions !== 'function') {
                        throw new TypeError('Dataset trigger caption writer is unavailable.');
                    }
                    dm._addTriggerToCaptions(imageIds, trigger.trim());
                    window.App?.showToast?.(sepconT('Trigger added to project captions',
                        '已把触发词加入项目 caption'), 'success');
                    await this.runHealthCheck();
                } catch (e) {
                    window.App?.showToast?.(sepconT('Failed: ', '失败：') + String(e.message || e), 'error');
                    btn.disabled = false;
                }
            });
            return btn;
        },

});
