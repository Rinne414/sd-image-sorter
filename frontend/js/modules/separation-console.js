/**
 * Separation Console (SEP-1) — the per-TAG decision surface for LoRA
 * dataset prep.
 *
 * Captioning for LoRA training is variable separation, not description:
 * a tag kept in the caption stays promptable; a tag pruned (blacklisted)
 * is absorbed into the trigger word. That keep/prune decision is made per
 * TAG across the whole set, with frequency as the evidence — so this panel
 * lists every tag in the Dataset Maker queue with its frequency, category
 * color and an "intrinsic trait candidate" marker, and lets the user act
 * on the tag everywhere at once:
 *   ✂  prune  -> toggles the tag in #dataset-blacklist (export-time absorb)
 *   🗑  remove -> deletes the tag from every session caption (captionEdits)
 *   📍 locate -> cycles the editor through images carrying the tag
 *
 * It also hosts the pre-training health check (BE-5' consistency report)
 * and a client-side NL-leak scan (SEP-2): blacklisted traits that still
 * appear in natural-language captions are flagged before export.
 *
 * Reads Dataset Maker state through a thin adapter (captions/captionEdits
 * Maps) so it works today and can later re-point at the shared caption
 * editor store without UI changes.
 */
(function () {
    'use strict';

    const SEEN_KEY = 'sd-image-sorter-dataset-seen';
    const PURPOSE_KEY = 'sd-image-sorter-separation-purpose';
    const INTRINSIC_MIN_RATIO = 0.5;

    // Trait families that are usually intrinsic to a character (mirrors the
    // backend trait-pruning families; heuristic, marking only — never acts).
    const INTRINSIC_RE = /(_|\s|^)(hair|eyes?|skin)(\s|$)|ahoge|twintails?|twin_braids|ponytail|braid|bangs|sidelocks|heterochromia|horns?|tail|wings?|halo|animal_ears|cat_ears|fox_ears|fang|mole|scar|freckles|dark-skinned|tan(line)?s?$/;

    function t(en, zh) {
        try {
            const lang = window.I18n?.getLang?.() || document.documentElement.lang || '';
            return String(lang).toLowerCase().startsWith('zh') ? zh : en;
        } catch (_) { return en; }
    }

    function fold(tag) {
        return String(tag || '').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
    }

    const SeparationConsole = {
        _hooked: false,
        _seen: null,
        _refreshTimer: null,
        _lastHealthReport: null,

        get dm() { return window.DatasetMaker || null; },

        // ---- lifecycle -------------------------------------------------
        init() {
            const details = document.getElementById('dataset-separation-console');
            if (!details) return;
            details.addEventListener('toggle', () => {
                if (details.open) { this._ensureHooks(); this.refresh(); }
            });
            window.addEventListener('dataset:changed', () => {
                this._ensureHooks();
                this._scheduleRefresh();
            });
            document.getElementById('sepcon-search')?.addEventListener('input', () => this._scheduleRefresh(120));
            document.getElementById('sepcon-sort')?.addEventListener('change', () => this.refresh());
            document.getElementById('sepcon-next-unseen')?.addEventListener('click', () => this.jumpToUnseen());
            document.getElementById('sepcon-health-run')?.addEventListener('click', () => this.runHealthCheck());
            const purpose = document.getElementById('sepcon-purpose');
            if (purpose) {
                try { purpose.value = localStorage.getItem(PURPOSE_KEY) || 'character'; } catch (_) {}
                purpose.addEventListener('change', () => {
                    try { localStorage.setItem(PURPOSE_KEY, purpose.value); } catch (_) {}
                });
            }
            const blacklist = document.getElementById('dataset-blacklist');
            blacklist?.addEventListener('input', () => this._scheduleRefresh(300));
            // QW-1: live token budget under the booru caption box.
            document.getElementById('dataset-editor-textarea')?.addEventListener(
                'input', () => this._updateTokenCounter());
        },

        // ---- QW-1: caption token budget -----------------------------------
        // CLIP reads only the first 75 tokens of a caption; SD1.5/SDXL text
        // encoders silently drop the rest. Exact BPE needs the full vocab
        // table, so this is an honest ESTIMATE (≈4 chars/token English
        // average, separators counted) — labeled as such.
        estimateTokens(text) {
            const folded = String(text || '').replace(/_/g, ' ').trim();
            if (!folded) return 0;
            let tokens = 0;
            for (const word of folded.split(/[\s,]+/)) {
                if (!word) continue;
                tokens += Math.max(1, Math.ceil(word.length / 4));
            }
            tokens += (folded.match(/,/g) || []).length;
            return tokens;
        },

        _updateTokenCounter() {
            const box = document.getElementById('dataset-editor-textarea');
            if (!box || box.hidden) return;
            let counter = document.getElementById('dataset-token-counter');
            if (!counter) {
                counter = document.createElement('div');
                counter.id = 'dataset-token-counter';
                counter.className = 'dataset-token-counter';
                box.insertAdjacentElement('afterend', counter);
            }
            const text = box.value || '';
            const tagCount = text.split(',').map(s => s.trim()).filter(Boolean).length;
            const tokens = this.estimateTokens(text);
            counter.textContent = t(
                `${tagCount} tags · ≈${tokens} tokens`,
                `${tagCount} 个标签 · ≈${tokens} tokens`);
            counter.classList.toggle('dataset-token-counter-over', tokens > 75);
            counter.title = tokens > 75
                ? t('Over the 75-token CLIP budget — SD1.5/SDXL encoders truncate the rest. (Estimate; FLUX/T5 budgets are larger.)',
                    '超过 CLIP 75-token 预算 — SD1.5/SDXL 编码器会截断多余部分。（估算值；FLUX/T5 预算更大。）')
                : t('Estimated CLIP tokens (75-token budget for SD1.5/SDXL).',
                    '估算的 CLIP token 数（SD1.5/SDXL 预算为 75）。');
        },

        _ensureHooks() {
            const dm = this.dm;
            if (this._hooked || !dm || typeof dm._setActive !== 'function') return;
            this._hooked = true;
            // QW-2: seen tracking — one more wrap on the established chain.
            const original = dm._setActive.bind(dm);
            dm._setActive = (id) => {
                const result = original(id);
                this._markSeen(id);
                this._updateTokenCounter();
                return result;
            };
            // Recompute while the panel is open and captions are being edited.
            if (dm.captionEdits && !dm.captionEdits.__sepconWrapped) {
                dm.captionEdits.__sepconWrapped = true;
                const originalSet = dm.captionEdits.set.bind(dm.captionEdits);
                dm.captionEdits.set = (key, value) => {
                    const out = originalSet(key, value);
                    this._scheduleRefresh(400);
                    return out;
                };
            }
        },

        // ---- adapter over Dataset Maker state ---------------------------
        _queueIds() {
            return (this.dm?.imageIds || []).map(Number).filter(Number.isFinite);
        },

        _effectiveCaption(id) {
            const dm = this.dm;
            if (!dm) return '';
            if (dm.captionEdits?.has?.(id)) return String(dm.captionEdits.get(id) || '');
            return String(dm.captions?.get?.(id) || '');
        },

        _effectiveNl(id) {
            const dm = this.dm;
            if (!dm) return '';
            if (dm.nlEdits?.has?.(id)) return String(dm.nlEdits.get(id) || '');
            return String(dm.nlCaptions?.get?.(id) || '');
        },

        _blacklistEntries() {
            const box = document.getElementById('dataset-blacklist');
            if (!box) return [];
            return String(box.value || '')
                .split(/\r?\n|,/)
                .map(s => s.trim())
                .filter(Boolean);
        },

        _writeBlacklist(entries) {
            const box = document.getElementById('dataset-blacklist');
            if (!box) return;
            box.value = entries.join('\n');
            box.dispatchEvent(new Event('input', { bubbles: true }));
        },

        // ---- stats -------------------------------------------------------
        computeStats() {
            const ids = this._queueIds();
            const counts = new Map(); // folded -> {count, spellings:Set, ids:[]}
            for (const id of ids) {
                const seenHere = new Set();
                for (const raw of this._effectiveCaption(id).split(',')) {
                    const spelled = raw.trim();
                    const key = fold(spelled);
                    if (!key || seenHere.has(key)) continue;
                    seenHere.add(key);
                    let entry = counts.get(key);
                    if (!entry) { entry = { count: 0, spellings: new Set(), ids: [] }; counts.set(key, entry); }
                    entry.count += 1;
                    entry.spellings.add(spelled);
                    entry.ids.push(id);
                }
            }
            return { total: ids.length, counts };
        },

        // ---- render -------------------------------------------------------
        refresh() {
            const body = document.getElementById('sepcon-rows');
            if (!body) return;
            const dm = this.dm;
            const { total, counts } = this.computeStats();
            const statsEl = document.getElementById('sepcon-stats');
            const seen = this._loadSeen();
            const seenCount = this._queueIds().filter(id => seen[id]).length;
            if (statsEl) {
                statsEl.textContent = t(
                    `${total} images · ${counts.size} tags · reviewed ${seenCount}/${total}`,
                    `${total} 张图 · ${counts.size} 个标签 · 已过目 ${seenCount}/${total}`);
            }
            this._renderLeaks();

            const query = fold(document.getElementById('sepcon-search')?.value || '');
            const sort = document.getElementById('sepcon-sort')?.value || 'freq';
            const blacklistFolded = new Set(this._blacklistEntries().map(fold));

            let rows = [...counts.entries()].map(([key, entry]) => {
                const spelling = [...entry.spellings][0];
                const category = dm?._classifyTagCategory?.(spelling) || 'unknown';
                const ratio = total > 0 ? entry.count / total : 0;
                return {
                    key,
                    spelling,
                    count: entry.count,
                    ids: entry.ids,
                    category,
                    pruned: blacklistFolded.has(key),
                    intrinsic: ratio >= INTRINSIC_MIN_RATIO && INTRINSIC_RE.test(key.replace(/ /g, '_')),
                };
            });
            if (query) rows = rows.filter(r => r.key.includes(query));
            if (sort === 'alpha') rows.sort((a, b) => a.key.localeCompare(b.key));
            else if (sort === 'category') rows.sort((a, b) => a.category.localeCompare(b.category) || b.count - a.count);
            else rows.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

            body.textContent = '';
            const frag = document.createDocumentFragment();
            for (const row of rows.slice(0, 800)) {
                frag.appendChild(this._buildRow(row, total));
            }
            body.appendChild(frag);
            const overflow = document.getElementById('sepcon-overflow');
            if (overflow) {
                overflow.hidden = rows.length <= 800;
                if (rows.length > 800) {
                    overflow.textContent = t(
                        `Showing 800 of ${rows.length} tags — narrow with search.`,
                        `仅显示 800/${rows.length} 个标签 — 请用搜索缩小范围。`);
                }
            }
        },

        _buildRow(row, total) {
            const div = document.createElement('div');
            div.className = 'sepcon-row' + (row.pruned ? ' sepcon-row-pruned' : '');

            const dot = document.createElement('span');
            dot.className = `cap-ac-dot cap-ac-dot-${row.category}`;
            div.appendChild(dot);

            const name = document.createElement('span');
            name.className = 'sepcon-tag';
            name.textContent = row.spelling;
            name.title = row.category;
            div.appendChild(name);

            if (row.intrinsic) {
                const badge = document.createElement('span');
                badge.className = 'sepcon-intrinsic';
                badge.textContent = t('trait', '内在');
                badge.title = t(
                    'High-frequency innate trait — consider pruning so the trigger word absorbs it.',
                    '高频内在特征 — 建议剪掉，让触发词吸收它。');
                div.appendChild(badge);
            }

            const count = document.createElement('span');
            count.className = 'sepcon-count';
            count.textContent = `${row.count}/${total}`;
            div.appendChild(count);

            const actions = document.createElement('span');
            actions.className = 'sepcon-actions';
            actions.appendChild(this._actionBtn(
                row.pruned ? '↩' : '✂',
                row.pruned
                    ? t('Un-prune (remove from blacklist)', '取消剪除（移出黑名单）')
                    : t('Prune: blacklist at export so the trigger absorbs it', '剪除：加入导出黑名单，让触发词吸收'),
                () => this.togglePrune(row.key)));
            actions.appendChild(this._actionBtn('🗑',
                t('Remove this tag from every caption (session edit, Ctrl+Z-able per image)', '从所有 caption 中移除此标签（会话级编辑）'),
                () => this.removeEverywhere(row)));
            actions.appendChild(this._actionBtn('📍',
                t('Jump to the next image carrying this tag', '跳到下一张含此标签的图'),
                () => this.locateNext(row)));
            div.appendChild(actions);
            return div;
        },

        _actionBtn(label, title, onClick) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sepcon-btn';
            btn.textContent = label;
            btn.title = title;
            btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            return btn;
        },

        // ---- actions ------------------------------------------------------
        togglePrune(key) {
            const entries = this._blacklistEntries();
            const next = entries.filter(entry => fold(entry) !== key);
            if (next.length === entries.length) next.push(key.replace(/ /g, '_'));
            this._writeBlacklist(next);
            this.refresh();
        },

        removeEverywhere(row) {
            const dm = this.dm;
            if (!dm) return;
            for (const id of row.ids) {
                const current = this._effectiveCaption(id);
                const next = current
                    .split(',')
                    .map(s => s.trim())
                    .filter(s => s && fold(s) !== row.key)
                    .join(', ');
                if (next === current) continue;
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
            window.App?.showToast?.(
                t(`Removed "${row.spelling}" from ${row.ids.length} captions`,
                  `已从 ${row.ids.length} 条 caption 移除「${row.spelling}」`),
                'success');
            this.refresh();
        },

        locateNext(row) {
            const dm = this.dm;
            if (!dm || row.ids.length === 0) return;
            const activeIndex = row.ids.indexOf(Number(dm.activeId));
            const nextId = row.ids[(activeIndex + 1) % row.ids.length];
            dm._setActive?.(nextId);
        },

        // ---- QW-2 seen tracking --------------------------------------------
        _loadSeen() {
            if (this._seen) return this._seen;
            try { this._seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; }
            catch (_) { this._seen = {}; }
            return this._seen;
        },

        _markSeen(id) {
            const numeric = Number(id);
            if (!Number.isFinite(numeric)) return;
            const seen = this._loadSeen();
            if (seen[numeric]) return;
            seen[numeric] = true;
            try {
                // Prune to the current queue so the store cannot grow forever.
                const idSet = new Set(this._queueIds());
                for (const key of Object.keys(seen)) {
                    if (!idSet.has(Number(key))) delete seen[key];
                }
                localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
            } catch (_) {}
            this._scheduleRefresh(400);
        },

        jumpToUnseen() {
            const dm = this.dm;
            if (!dm) return;
            const seen = this._loadSeen();
            const next = this._queueIds().find(id => !seen[id]);
            if (next == null) {
                window.App?.showToast?.(t('All images reviewed 🎉', '全部图片都已过目 🎉'), 'success');
                return;
            }
            dm._setActive?.(next);
        },

        // ---- SEP-2 client-side NL leak scan ---------------------------------
        _renderLeaks() {
            const box = document.getElementById('sepcon-leaks');
            if (!box) return;
            const traits = this._blacklistEntries().map(fold).filter(Boolean);
            const leaks = new Map(); // trait -> count of images leaking
            if (traits.length) {
                for (const id of this._queueIds()) {
                    const nl = fold(this._effectiveNl(id));
                    if (!nl) continue;
                    for (const trait of traits) {
                        const pattern = new RegExp(
                            `(?<!\\w)${trait.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s_]+')}(?!\\w)`);
                        if (pattern.test(nl)) leaks.set(trait, (leaks.get(trait) || 0) + 1);
                    }
                }
            }
            if (leaks.size === 0) { box.hidden = true; box.textContent = ''; return; }
            box.hidden = false;
            box.textContent = '';
            const title = document.createElement('div');
            title.className = 'sepcon-leaks-title';
            title.textContent = t('⚠ Pruned traits leaking back through NL captions:',
                '⚠ 已剪除的特征从自然语言描述漏回来了：');
            box.appendChild(title);
            for (const [trait, count] of leaks) {
                const line = document.createElement('div');
                line.className = 'sepcon-leak-line';
                line.textContent = t(
                    `"${trait}" appears in ${count} NL caption(s) — edit them or re-run Smart Tag (the trait list is now sent to the VLM).`,
                    `「${trait}」出现在 ${count} 条 NL 描述中 — 请手动修改，或重跑 Smart Tag（特征清单现在会传给 VLM）。`);
                box.appendChild(line);
            }
        },

        // ---- BE-5' health check ----------------------------------------------
        async runHealthCheck() {
            const out = document.getElementById('sepcon-health-results');
            const btn = document.getElementById('sepcon-health-run');
            if (!out) return;
            const ids = this._queueIds().filter(id => id > 0);
            const skipped = this._queueIds().length - ids.length;
            if (ids.length === 0) {
                out.hidden = false;
                out.textContent = t('No gallery images in the queue (local imports are not in the DB yet).',
                    '队列中没有图库图片（本地导入的图片尚未入库）。');
                return;
            }
            if (btn) btn.disabled = true;
            out.hidden = false;
            out.textContent = t('Running health check…', '正在健检…');
            try {
                const response = await fetch('/api/tags/consistency/report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image_ids: ids,
                        trigger: document.getElementById('dataset-trigger')?.value?.trim() || '',
                        training_purpose: document.getElementById('sepcon-purpose')?.value || 'character',
                    }),
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                this._lastHealthReport = await response.json();
                this._renderHealth(out, this._lastHealthReport, skipped);
            } catch (e) {
                out.textContent = t('Health check failed: ', '健检失败：') + String(e.message || e);
            } finally {
                if (btn) btn.disabled = false;
            }
        },

        _renderHealth(out, report, skippedLocal) {
            out.textContent = '';
            const zh = t('en', 'zh') === 'zh';
            const summary = document.createElement('div');
            summary.className = 'sepcon-health-summary';
            const findingCount = (report.findings || []).length;
            summary.textContent = findingCount === 0
                ? t(`✅ ${report.images} images checked — no issues found.`,
                    `✅ 已检查 ${report.images} 张图 — 未发现问题。`)
                : t(`${report.images} images checked — ${findingCount} finding(s):`,
                    `已检查 ${report.images} 张图 — ${findingCount} 项发现：`);
            out.appendChild(summary);
            if (skippedLocal > 0) {
                const note = document.createElement('div');
                note.className = 'sepcon-health-note';
                note.textContent = t(`(${skippedLocal} local-import images skipped — not in the DB)`,
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
                if (finding.id === 'trigger-coverage' && finding.fix?.body?.image_ids?.length) {
                    card.appendChild(this._healthFixButton(finding));
                }
                out.appendChild(card);
            }
        },

        _healthFixButton(finding) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-secondary btn-small';
            btn.textContent = t(`Add trigger to ${finding.fix.body.image_ids.length} images`,
                `一键给 ${finding.fix.body.image_ids.length} 张图补触发词`);
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    const body = { ...finding.fix.body, dry_run: false };
                    const response = await fetch(finding.fix.endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    // Journaled server-side (FE-2s) — undoable from the mass editor.
                    window.App?.showToast?.(t('Trigger added (undo available in Mass Tag Editor)',
                        '已补触发词（可在批量标签编辑器撤销）'), 'success');
                    this.runHealthCheck();
                } catch (e) {
                    window.App?.showToast?.(t('Failed: ', '失败：') + String(e.message || e), 'error');
                    btn.disabled = false;
                }
            });
            return btn;
        },

        _scheduleRefresh(delay = 250) {
            const details = document.getElementById('dataset-separation-console');
            if (!details?.open) return;
            if (this._refreshTimer) clearTimeout(this._refreshTimer);
            this._refreshTimer = setTimeout(() => {
                this._refreshTimer = null;
                this.refresh();
            }, delay);
        },
    };

    window.SeparationConsole = SeparationConsole;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => SeparationConsole.init());
    } else {
        SeparationConsole.init();
    }
})();
