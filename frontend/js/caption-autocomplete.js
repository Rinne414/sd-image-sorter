/**
 * Caption autocomplete (v3.2.2 T-power-PR3 / I).
 *
 * Surface: the Dataset Maker caption editor textarea.
 *
 * Behaviour rules (per user discussion):
 *   - Suggestion-style only — never blocks free typing. Any keystroke
 *     not in {Tab, Enter, Escape, ArrowUp, ArrowDown} commits as raw text.
 *   - Trigger only when the current token (last comma-segment, trimmed)
 *     looks tag-like: ASCII letters / digits / underscore / hyphen,
 *     length >= 2.
 *   - Skip Natural-Language tokens: if the token contains a space AND
 *     length > 6, treat it as prose and don't suggest.
 *   - Source: Tag Vocabulary panel's frequency list (window.DatasetMaker
 *     ._auditState's lastReport tags + the dataset/vocab API). Falls back
 *     to a small top-200 danbooru frequency list bundled below.
 *   - Tab or Enter on a focused suggestion accepts; commits replace the
 *     current token in place and add ", " for the next entry.
 */
(function () {
    'use strict';

    const DEFAULT_FALLBACK = [
        '1girl', '1boy', 'solo', 'long_hair', 'short_hair', 'blonde_hair',
        'black_hair', 'brown_hair', 'white_hair', 'silver_hair', 'pink_hair',
        'red_hair', 'blue_hair', 'green_hair', 'purple_hair', 'multicolored_hair',
        'looking_at_viewer', 'smile', 'open_mouth', 'closed_mouth', 'blush',
        'school_uniform', 'serafuku', 'shirt', 'skirt', 'dress',
        'breasts', 'large_breasts', 'medium_breasts', 'small_breasts',
        'sitting', 'standing', 'lying', 'kneeling',
        'indoors', 'outdoors', 'simple_background', 'white_background',
        'cowboy_shot', 'upper_body', 'full_body', 'portrait', 'close-up',
        'highres', 'absurdres',
    ];

    const STATE = {
        lastSuggestions: [],
        active: -1,
        dropdown: null,
        textarea: null,
        cachedVocab: null, // [{tag, count}]
        lastFetchAt: 0,
    };

    function vocabSource() {
        // Prefer the live audit/vocab cache if Dataset Maker has it.
        if (window.DatasetMaker?._auditState?.lastReport?.items) {
            const tags = new Set();
            for (const it of window.DatasetMaker._auditState.lastReport.items) {
                for (const flag of (it.flags || [])) {
                    // not used — we just want any tag-like activity
                }
            }
        }
        return STATE.cachedVocab || DEFAULT_FALLBACK.map((t) => ({ tag: t, count: 1 }));
    }

    async function refreshVocab() {
        // Throttle: 30 s
        if (Date.now() - STATE.lastFetchAt < 30_000 && STATE.cachedVocab) return;
        const dm = window.DatasetMaker;
        if (!dm || !Array.isArray(dm.imageIds) || dm.imageIds.length === 0) {
            STATE.cachedVocab = DEFAULT_FALLBACK.map((t) => ({ tag: t, count: 1 }));
            return;
        }
        const galleryIds = [];
        const localCaps = {};
        for (const id of dm.imageIds) {
            if (dm.isLocalId && dm.isLocalId(id)) {
                const p = dm.localItemPaths?.get?.(id);
                const cap = dm.captionEdits?.get?.(id);
                if (p && cap) localCaps[p] = cap;
            } else {
                galleryIds.push(Number(id));
            }
        }
        try {
            const r = await fetch('/api/dataset/vocab', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_ids: galleryIds,
                    path_caption_overrides: localCaps,
                    top_n: 500,
                }),
            });
            if (!r.ok) return;
            const data = await r.json();
            const live = data.vocab || [];
            // Merge with fallback so a fresh dataset still gets useful hints.
            const seen = new Set(live.map((v) => v.tag));
            const fallback = DEFAULT_FALLBACK
                .filter((t) => !seen.has(t))
                .map((t) => ({ tag: t, count: 0 }));
            STATE.cachedVocab = [...live, ...fallback];
            STATE.lastFetchAt = Date.now();
        } catch { /* fall back silently */ }
    }

    function currentToken(textarea) {
        const value = textarea.value || '';
        const cursor = textarea.selectionStart ?? value.length;
        const left = value.slice(0, cursor);
        // Last comma OR newline boundary.
        const startIdx = Math.max(left.lastIndexOf(','), left.lastIndexOf('\n'));
        const tokenStart = startIdx >= 0 ? startIdx + 1 : 0;
        const tokenRaw = left.slice(tokenStart);
        const tokenTrimmed = tokenRaw.trimStart();
        const tokenStartActual = tokenStart + (tokenRaw.length - tokenTrimmed.length);
        return {
            text: tokenTrimmed,
            start: tokenStartActual,
            end: cursor,
        };
    }

    function shouldSuggest(token) {
        if (!token || token.length < 2) return false;
        // Only ASCII tag-like tokens.
        if (!/^[A-Za-z0-9_\-]+$/.test(token)) return false;
        return true;
    }

    function findMatches(token) {
        const q = token.toLowerCase();
        const vocab = vocabSource();
        const exact = [];
        const prefix = [];
        const contains = [];
        for (const entry of vocab) {
            const t = String(entry.tag || '').toLowerCase();
            if (!t) continue;
            if (t === q) exact.push(entry);
            else if (t.startsWith(q)) prefix.push(entry);
            else if (t.includes(q)) contains.push(entry);
            if (exact.length + prefix.length + contains.length >= 50) break;
        }
        return [...exact, ...prefix, ...contains].slice(0, 8);
    }

    function ensureDropdown() {
        if (STATE.dropdown) return STATE.dropdown;
        const div = document.createElement('div');
        div.className = 'caption-autocomplete-dropdown';
        div.setAttribute('role', 'listbox');
        div.hidden = true;
        document.body.appendChild(div);
        STATE.dropdown = div;
        return div;
    }

    function hideDropdown() {
        if (STATE.dropdown) STATE.dropdown.hidden = true;
        STATE.lastSuggestions = [];
        STATE.active = -1;
    }

    function renderDropdown(textarea, suggestions) {
        const dd = ensureDropdown();
        STATE.lastSuggestions = suggestions;
        STATE.active = suggestions.length > 0 ? 0 : -1;
        if (suggestions.length === 0) {
            dd.hidden = true;
            return;
        }
        dd.innerHTML = '';
        suggestions.forEach((s, idx) => {
            const item = document.createElement('div');
            item.className = 'caption-autocomplete-item' + (idx === 0 ? ' active' : '');
            item.dataset.tag = s.tag;
            const name = document.createElement('span');
            name.className = 'caption-autocomplete-name';
            name.textContent = s.tag;
            const count = document.createElement('span');
            count.className = 'caption-autocomplete-count';
            count.textContent = s.count > 0 ? String(s.count) : '';
            item.append(name, count);
            item.addEventListener('mousedown', (e) => {
                // mousedown so the click commits before the textarea blurs.
                e.preventDefault();
                accept(textarea, idx);
            });
            dd.appendChild(item);
        });
        dd.hidden = false;
        const rect = textarea.getBoundingClientRect();
        window.PopupPosition?.place(dd, {
            anchor: textarea,
            placement: 'bottom-start',
            gap: 4,
            width: Math.min(rect.width, 320),
            maxHeight: 280,
        });
    }

    function accept(textarea, suggestionIdx) {
        const s = STATE.lastSuggestions[suggestionIdx];
        if (!s) return;
        const tok = currentToken(textarea);
        const value = textarea.value || '';
        const before = value.slice(0, tok.start);
        const after = value.slice(tok.end);
        // Append a comma-space if the next char isn't already a comma.
        const sep = after.startsWith(',') || after.startsWith('\n') ? '' : ', ';
        const replaced = `${before}${s.tag}${sep}${after}`;
        textarea.value = replaced;
        const newCursor = (before + s.tag + sep).length;
        textarea.setSelectionRange(newCursor, newCursor);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        hideDropdown();
    }

    function highlightActive() {
        const dd = STATE.dropdown;
        if (!dd) return;
        for (const [i, el] of Array.from(dd.children).entries()) {
            el.classList.toggle('active', i === STATE.active);
        }
    }

    function attach(textarea) {
        if (!textarea || textarea.dataset.captionAutocomplete === '1') return;
        textarea.dataset.captionAutocomplete = '1';
        STATE.textarea = textarea;

        let inputDebounce = null;
        textarea.addEventListener('input', () => {
            if (inputDebounce) clearTimeout(inputDebounce);
            inputDebounce = setTimeout(async () => {
                await refreshVocab();
                const tok = currentToken(textarea);
                if (!shouldSuggest(tok.text)) {
                    hideDropdown();
                    return;
                }
                // NL guard: if the token already contains spaces, treat as prose.
                if (tok.text.includes(' ') && tok.text.length > 6) {
                    hideDropdown();
                    return;
                }
                const matches = findMatches(tok.text);
                renderDropdown(textarea, matches);
            }, 80);
        });

        textarea.addEventListener('keydown', (e) => {
            if (!STATE.dropdown || STATE.dropdown.hidden) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                STATE.active = (STATE.active + 1) % STATE.lastSuggestions.length;
                highlightActive();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                STATE.active = (STATE.active - 1 + STATE.lastSuggestions.length) % STATE.lastSuggestions.length;
                highlightActive();
            } else if (e.key === 'Tab' || e.key === 'Enter') {
                if (STATE.active >= 0) {
                    e.preventDefault();
                    accept(textarea, STATE.active);
                }
            } else if (e.key === 'Escape') {
                hideDropdown();
            }
        });

        textarea.addEventListener('blur', () => {
            // Defer in case the blur was triggered by clicking a suggestion.
            setTimeout(hideDropdown, 200);
        });
    }

    function bind() {
        const ta = document.getElementById('dataset-editor-textarea');
        if (ta) attach(ta);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }

    window.CaptionAutocomplete = { attach, refreshVocab };
})();
