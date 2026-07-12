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
            this._initRethreshold(details);
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
            // Budget follows the LoRA-setup target model when one is chosen
            // (CLIP 75 / T5+Qwen-VL 512); unset targets keep the historical
            // CLIP default because it is the strictest common case.
            const budget = window.TargetModel?.tokenBudget?.() || 75;
            counter.textContent = t(
                `${tagCount} tags · ≈${tokens} tokens`,
                `${tagCount} 个标签 · ≈${tokens} tokens`);
            counter.classList.toggle('dataset-token-counter-over', tokens > budget);
            counter.title = tokens > budget
                ? t(`Over the ~${budget}-token budget for the chosen target model — the encoder truncates the rest.`,
                    `超过所选目标模型的 ~${budget}-token 预算 — 编码器会截断多余部分。`)
                : t(`Estimated tokens (budget ~${budget} for the chosen target model; CLIP default when unset).`,
                    `估算 token 数（当前目标模型预算约 ${budget}；未选择时按 CLIP 预算）。`);
        },

        _ensureHooks() {
            const dm = this.dm;
            if (this._hooked || !dm || !Array.isArray(dm._activeChangedHooks)) return;
            this._hooked = true;
            // QW-2: seen tracking — registered on the shared active-changed
            // registry (FE-1 2b) instead of re-wrapping dm._setActive. Pushed
            // at first console open, so it runs last (as the old outermost
            // runtime wrap did).
            dm._activeChangedHooks.push((id) => {
                this._markSeen(id);
                this._updateTokenCounter();
            });
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
            name.className = 'sepcon-tag sepcon-tag-clickable';
            name.textContent = row.spelling;
            name.title = t('Click for tag info: category, aliases, implications, counts',
                '点击查看标签资料：分类、别名、蕴含关系、数量');
            name.addEventListener('click', (e) => { e.stopPropagation(); this.showTagInfo(row); });
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
            actions.appendChild(this._actionBtn('🔍',
                t('Find missed images: tagger scores just under the threshold without this tag',
                  '找漏打：分数卡在门槛下、该有却没有此标签的图'),
                () => this.findGaps(row)));
            actions.appendChild(this._actionBtn('🧪',
                t('Model audit: which tagger scored this tag, at what confidence',
                  '模型视角：这个标签是谁打的、信心多高'),
                () => this.auditTag(row)));
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
            panel.textContent = t('Searching for near-miss scores…', '正在搜索卡在门槛下的分数…');
            const ids = this._queueIds().filter(id => id > 0);
            if (ids.length === 0) {
                panel.textContent = t(
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
                panel.textContent = t('Find-missed failed: ', '找漏打失败：') + String(e.message || e);
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
                ? t(`No missed images for "${row.spelling}" (scores ${band}). Images tagged before v3.5.x have no score records — re-tag to collect them.`,
                    `「${row.spelling}」没有疑似漏打的图（分数区间 ${band}）。旧版本打的标没有分数记录 — 重新打标后才可用。`)
                : t(`${gaps.length} image(s) probably missed "${row.spelling}" (score ${band}):`,
                    `${gaps.length} 张图疑似漏打「${row.spelling}」（分数 ${band}）：`);
            head.appendChild(title);
            head.appendChild(this._actionBtn('✕', t('Close', '关闭'),
                () => { panel.hidden = true; panel.textContent = ''; }));
            panel.appendChild(head);
            if (gaps.length === 0) return;

            const fixAll = document.createElement('button');
            fixAll.type = 'button';
            fixAll.className = 'btn btn-secondary btn-small';
            fixAll.textContent = t(
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
                    t('Open this image in the editor', '在编辑器中打开这张图'),
                    () => this.dm?._setActive?.(Number(gap.image_id))));
                panel.appendChild(line);
            }
            if (gaps.length > 30) {
                const more = document.createElement('div');
                more.className = 'sepcon-gap-line';
                more.textContent = t(
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
                window.App?.showToast?.(t('Failed: ', '失败：') + String(e.message || e), 'error');
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
                if (parts.some(s => fold(s) === row.key)) continue;
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
                t(`Added "${row.spelling}" to ${ids.length} images (undo in Mass Tag Editor)`,
                  `已给 ${ids.length} 张图补上「${row.spelling}」（可在批量标签编辑器撤销）`),
                'success');
            this.findGaps(row);
            this.refresh();
        },

        // ---- Tag info popover (roadmap #6: learn while tagging) ---------------
        async showTagInfo(row) {
            const panel = this._gapsPanel();
            panel.hidden = false;
            panel.textContent = t('Loading tag info…', '加载标签资料…');
            try {
                const response = await fetch(
                    `/api/tags/info?tag=${encodeURIComponent(row.key.replace(/ /g, '_'))}`
                );
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                this._renderTagInfo(panel, row, await response.json());
            } catch (e) {
                panel.textContent = t('Tag info failed: ', '标签资料加载失败：') + String(e.message || e);
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
            head.appendChild(this._actionBtn('✕', t('Close', '关闭'),
                () => { panel.hidden = true; panel.textContent = ''; }));
            panel.appendChild(head);

            const lines = [];
            if (info.canonical && info.canonical !== row.key) {
                lines.push(t(`Alias of "${info.canonical}"`, `是「${info.canonical}」的别名`));
            }
            lines.push(t(
                `Library: ${info.library_count} images · danbooru popularity: ${info.found_in_vocab ? info.danbooru_count.toLocaleString() : t('not in vocab', '词表外')}`,
                `库内 ${info.library_count} 张 · danbooru 热度：${info.found_in_vocab ? info.danbooru_count.toLocaleString() : '词表外'}`));
            if ((info.aliases || []).length) {
                lines.push(t('Aliases: ', '别名：') + info.aliases.slice(0, 8).join(', '));
            }
            if ((info.implies || []).length) {
                lines.push(t('Implies (redundant parents): ', '蕴含（冗余上位标签）：') + info.implies.join(', '));
            }
            if ((info.implied_by || []).length) {
                lines.push(t('Implied by: ', '被这些标签蕴含：') + info.implied_by.slice(0, 8).join(', '));
            }
            for (const textLine of lines) {
                const line = document.createElement('div');
                line.className = 'sepcon-gap-line';
                line.textContent = textLine;
                panel.appendChild(line);
            }
        },

        // ---- BE-1-UI per-model tag audit --------------------------------------
        async auditTag(row) {
            const panel = this._gapsPanel();
            panel.hidden = false;
            panel.textContent = t('Loading model audit…', '加载模型视角…');
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
                panel.textContent = t('Model audit failed: ', '模型视角加载失败：') + String(e.message || e);
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
                ? t(`No stored scores for "${row.spelling}" — images tagged before v3.5.x have no records.`,
                    `「${row.spelling}」没有分数记录 — 旧版本打的标没有记录，重新打标后可用。`)
                : t(`Who scored "${row.spelling}" (${report.scope_images} images in scope):`,
                    `「${row.spelling}」的模型视角（范围 ${report.scope_images} 张）：`);
            head.appendChild(title);
            head.appendChild(this._actionBtn('✕', t('Close', '关闭'),
                () => { panel.hidden = true; panel.textContent = ''; }));
            panel.appendChild(head);
            for (const entry of models) {
                const line = document.createElement('div');
                line.className = 'sepcon-gap-line';
                const label = document.createElement('span');
                label.textContent = t(
                    `${entry.model} · ${entry.images} img · avg ${entry.avg_score} · max ${entry.max_score}`,
                    `${entry.model} · ${entry.images} 张 · 均值 ${entry.avg_score} · 最高 ${entry.max_score}`);
                line.appendChild(label);
                panel.appendChild(line);
            }
        },

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
                    option.textContent = t('consensus (all models)', 'consensus（全模型投票）');
                    model.appendChild(option);
                }
                if (models.length === 0) {
                    model.disabled = true;
                    if (status) {
                        status.textContent = t(
                            'No stored scores yet — images tagged from v3.5.x onward collect them automatically.',
                            '还没有分数记录 — 从 v3.5.x 起打标会自动收集，旧图重新打标即可。');
                    }
                } else {
                    this._rtScheduleDryRun(0);
                }
            } catch (e) {
                if (status) status.textContent = t('Could not load score stats: ', '无法加载分数统计：') + String(e.message || e);
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
                    status.textContent = t('No gallery images in the queue.', '队列中没有图库图片。');
                }
                return;
            }
            const seq = ++this._rtSeq;
            if (status) status.textContent = t('Previewing…', '预览中…');
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
                    status.textContent = t(
                        `${report.with_scores}/${report.requested} images have scores · ${report.images_changed} would change (+${report.tags_added} / −${report.tags_removed} tags)`,
                        `${report.with_scores}/${report.requested} 张有分数记录 · ${report.images_changed} 张会变（+${report.tags_added} / −${report.tags_removed} 个标签）`);
                }
                if (apply) apply.disabled = !(report.with_scores > 0);
            } catch (e) {
                if (seq !== this._rtSeq) return;
                if (status) status.textContent = t('Preview failed: ', '预览失败：') + String(e.message || e);
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
            if (status) status.textContent = t('Applying…', '套用中…');
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
                    t(`Re-threshold applied: ${report.images_changed} images updated (+${report.tags_added} / −${report.tags_removed})`,
                      `重定门槛已套用：更新 ${report.images_changed} 张（+${report.tags_added} / −${report.tags_removed}）`),
                    'success');
                if (status) {
                    status.textContent = t(
                        'Applied. Sliding again re-previews — the stored scores are unchanged, so any cutoff stays reachable.',
                        '已套用。分数记录不变，随时可再拉滑杆改回任何门槛。');
                }
                // DB tag rows changed under the queue — re-pull captions so the
                // editor and console reflect the new cutoff.
                await this.dm?._refreshAllCaptions?.();
                this.refresh();
            } catch (e) {
                if (status) status.textContent = t('Apply failed: ', '套用失败：') + String(e.message || e);
            } finally {
                if (apply) apply.disabled = false;
            }
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
