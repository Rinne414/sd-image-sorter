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
                const booru = dm._booruTextFor(imageId);
                const nl = dm._nlTextFor(imageId);
                const caption = window.CaptionCore.compose(booru, nl, captionType);
                // The tag list as it exports: none when only the sentence exports
                // (compose falls back to the tags when the sentence is empty).
                const sentenceOnly = captionType === 'nl' && String(nl || '').trim() !== '';
                return {
                    image_id: imageId,
                    caption: String(caption || ''),
                    tags: sentenceOnly ? '' : String(booru || ''),
                };
            });
        },

        async runHealthCheck() {
            const out = document.getElementById('sepcon-health-results');
            const btn = document.getElementById('sepcon-health-run');
            if (!out) return;
            // Mirrors MAX_REPORT_IMAGES in dataset_consistency_service.py. A
            // larger queue is checked up to this many and the result says so.
            // Pictures imported from a folder go with their own negative ids:
            // the check reads their captions, like every other picture's.
            const maxCheckedImages = 20000;
            const queueIds = this._queueIds().filter(id => id !== 0);
            const ids = queueIds.slice(0, maxCheckedImages);
            if (ids.length === 0) {
                out.hidden = false;
                out.textContent = sepconT('No images in the queue.', '队列中没有图片。');
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
                this._renderHealth(out, this._lastHealthReport, queueIds.length);
            } catch (e) {
                out.textContent = sepconT('Health check failed: ', '健检失败：') + String(e.message || e);
            } finally {
                if (btn) btn.disabled = false;
            }
        },

        _renderHealth(out, report, queueTotal = 0) {
            out.textContent = '';
            const zh = sepconT('en', 'zh') === 'zh';
            const summary = document.createElement('div');
            summary.className = 'sepcon-health-summary';
            const findingCount = (report.findings || []).length;
            summary.textContent = findingCount === 0
                ? I18n.format(sepconT(
                    `✅ {images} images checked — no issues found.`,
                    `✅ 已检查 {images} 张图 — 未发现问题。`,
                ), { images: report.images })
                : I18n.format(sepconT(
                    `{images} images checked — {findingCount} findings:`,
                    `已检查 {images} 张图 — {findingCount} 项发现：`,
                ), { images: report.images, findingCount });
            out.appendChild(summary);
            const scopeTotal = Math.max(Number(report.images_in_scope || 0), Number(queueTotal || 0));
            if (report.images_truncated || scopeTotal > Number(report.images || 0)) {
                const note = document.createElement('div');
                note.className = 'sepcon-health-note';
                note.textContent = I18n.format(sepconT(
                    `Checked only the first {images} of {scopeTotal} images.`,
                    `只检查了前 {images} 张，共 {scopeTotal} 张。`,
                ), { images: report.images, scopeTotal });
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
                if (finding.id === 'subject-count-conflict'
                    && finding.fix?.action === 'resolve_subject_counts') {
                    // Preview with a tick per picture; nothing changes until Apply.
                    const preview = window.SubjectFixes?.build(finding, this.dm);
                    if (preview) card.appendChild(preview);
                }
                out.appendChild(card);
            }
        },

        _healthFixButton(finding) {
            const imageIds = finding.fix.image_ids;
            const trigger = finding.fix.trigger;
            if (!Array.isArray(imageIds)
                || imageIds.some((imageId) => !Number.isSafeInteger(imageId) || imageId === 0)) {
                throw new TypeError('Trigger coverage fix image_ids must be non-zero safe integers.');
            }
            if (typeof trigger !== 'string' || !trigger.trim()) {
                throw new TypeError('Trigger coverage fix trigger must be a non-empty string.');
            }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-secondary btn-small';
            btn.textContent = I18n.format(sepconT(
                `Add trigger to {lengthCount} images`,
                `一键给 {lengthCount} 张图补触发词`,
            ), { lengthCount: imageIds.length });
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
