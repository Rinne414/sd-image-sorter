/**
 * Tag autocomplete (v3.5.0 — upgraded from the v3.2.2 single-surface version).
 *
 * Shared type-ahead for every comma-separated tag input:
 *   - Dataset Maker caption editor  (#dataset-editor-textarea)
 *   - Image detail tag editor       (#modal-tags-add-input)
 *   - Mass tag editor "add" box     (#mass-tag-add-tags)
 *   - Caption-editor export preview (.export-preview-main-textarea, attached
 *     by v321-ui.js each render)
 *
 * Source: GET /api/tags/suggest — the user's own library tags merged with
 * the bundled danbooru vocabulary (alias-aware; CJK queries match the
 * optional Chinese translation drop-in). Falls back to a tiny local list
 * when the endpoint is unreachable.
 *
 * Behaviour rules (unchanged from v3.2.2):
 *   - Suggestion-style only — never blocks free typing. Any keystroke
 *     not in {Tab, Enter, Escape, ArrowUp, ArrowDown} commits as raw text.
 *   - Trigger on tag-like ASCII tokens (>= 2 chars) or CJK tokens (>= 1).
 *   - Skip Natural-Language prose: token contains a space AND length > 6.
 *   - Tab/Enter accepts the highlighted suggestion; commits replace the
 *     current token in place and add ", " for the next entry.
 *   - Keydown handling runs in the CAPTURE phase so surfaces with their
 *     own Enter handlers (image detail modal) don't race the accept.
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

    const SUGGEST_LIMIT = 12;
    const DEBOUNCE_MS = 120;
    const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

    const STATE = {
        lastSuggestions: [],
        active: -1,
        dropdown: null,
        abort: null,
        seq: 0,
    };

    function currentToken(el) {
        const value = el.value || '';
        const cursor = el.selectionStart ?? value.length;
        const left = value.slice(0, cursor);
        // Comma-separated tag inputs break tokens on comma/newline. Insert
        // mode (free-writing prompt boxes) also breaks on spaces and the
        // weight syntax "(tag:1.2)" so suggestions track just the word
        // under the caret.
        let startIdx = Math.max(left.lastIndexOf(','), left.lastIndexOf('\n'));
        if (el.dataset.capAcMode === 'insert') {
            startIdx = Math.max(
                startIdx,
                left.lastIndexOf(' '),
                left.lastIndexOf('('),
                left.lastIndexOf(')'),
                left.lastIndexOf(':'),
            );
        }
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
        if (!token) return false;
        if (CJK_RE.test(token)) return !token.includes(' ');
        if (token.length < 2) return false;
        // Only ASCII tag-like tokens otherwise.
        if (!/^[A-Za-z0-9_\-]+$/.test(token)) return false;
        return true;
    }

    function localFallbackMatches(token) {
        const q = token.toLowerCase();
        const prefix = [];
        const contains = [];
        for (const tag of DEFAULT_FALLBACK) {
            if (tag.startsWith(q)) prefix.push(tag);
            else if (tag.includes(q)) contains.push(tag);
        }
        return [...prefix, ...contains]
            .slice(0, 8)
            .map((tag) => ({ tag, count: 0, source: 'library', category: 'unknown', zh: null }));
    }

    async function fetchSuggestions(token) {
        const seq = ++STATE.seq;
        if (STATE.abort) STATE.abort.abort();
        const controller = new AbortController();
        STATE.abort = controller;
        try {
            const url = `/api/tags/suggest?q=${encodeURIComponent(token)}&limit=${SUGGEST_LIMIT}`;
            const r = await fetch(url, { signal: controller.signal });
            if (!r.ok) throw new Error(`suggest ${r.status}`);
            const data = await r.json();
            if (seq !== STATE.seq) return null; // stale response
            return Array.isArray(data.suggestions) ? data.suggestions : [];
        } catch (err) {
            if (err && err.name === 'AbortError') return null;
            if (seq !== STATE.seq) return null;
            return localFallbackMatches(token);
        }
    }

    function formatCount(n) {
        const num = Number(n) || 0;
        if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
        if (num >= 1_000) return `${Math.round(num / 1_000)}k`;
        return num > 0 ? String(num) : '';
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

    function renderDropdown(el, suggestions) {
        const dd = ensureDropdown();
        STATE.lastSuggestions = suggestions;
        STATE.active = suggestions.length > 0 ? 0 : -1;
        if (suggestions.length === 0) {
            dd.hidden = true;
            return;
        }
        dd.replaceChildren();
        suggestions.forEach((s, idx) => {
            const item = document.createElement('div');
            item.className = 'caption-autocomplete-item' + (idx === 0 ? ' active' : '');
            if (s.source === 'library') item.classList.add('is-library');
            item.dataset.tag = s.tag;

            const dot = document.createElement('span');
            dot.className = `cap-ac-dot cap-ac-dot-${s.category || 'unknown'}`;

            const name = document.createElement('span');
            name.className = 'caption-autocomplete-name';
            name.textContent = s.tag;

            const meta = document.createElement('span');
            meta.className = 'caption-autocomplete-meta';
            if (s.zh) {
                const zh = document.createElement('span');
                zh.className = 'caption-autocomplete-zh';
                zh.textContent = s.zh;
                meta.appendChild(zh);
            }
            const count = document.createElement('span');
            count.className = 'caption-autocomplete-count';
            count.textContent = formatCount(s.count);
            meta.appendChild(count);

            item.append(dot, name, meta);
            item.addEventListener('mousedown', (e) => {
                // mousedown so the click commits before the input blurs.
                e.preventDefault();
                accept(el, idx);
            });
            dd.appendChild(item);
        });
        dd.hidden = false;
        const rect = el.getBoundingClientRect();
        window.PopupPosition?.place(dd, {
            anchor: el,
            placement: 'bottom-start',
            gap: 4,
            width: Math.min(Math.max(rect.width, 240), 360),
            maxHeight: 280,
        });
    }

    function accept(el, suggestionIdx) {
        const s = STATE.lastSuggestions[suggestionIdx];
        if (!s) return;
        const tok = currentToken(el);
        const value = el.value || '';
        const before = value.slice(0, tok.start);
        const after = value.slice(tok.end);
        // Comma mode appends ", " for the next entry; insert mode (prompt
        // writing boxes) completes the word in place and stays out of the
        // author's flow.
        const sep = el.dataset.capAcMode === 'insert' || after.startsWith(',') || after.startsWith('\n')
            ? ''
            : ', ';
        el.value = `${before}${s.tag}${sep}${after}`;
        const newCursor = (before + s.tag + sep).length;
        el.setSelectionRange(newCursor, newCursor);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        hideDropdown();
    }

    function highlightActive() {
        const dd = STATE.dropdown;
        if (!dd) return;
        for (const [i, node] of Array.from(dd.children).entries()) {
            node.classList.toggle('active', i === STATE.active);
        }
    }

    function attach(el, opts) {
        if (!el || el.dataset.captionAutocomplete === '1') return;
        el.dataset.captionAutocomplete = '1';
        if (opts && opts.mode === 'insert') el.dataset.capAcMode = 'insert';

        let inputDebounce = null;
        el.addEventListener('input', () => {
            if (inputDebounce) clearTimeout(inputDebounce);
            inputDebounce = setTimeout(async () => {
                const tok = currentToken(el);
                if (!shouldSuggest(tok.text)) {
                    hideDropdown();
                    return;
                }
                // NL guard: if the token already contains spaces, treat as prose.
                if (tok.text.includes(' ') && tok.text.length > 6) {
                    hideDropdown();
                    return;
                }
                const matches = await fetchSuggestions(tok.text);
                if (matches === null) return; // superseded by a newer keystroke
                // Re-check the token: it may have changed while fetching.
                const now = currentToken(el);
                if (now.text !== tok.text || document.activeElement !== el) {
                    if (document.activeElement !== el) hideDropdown();
                    return;
                }
                renderDropdown(el, matches);
            }, DEBOUNCE_MS);
        });

        // Capture phase: surfaces like the image-detail modal bind their own
        // Enter handler on the same element; accepting a suggestion must win
        // and stop that handler from also firing.
        el.addEventListener('keydown', (e) => {
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
                    e.stopImmediatePropagation();
                    accept(el, STATE.active);
                }
            } else if (e.key === 'Escape') {
                e.stopImmediatePropagation();
                hideDropdown();
            }
        }, true);

        el.addEventListener('blur', () => {
            // Defer in case the blur was triggered by clicking a suggestion.
            setTimeout(hideDropdown, 200);
        });
    }

    function bind() {
        const surfaces = [
            'dataset-editor-textarea',   // Dataset Maker caption editor
            'modal-tags-add-input',      // image detail tag editor
            'mass-tag-add-tags',         // mass tag editor: add
            'mass-tag-remove-tags',      // mass tag editor: remove
            'dataset-blacklist',         // Dataset Maker export blacklist
            'tag-pre-blacklist',         // AI tagging pre-blacklist
            'batch-export-blacklist',    // batch export blacklist
        ];
        for (const id of surfaces) {
            const el = document.getElementById(id);
            if (el) attach(el);
        }
        // Prompt Lab writing boxes: complete the word under the caret
        // without inserting comma separators (owner-approved insert mode).
        for (const id of ['pl-build-prompt', 'pl-build-negative']) {
            const el = document.getElementById(id);
            if (el) attach(el, { mode: 'insert' });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }

    function isOpen() {
        return !!(STATE.dropdown && !STATE.dropdown.hidden && STATE.active >= 0);
    }

    // refreshVocab kept as a no-op for API compatibility (the suggest
    // endpoint queries live data; there is no client-side vocab cache).
    // isOpen lets surfaces with their own Enter handlers (image detail
    // modal) yield to the suggestion accept regardless of listener order.
    window.CaptionAutocomplete = { attach, isOpen, refreshVocab: async () => {} };
})();
