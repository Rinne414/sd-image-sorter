/**
 * separation-console/render.js — separation-console.js decomposition
 * (verbatim Object.assign mixin). Method bodies moved BYTE-IDENTICAL from
 * frontend/js/modules/separation-console.js pre-cut lines 84-129 + 189-332
 * (of 1,155): estimateTokens + _updateTokenCounter (QW-1 caption token
 * budget), computeStats, refresh (stats line, leak rescan, sort/search,
 * the AS-IS 800-row render cap + overflow notice), _buildRow (category
 * dot, intrinsic-trait badge, the five row actions) and _actionBtn.
 * Strict per-file (the original IIFE was strict). Joins the ONE unsealed
 * object declared in separation-console/core.js, which loads FIRST;
 * separation-console/boot.js publishes window.SeparationConsole LAST.
 * Family renames applied (sepconT/sepconFold/SEPCON_* — see core.js).
 */
'use strict';
Object.assign(SeparationConsole, {

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
            counter.textContent = sepconT(
                `${tagCount} tags · ≈${tokens} tokens`,
                `${tagCount} 个标签 · ≈${tokens} tokens`);
            counter.classList.toggle('dataset-token-counter-over', tokens > budget);
            counter.title = tokens > budget
                ? sepconT(`Over the ~${budget}-token budget for the chosen target model — the encoder truncates the rest.`,
                    `超过所选目标模型的 ~${budget}-token 预算 — 编码器会截断多余部分。`)
                : sepconT(`Estimated tokens (budget ~${budget} for the chosen target model; CLIP default when unset).`,
                    `估算 token 数（当前目标模型预算约 ${budget}；未选择时按 CLIP 预算）。`);
        },

        // ---- stats -------------------------------------------------------
        computeStats() {
            const ids = this._queueIds();
            const counts = new Map(); // folded -> {count, spellings:Set, ids:[]}
            for (const id of ids) {
                const seenHere = new Set();
                for (const raw of this._effectiveCaption(id).split(',')) {
                    const spelled = raw.trim();
                    const key = sepconFold(spelled);
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
                statsEl.textContent = sepconT(
                    `${total} images · ${counts.size} tags · reviewed ${seenCount}/${total}`,
                    `${total} 张图 · ${counts.size} 个标签 · 已过目 ${seenCount}/${total}`);
            }
            this._renderLeaks();

            const query = sepconFold(document.getElementById('sepcon-search')?.value || '');
            const sort = document.getElementById('sepcon-sort')?.value || 'freq';
            const blacklistFolded = new Set(this._blacklistEntries().map(sepconFold));

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
                    intrinsic: ratio >= SEPCON_INTRINSIC_MIN_RATIO && SEPCON_INTRINSIC_RE.test(key.replace(/ /g, '_')),
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
                    overflow.textContent = sepconT(
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
            name.title = sepconT('Click for tag info: category, aliases, implications, counts',
                '点击查看标签资料：分类、别名、蕴含关系、数量');
            name.addEventListener('click', (e) => { e.stopPropagation(); this.showTagInfo(row); });
            div.appendChild(name);

            if (row.intrinsic) {
                const badge = document.createElement('span');
                badge.className = 'sepcon-intrinsic';
                badge.textContent = sepconT('trait', '内在');
                badge.title = sepconT(
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
                    ? sepconT('Un-prune (remove from blacklist)', '取消剪除（移出黑名单）')
                    : sepconT('Prune: blacklist at export so the trigger absorbs it', '剪除：加入导出黑名单，让触发词吸收'),
                () => this.togglePrune(row.key)));
            actions.appendChild(this._actionBtn('🗑',
                sepconT('Remove this tag from every caption (session edit, Ctrl+Z-able per image)', '从所有 caption 中移除此标签（会话级编辑）'),
                () => this.removeEverywhere(row)));
            actions.appendChild(this._actionBtn('📍',
                sepconT('Jump to the next image carrying this tag', '跳到下一张含此标签的图'),
                () => this.locateNext(row)));
            actions.appendChild(this._actionBtn('🔍',
                sepconT('Find missed images: tagger scores just under the threshold without this tag',
                  '找漏打：分数卡在门槛下、该有却没有此标签的图'),
                () => this.findGaps(row)));
            actions.appendChild(this._actionBtn('🧪',
                sepconT('Model audit: which tagger scored this tag, at what confidence',
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

});
