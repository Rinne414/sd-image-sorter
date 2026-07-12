/**
 * Dataset Maker — tag tooling: category classification (+/api/prompts/categorize cache), category reorder, tag pills, batch find/replace.
 * Moved VERBATIM from dataset-maker-part2.js L1217-1437 + L1458-1537.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // ---------- Tag pills ----------
    // Categories mirror the backend classifier (tag_rules.categorize_tag, served
    // by POST /api/prompts/categorize) so EVERY danbooru tag gets a real group +
    // color and the per-group reorder control (#dataset-tag-category-order)
    // covers them all. The backend is authoritative (filled async into
    // _tagCategoryCache); the local regexes below are only a synchronous
    // first-paint / offline fallback.
    const TAG_CATEGORY_ORDER_DEFAULT = [
        'quality', 'meta', 'rating', 'character', 'body', 'outfit',
        'expression', 'pose', 'action', 'angle', 'background', 'style',
        'artist', 'unknown',
    ];
    const TAG_CATEGORY_SET = new Set(TAG_CATEGORY_ORDER_DEFAULT);

    const QUALITY_RE = /^(masterpiece|best[_ ]?quality|high[_ ]?quality|normal[_ ]?quality|low[_ ]?quality|worst[_ ]?quality|absurdres|highres|lowres|score_\d|ultra-?detailed|8k|4k)$/i;
    const RATING_RE = /^(rating[:_].*|safe|sensitive|questionable|explicit|nsfw|sfw)$/i;
    const META_RE = /^(\d+\+?(girl|boy|other)s?|multiple_(girls|boys)|solo|solo_focus|signature|watermark|username|artist_name|web_address|logo|dated|commentary.*|monochrome|greyscale|grayscale)$/i;
    const ANGLE_RE = /(_focus$|from_(above|below|behind|side)|cowboy_shot|full_body|upper_body|lower_body|portrait|close[-_]?up|wide_shot|dutch_angle|fisheye|^pov$|straight-on)/i;
    const EXPRESSION_RE = /(blush|smile|smiling|frown|crying|tears|surprised|angry|sweat|^:?[dpo3<>x]$|open_mouth|closed_eyes|looking_at_viewer|looking_(away|back|down|up|to_the)|expression|embarrassed|smug|pout|grin|wink|nervous|happy|sad|scared)/i;
    const BODY_RE = /(hair|eyes?|eyebrows?|eyelashes|face|bangs|twintails|ponytail|braid|ahoge|sidelocks|skin|freckles|mole|fang|ears?|tail|wings|horns?|breasts?|cleavage|thighs?|legs?|arms?|hands?|fingers?|feet|toes|navel|stomach|collarbone|shoulders?|waist|hips?|teeth|tongue|lips|nose|cheeks?|abs|muscle)/i;
    const OUTFIT_RE = /(shirt|skirt|dress|uniform|sleeves?|jacket|coat|pants|shorts|shoes|boots|socks|gloves|hat|cap|helmet|ribbon|bowtie|bow$|necktie|tie$|scarf|clothes?|clothing|outfit|costume|bikini|swimsuit|lingerie|panties|underwear|bra|thighhighs|pantyhose|kneehighs|legwear|apron|hood|cape|armor|jewelry|earrings|necklace|bracelet|glasses|goggles|mask|veil|kimono|serafuku)/i;
    const POSE_RE = /(standing|sitting|kneeling|lying|squatting|crouching|leaning|bent_over|arms?_(up|behind|crossed)|hands?_(on|up|behind|together)|spread_|legs?_(up|apart|crossed)|knees|on_(back|side|stomach)|wariza|seiza|all_fours|arched_back)/i;
    const ACTION_RE = /(holding|hugging|kissing|licking|eating|drinking|cooking|running|walking|jumping|dancing|sleeping|reading|writing|playing|fighting|grabbing|pulling|pushing|touching|carrying|throwing|waving|pointing|covering|undressing|bathing|riding|flying|falling|smoking|singing)/i;
    const BACKGROUND_RE = /(background$|outdoors|indoors|sky|cloud|tree|forest|beach|ocean|sea|lake|river|mountain|city|town|street|road|room|classroom|bedroom|kitchen|bathroom|office|garden|field|grass|flower|water|night|day|sunset|sunrise|snow|rain|window|wall|building|nature|scenery|cityscape|landscape|interior)/i;
    const STYLE_RE = /(sketch|lineart|line_art|watercolou?r|oil_painting|painting|pixel_art|chibi|realistic|photorealistic|3d|cel_shading|flat_color|retro|art_nouveau|impasto|traditional_media|official_art|concept_art)/i;

    DM._tagCategoryCache = DM._tagCategoryCache || new Map();

    DM._classifyTagCategory = function (tag) {
        const value = String(tag || '').trim();
        if (!value) return 'unknown';
        const normalized = value.toLowerCase().replace(/\s+/g, '_');
        // Authoritative backend category once _ensureTagCategories has filled it.
        const cached = this._tagCategoryCache && this._tagCategoryCache.get(normalized);
        if (cached && TAG_CATEGORY_SET.has(cached)) return cached;
        // Synchronous best-effort fallback (first paint / offline). Character &
        // artist need the danbooru data sets, so locally they fall through to
        // 'unknown' and get corrected by the backend.
        // Prompt-convention artist prefixes are unambiguous without data sets:
        // Anima-style "@name" triggers and SDXL "artist:name".
        if (normalized.length > 1 && (normalized.startsWith('@') || normalized.startsWith('artist:'))) return 'artist';
        if (QUALITY_RE.test(normalized)) return 'quality';
        if (RATING_RE.test(normalized)) return 'rating';
        if (META_RE.test(normalized)) return 'meta';
        if (ANGLE_RE.test(normalized)) return 'angle';
        if (EXPRESSION_RE.test(normalized)) return 'expression';
        if (OUTFIT_RE.test(normalized)) return 'outfit';
        if (BODY_RE.test(normalized)) return 'body';
        if (ACTION_RE.test(normalized)) return 'action';
        if (POSE_RE.test(normalized)) return 'pose';
        if (BACKGROUND_RE.test(normalized)) return 'background';
        if (STYLE_RE.test(normalized)) return 'style';
        return 'unknown';
    };

    // Fill the category cache from the backend's 14-class classifier
    // (POST /api/prompts/categorize). Returns true if the cache gained entries
    // so the caller can re-render. Mirrors the _fetchTagZh cache+guard pattern.
    DM._ensureTagCategories = async function (tags) {
        const seen = new Set();
        const miss = [];
        for (const t of (tags || [])) {
            const raw = String(t || '').trim();
            const norm = raw.toLowerCase().replace(/\s+/g, '_');
            if (!norm || seen.has(norm) || this._tagCategoryCache.has(norm)) continue;
            // Skip multi-word natural-language fragments — not booru tags.
            if (/\s/.test(raw) && raw.split(/\s+/).length > 3) continue;
            seen.add(norm);
            miss.push(norm);
        }
        if (!miss.length) return false;
        let gained = false;
        const CHUNK = 500;
        for (let i = 0; i < miss.length; i += CHUNK) {
            const batch = miss.slice(i, i + CHUNK);
            try {
                const r = await fetch('/api/prompts/categorize', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(batch),
                });
                if (!r.ok) continue;
                const d = await r.json();
                for (const it of (d.results || [])) {
                    const key = String(it.tag || '').toLowerCase().replace(/\s+/g, '_');
                    let cat = String(it.category || 'unknown').toLowerCase();
                    if (!TAG_CATEGORY_SET.has(cat)) cat = 'unknown';
                    if (key) { this._tagCategoryCache.set(key, cat); gained = true; }
                }
            } catch (_e) { /* keep local fallback */ }
        }
        return gained;
    };

    DM._tagCategoryOrder = function () {
        const raw = document.getElementById('dataset-tag-category-order')?.value || '';
        const parsed = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        const seen = new Set();
        const order = [];
        for (const name of parsed) {
            if (TAG_CATEGORY_ORDER_DEFAULT.includes(name) && !seen.has(name)) {
                seen.add(name);
                order.push(name);
            }
        }
        for (const name of TAG_CATEGORY_ORDER_DEFAULT) {
            if (!seen.has(name)) order.push(name);
        }
        return order;
    };

    DM._applyTagCategoryOrder = async function () {
        const ids = typeof this._captionScopeIds === 'function' ? this._captionScopeIds() : [Number(this.activeId)];
        if (!ids.length) {
            this._toast(this._t('dataset.noActiveImage', 'Select an image first.'), 'warning', 3000);
            return;
        }
        // Resolve real backend categories for every tag in scope first, so the
        // group reorder uses the true danbooru group of each tag (not just the
        // synchronous first-paint guess).
        const scopeTags = new Set();
        for (const id of ids) {
            const cap = this.captionEdits.has(id) ? this.captionEdits.get(id) : (this.captions.get(id) || '');
            String(cap || '').split(',').forEach((s) => { const v = s.trim(); if (v) scopeTags.add(v); });
        }
        if (scopeTags.size && typeof this._ensureTagCategories === 'function') {
            try { await this._ensureTagCategories([...scopeTags]); } catch (_e) { /* fall back to local */ }
        }
        const order = this._tagCategoryOrder();
        const rank = new Map(order.map((name, idx) => [name, idx]));
        let changed = 0;
        for (const id of ids) {
            const caption = this.captionEdits.has(id) ? this.captionEdits.get(id) : (this.captions.get(id) || '');
            const parts = String(caption || '').split(',').map((s) => s.trim()).filter(Boolean);
            if (parts.length <= 1) continue;
            const sorted = parts
                .map((tag, index) => ({ tag, index, category: this._classifyTagCategory(tag) }))
                .sort((a, b) => (rank.get(a.category) ?? 99) - (rank.get(b.category) ?? 99) || a.index - b.index)
                .map((item) => item.tag);
            const next = sorted.join(', ');
            if (next !== caption) {
                this.captionEdits.set(id, next);
                this._refreshQueueItem?.(id);
                changed += 1;
            }
        }
        if (this.activeId != null) this._setActive(this.activeId);
        this._renderTagPills();
        this._refreshExportPreview?.();
        this._toast(this._t('dataset.tagCategoryOrderApplied',
            'Reordered tags in {count} captions.', { count: changed }),
            changed ? 'success' : 'info', 3000);
    };

    DM._renderTagPills = function () {
        const section = document.getElementById('dataset-tag-pills-section');
        const wrap = document.getElementById('dataset-tag-pills-wrap');
        if (!section || !wrap) return;

        if (this.activeId == null) {
            section.hidden = true;
            return;
        }

        const caption = this.captionEdits.has(this.activeId)
            ? this.captionEdits.get(this.activeId)
            : (this.captions.get(this.activeId) || '');
        const tags = caption.split(',').map(t => t.trim()).filter(Boolean);

        // Pull authoritative backend categories so pills recolor to their true
        // danbooru group once resolved (first paint shows the local regex
        // fallback). The re-render is a no-op fetch-wise since every tag is now
        // cached, so there is no recolor loop.
        if (tags.length && typeof this._ensureTagCategories === 'function') {
            this._ensureTagCategories(tags).then((gained) => {
                if (gained && this.activeId != null) this._renderTagPills();
            }).catch(() => { /* keep local fallback colors */ });
        }

        if (tags.length === 0) {
            wrap.innerHTML = '<span class="dataset-tag-pills-empty">No tags</span>';
            section.hidden = false;
            return;
        }

        wrap.innerHTML = '';
        for (const tag of tags) {
            // Pills are real buttons so they're keyboard-focusable and
            // operable. Previously they were <span>s with only a click
            // handler — mouse-only, no Tab/Enter/Space path, no role.
            const pill = document.createElement('button');
            pill.type = 'button';
            const category = this._classifyTagCategory(tag);
            pill.className = `dataset-tag-pill dataset-tag-pill-category-${category}`;
            const label = document.createElement('span');
            label.textContent = tag;
            const x = document.createElement('span');
            x.className = 'dataset-tag-pill-x';
            x.textContent = 'x';
            x.setAttribute('aria-hidden', 'true');
            pill.append(label, x);
            pill.title = this._t('dataset.tagPillRemove', 'Remove "{tag}"', { tag })
                || `Remove "${tag}"`;
            pill.setAttribute('aria-label', pill.title);
            pill.addEventListener('click', () => this._removeTag(tag));
            wrap.appendChild(pill);
        }
        section.hidden = false;
    };

    DM._removeTag = function (tag) {
        if (this.activeId == null) return;
        const ta = document.getElementById('dataset-editor-textarea');
        if (!ta) return;
        const tags = ta.value.split(',').map(t => t.trim()).filter(Boolean);
        const filtered = tags.filter(t => t !== tag);
        ta.value = filtered.join(', ');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        this._renderTagPills();
    };

    // ---------- Batch Find/Replace ----------
    DM._batchFindReplace = async function () {
        const findEl = document.getElementById('dataset-find-input');
        const replaceEl = document.getElementById('dataset-replace-input');
        if (!findEl || !replaceEl) return;
        const find = findEl.value;
        if (!find) return;
        const btn = document.getElementById('btn-dataset-find-replace');
        const previousText = btn?.textContent;
        if (btn) {
            btn.disabled = true;
            btn.textContent = this._t('dataset.replaceLoading', 'Loading captions...');
        }
        const replace = replaceEl.value;
        // Default is whole-tag: a caption is comma-separated tags, so the user
        // means "rename this tag", not "edit this substring wherever it lands".
        // The opt-in checkbox restores the raw substring behavior.
        const substringMode = !!document.getElementById('dataset-find-substring')?.checked;
        // trim + collapse whitespace + fold _<->space + case-insensitive, so
        // "long_hair" matches "long hair" / "Long  Hair".
        const normalizeTag = (s) => String(s || '').replace(/[\s_]+/g, ' ').trim().toLowerCase();
        const findKey = normalizeTag(find);
        let count = 0;
        try {
            const scopeIds = typeof this._captionScopeIds === 'function' ? this._captionScopeIds() : this.imageIds;
            if (!scopeIds.length) {
                this._toast(this._t('dataset.noCaptionScopeImages',
                    'No images match the current caption action scope.'), 'warning', 3000);
                return;
            }
            const missing = scopeIds
                .filter(id => !(this.isLocalId?.(id)))
                .filter(id => !this.captions.has(id) && !this.captionEdits.has(id));
            if (missing.length) {
                await this._fetchCaptionsFor(missing);
            }
            for (const id of scopeIds) {
                const caption = this.captionEdits.has(id)
                    ? this.captionEdits.get(id)
                    : (this.captions.get(id) || '');
                let updated;
                if (substringMode) {
                    if (!caption.includes(find)) continue;
                    updated = caption.split(find).join(replace);
                } else {
                    // Whole-tag: split on commas, match tokens whose normalized
                    // form equals the find term, and swap the replacement in
                    // verbatim while keeping each token's surrounding spacing.
                    let changed = false;
                    updated = caption.split(',').map((part) => {
                        if (!findKey || normalizeTag(part) !== findKey) return part;
                        changed = true;
                        const m = part.match(/^(\s*)[\s\S]*?(\s*)$/);
                        return `${m ? m[1] : ''}${replace}${m ? m[2] : ''}`;
                    }).join(',');
                    if (!changed) continue;
                }
                this.captionEdits.set(id, updated);
                count++;
            }
            if (count > 0 && this.activeId != null) {
                this._setActive(this.activeId);
            }
            const msg = this._t('dataset.replaceResult', '{count} captions updated')
                .replace('{count}', count);
            if (window.showToast) window.showToast(msg, count > 0 ? 'success' : 'info');
        } finally {
            if (btn) {
                btn.disabled = false;
                if (previousText) btn.textContent = previousText;
            }
        }
    };

    document.getElementById('btn-dataset-find-replace')
        ?.addEventListener('click', () => DM._batchFindReplace());

    document.getElementById('btn-dataset-apply-tag-category-order')
        ?.addEventListener('click', () => DM._applyTagCategoryOrder());
})();
