/**
 * separation-console/insights.js — separation-console.js decomposition
 * (verbatim Object.assign mixin). Method bodies moved BYTE-IDENTICAL from
 * frontend/js/modules/separation-console.js pre-cut lines 380-520 +
 * 662-812 (of 1,155): the BE-1 coverage-gaps flow (_gapsPanel shared
 * panel, findGaps, _renderGaps, _applyGapFix), the tag-info popover
 * (_computeCoOccurrence, showTagInfo, _renderTagInfo) and the BE-1-UI
 * per-model tag audit (auditTag, _renderAudit). Strict per-file (the
 * original IIFE was strict). Joins the ONE unsealed object declared in
 * separation-console/core.js, which loads FIRST; separation-console/
 * boot.js publishes window.SeparationConsole LAST. Family renames
 * applied (sepconT/sepconFold/SEPCON_* — see core.js).
 */
'use strict';
Object.assign(SeparationConsole, {
        // ---- BE-1 coverage gaps (N2 find-missed) ----------------------------
        // A pruned-wrong tag is bad; a MISSED tag is worse for training (the
        // trait melts into the trigger). The backend stores every tagger
        // score >= 0.10, so "score just under the threshold + no tag row" is
        // a ranked candidate list of misses for this exact tag.
        _gapsPanel() {
            let panel = document.getElementById('sepcon-gaps');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'sepcon-gaps';
                panel.className = 'sepcon-gaps';
                const rows = document.getElementById('sepcon-rows');
                rows?.parentElement?.insertBefore(panel, rows);
            }
            return panel;
        },

        async findGaps(row) {
            const panel = this._gapsPanel();
            panel.hidden = false;
            panel.textContent = sepconT('Searching for near-miss scores…', '正在搜索卡在门槛下的分数…');
            const ids = this._queueIds().filter(id => id > 0);
            if (ids.length === 0) {
                panel.textContent = sepconT(
                    'No gallery images in the queue (local imports have no stored scores).',
                    '队列中没有图库图片（本地导入的图片没有分数记录）。');
                return;
            }
            try {
                const response = await fetch('/api/tags/coverage-gaps', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tag: row.key.replace(/ /g, '_'),
                        image_ids: ids,
                        limit: 100,
                    }),
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                this._renderGaps(panel, row, await response.json());
            } catch (e) {
                panel.textContent = sepconT('Find-missed failed: ', '找漏打失败：') + String(e.message || e);
            }
        },

        _renderGaps(panel, row, report) {
            panel.textContent = '';
            const gaps = report.gaps || [];
            const band = `${Number(report.band_low).toFixed(2)}–${Number(report.band_high).toFixed(2)}`;
            const head = document.createElement('div');
            head.className = 'sepcon-gaps-head';
            const title = document.createElement('span');
            title.className = 'sepcon-gaps-title';
            title.textContent = gaps.length === 0
                ? sepconT(`No missed images for "${row.spelling}" (scores ${band}). Images tagged before v3.5.x have no score records — re-tag to collect them.`,
                    `「${row.spelling}」没有疑似漏打的图（分数区间 ${band}）。旧版本打的标没有分数记录 — 重新打标后才可用。`)
                : sepconT(`${gaps.length} image(s) probably missed "${row.spelling}" (score ${band}):`,
                    `${gaps.length} 张图疑似漏打「${row.spelling}」（分数 ${band}）：`);
            head.appendChild(title);
            head.appendChild(this._actionBtn('✕', sepconT('Close', '关闭'),
                () => { panel.hidden = true; panel.textContent = ''; }));
            panel.appendChild(head);
            if (gaps.length === 0) return;

            const fixAll = document.createElement('button');
            fixAll.type = 'button';
            fixAll.className = 'btn btn-secondary btn-small';
            fixAll.textContent = sepconT(
                `Add "${row.spelling}" to all ${gaps.length} (manual rows, undoable)`,
                `全部补上「${row.spelling}」（写入为 manual，可撤销）`);
            fixAll.addEventListener('click', () => this._applyGapFix(row, gaps, fixAll));
            panel.appendChild(fixAll);

            for (const gap of gaps.slice(0, 30)) {
                const line = document.createElement('div');
                line.className = 'sepcon-gap-line';
                const label = document.createElement('span');
                label.textContent = `${gap.filename} · ${Number(gap.score).toFixed(2)}`;
                line.appendChild(label);
                line.appendChild(this._actionBtn('📍',
                    sepconT('Open this image in the editor', '在编辑器中打开这张图'),
                    () => this.dm?._setActive?.(Number(gap.image_id))));
                panel.appendChild(line);
            }
            if (gaps.length > 30) {
                const more = document.createElement('div');
                more.className = 'sepcon-gap-line';
                more.textContent = sepconT(
                    `…and ${gaps.length - 30} more ("add all" covers every one).`,
                    `…还有 ${gaps.length - 30} 张（“全部补上”会一并处理）。`);
                panel.appendChild(more);
            }
        },

        async _applyGapFix(row, gaps, btn) {
            btn.disabled = true;
            const spelledTag = row.key.replace(/ /g, '_');
            const ids = gaps.map(g => Number(g.image_id)).filter(id => id > 0);
            try {
                const response = await fetch('/api/tags/bulk/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_ids: ids, tags: [spelledTag] }),
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
            } catch (e) {
                window.App?.showToast?.(sepconT('Failed: ', '失败：') + String(e.message || e), 'error');
                btn.disabled = false;
                return;
            }
            // Mirror into session captions so export previews match the DB rows.
            const dm = this.dm;
            const queue = new Set(this._queueIds());
            for (const id of ids) {
                if (!dm || !queue.has(id)) continue;
                const current = this._effectiveCaption(id);
                const parts = current.split(',').map(s => s.trim()).filter(Boolean);
                if (parts.some(s => sepconFold(s) === row.key)) continue;
                parts.push(spelledTag);
                const next = parts.join(', ');
                if (Number(dm.activeId) === Number(id)) {
                    const box = document.getElementById('dataset-editor-textarea');
                    if (box) {
                        box.value = next;
                        // Route through DM's own edit pipeline (undo stack, diff).
                        box.dispatchEvent(new Event('input', { bubbles: true }));
                        continue;
                    }
                }
                dm.captionEdits.set(Number(id), next);
                dm._refreshQueueItem?.(Number(id));
            }
            // Journaled server-side (FE-2s) — undoable from the mass editor.
            window.App?.showToast?.(
                sepconT(`Added "${row.spelling}" to ${ids.length} images (undo in Mass Tag Editor)`,
                  `已给 ${ids.length} 张图补上「${row.spelling}」（可在批量标签编辑器撤销）`),
                'success');
            this.findGaps(row);
            this.refresh();
        },

        // ---- Tag info popover (roadmap #6: learn while tagging) ---------------
        _computeCoOccurrence(row, topN = 8) {
            // Concept-bleeding view (roadmap #5): among the queue images that
            // carry this tag, which OTHER tags ride along, and how often.
            // >=80% co-occurrence is the health check's "always together"
            // smell — flagged so the trainer considers pruning or merging.
            const carrierIds = new Set(row.ids);
            if (carrierIds.size === 0) return [];
            const counts = new Map();
            for (const id of carrierIds) {
                const seenHere = new Set();
                for (const raw of this._effectiveCaption(id).split(',')) {
                    const key = sepconFold(raw.trim());
                    if (!key || key === row.key || seenHere.has(key)) continue;
                    seenHere.add(key);
                    counts.set(key, (counts.get(key) || 0) + 1);
                }
            }
            return [...counts.entries()]
                .map(([tag, count]) => ({ tag, count, ratio: count / carrierIds.size }))
                .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
                .slice(0, topN);
        },

        async showTagInfo(row) {
            const panel = this._gapsPanel();
            panel.hidden = false;
            panel.textContent = sepconT('Loading tag info…', '加载标签资料…');
            try {
                const response = await fetch(
                    `/api/tags/info?tag=${encodeURIComponent(row.key.replace(/ /g, '_'))}`
                );
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                this._renderTagInfo(panel, row, await response.json());
            } catch (e) {
                panel.textContent = sepconT('Tag info failed: ', '标签资料加载失败：') + String(e.message || e);
            }
        },

        _renderTagInfo(panel, row, info) {
            panel.textContent = '';
            const head = document.createElement('div');
            head.className = 'sepcon-gaps-head';
            const title = document.createElement('span');
            title.className = 'sepcon-gaps-title';
            const zhPart = info.zh ? ` · ${info.zh}` : '';
            title.textContent = `${info.canonical || row.spelling}${zhPart} — ${info.category || '?'}`;
            head.appendChild(title);
            head.appendChild(this._actionBtn('✕', sepconT('Close', '关闭'),
                () => { panel.hidden = true; panel.textContent = ''; }));
            panel.appendChild(head);

            const lines = [];
            if (info.canonical && info.canonical !== row.key) {
                lines.push(sepconT(`Alias of "${info.canonical}"`, `是「${info.canonical}」的别名`));
            }
            lines.push(sepconT(
                `Library: ${info.library_count} images · danbooru popularity: ${info.found_in_vocab ? info.danbooru_count.toLocaleString() : sepconT('not in vocab', '词表外')}`,
                `库内 ${info.library_count} 张 · danbooru 热度：${info.found_in_vocab ? info.danbooru_count.toLocaleString() : '词表外'}`));
            if ((info.aliases || []).length) {
                lines.push(sepconT('Aliases: ', '别名：') + info.aliases.slice(0, 8).join(', '));
            }
            if ((info.implies || []).length) {
                lines.push(sepconT('Implies (redundant parents): ', '蕴含（冗余上位标签）：') + info.implies.join(', '));
            }
            if ((info.implied_by || []).length) {
                lines.push(sepconT('Implied by: ', '被这些标签蕴含：') + info.implied_by.slice(0, 8).join(', '));
            }
            for (const textLine of lines) {
                const line = document.createElement('div');
                line.className = 'sepcon-gap-line';
                line.textContent = textLine;
                panel.appendChild(line);
            }

            const coTags = this._computeCoOccurrence(row);
            if (coTags.length) {
                const header = document.createElement('div');
                header.className = 'sepcon-gap-line sepcon-cooccur-header';
                header.textContent = sepconT(
                    `Co-occurs within the queue (${row.ids.length} images carry "${row.spelling}"):`,
                    `队列内共现（${row.ids.length} 张图带有「${row.spelling}」）：`);
                panel.appendChild(header);
                for (const entry of coTags) {
                    const line = document.createElement('div');
                    line.className = 'sepcon-gap-line sepcon-cooccur-line';
                    const percent = Math.round(entry.ratio * 100);
                    const label = document.createElement('span');
                    label.textContent = `${entry.tag} — ${entry.count}/${row.ids.length} (${percent}%)`;
                    if (entry.ratio >= 0.8) {
                        label.classList.add('sepcon-cooccur-high');
                        label.title = sepconT(
                            'Nearly always together — the trainer cannot separate these two; consider pruning or merging.',
                            '几乎永远同现 — 训练器无法分离这两个概念；考虑修剪或合并。');
                    }
                    line.appendChild(label);
                    panel.appendChild(line);
                }
            }
        },

        // ---- BE-1-UI per-model tag audit --------------------------------------
        async auditTag(row) {
            const panel = this._gapsPanel();
            panel.hidden = false;
            panel.textContent = sepconT('Loading model audit…', '加载模型视角…');
            const ids = this._queueIds().filter(id => id > 0);
            try {
                const response = await fetch('/api/tags/scores/tag-audit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tag: row.key.replace(/ /g, '_'),
                        image_ids: ids.length ? ids : undefined,
                    }),
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                this._renderAudit(panel, row, await response.json());
            } catch (e) {
                panel.textContent = sepconT('Model audit failed: ', '模型视角加载失败：') + String(e.message || e);
            }
        },

        _renderAudit(panel, row, report) {
            panel.textContent = '';
            const head = document.createElement('div');
            head.className = 'sepcon-gaps-head';
            const title = document.createElement('span');
            title.className = 'sepcon-gaps-title';
            const models = report.models || [];
            title.textContent = models.length === 0
                ? sepconT(`No stored scores for "${row.spelling}" — images tagged before v3.5.x have no records.`,
                    `「${row.spelling}」没有分数记录 — 旧版本打的标没有记录，重新打标后可用。`)
                : sepconT(`Who scored "${row.spelling}" (${report.scope_images} images in scope):`,
                    `「${row.spelling}」的模型视角（范围 ${report.scope_images} 张）：`);
            head.appendChild(title);
            head.appendChild(this._actionBtn('✕', sepconT('Close', '关闭'),
                () => { panel.hidden = true; panel.textContent = ''; }));
            panel.appendChild(head);
            for (const entry of models) {
                const line = document.createElement('div');
                line.className = 'sepcon-gap-line';
                const label = document.createElement('span');
                label.textContent = sepconT(
                    `${entry.model} · ${entry.images} img · avg ${entry.avg_score} · max ${entry.max_score}`,
                    `${entry.model} · ${entry.images} 张 · 均值 ${entry.avg_score} · 最高 ${entry.max_score}`);
                line.appendChild(label);
                panel.appendChild(line);
            }
        },

});
