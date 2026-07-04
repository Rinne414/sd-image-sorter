/**
 * Aurora Phase 3 — Gallery toolbar (#25a): key:value search, quick filter
 * chips, and the sticky bottom batch action bar.
 *
 * Everything routes through the SAME FilterStore fields the filter modal
 * uses (window.App.updateFilters) — no parallel filter state. The action
 * bar's buttons are the original selection-panel buttons (same ids, same
 * app.js handlers); this module only owns bar visibility, the stats line,
 * the More dropdown, and the selection-scoped Tag button.
 */
(function () {
    'use strict';

    const SEARCH_DEBOUNCE_MS = 500;
    const CACHE_STATS_TTL_MS = 60000;
    const QUEUE_STATS_TTL_MS = 15000;

    // key:value prefixes → structured filters. Chinese aliases included so the
    // zh-CN placeholder examples work as typed.
    const KEY_ALIASES = {
        tag: 'tag', '标签': 'tag',
        checkpoint: 'checkpoint', model: 'checkpoint', '模型': 'checkpoint',
        lora: 'lora',
        seed: 'seed',
    };

    let searchTimer = null;
    let armedTagIds = null;
    let cacheStats = { at: 0, text: '' };
    let queueStats = { at: 0, text: '', unsupported: false };

    function t(key, fallback) {
        const v = window.I18n && typeof window.I18n.t === 'function' ? window.I18n.t(key) : null;
        return v && v !== key ? v : fallback;
    }

    function app() {
        return window.App || null;
    }

    // ------------------------------------------------------------------
    // Search box: parse `tag:x seed:314 free text` into filter fields
    // ------------------------------------------------------------------

    function parseQuery(raw) {
        const result = { tags: [], checkpoints: [], loras: [], seed: null, freeText: [] };
        const tokens = String(raw || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
        tokens.forEach((token) => {
            const sep = token.indexOf(':');
            if (sep > 0) {
                const rawKey = token.slice(0, sep).toLowerCase();
                const key = KEY_ALIASES[rawKey] || KEY_ALIASES[token.slice(0, sep)];
                let value = token.slice(sep + 1).replace(/^"|"$/g, '').trim();
                if (key && value) {
                    if (key === 'tag') result.tags.push(value);
                    else if (key === 'checkpoint') result.checkpoints.push(value);
                    else if (key === 'lora') result.loras.push(value);
                    else if (key === 'seed') {
                        const n = Number(value);
                        if (Number.isFinite(n)) result.seed = Math.trunc(n);
                        else result.freeText.push(token);
                    }
                    return;
                }
            }
            result.freeText.push(token.replace(/^"|"$/g, ''));
        });
        return result;
    }

    function applySearch(raw) {
        const a = app();
        if (!a || typeof a.updateFilters !== 'function') return;
        const parsed = parseQuery(raw);
        const added = [];

        a.updateFilters((filters) => {
            // Structured tokens ADD to the existing filters (removal happens via
            // the sidebar summary ✕ / Clear all, same as modal-added values).
            parsed.tags.forEach((tag) => {
                if (!filters.tags.includes(tag)) {
                    filters.tags.push(tag);
                    added.push(`tag:${tag}`);
                }
            });
            parsed.checkpoints.forEach((ckpt) => {
                if (!filters.checkpoints.includes(ckpt)) {
                    filters.checkpoints.push(ckpt);
                    added.push(`checkpoint:${ckpt}`);
                }
            });
            parsed.loras.forEach((lora) => {
                if (!filters.loras.includes(lora)) {
                    filters.loras.push(lora);
                    added.push(`lora:${lora}`);
                }
            });
            // Free text + seed are declarative: the box owns them.
            filters.search = parsed.freeText.join(' ').trim();
            filters.seed = parsed.seed;
        });

        if (added.length && typeof a.showToast === 'function') {
            a.showToast(
                t('gallerySearch.appliedToast', 'Added to filters: ') + added.join(', '),
                'info'
            );
        }
        if (typeof a.updateFilterSummary === 'function') a.updateFilterSummary();
        if (typeof a.loadImages === 'function') a.loadImages();
    }

    function syncClearButton(input, clearBtn) {
        if (clearBtn) clearBtn.hidden = !input.value;
    }

    function wireSearch() {
        const input = document.getElementById('gallery-search-input');
        const clearBtn = document.getElementById('gallery-search-clear');
        if (!input) return;

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
                applySearch(input.value);
            }
        });
        input.addEventListener('input', () => {
            syncClearButton(input, clearBtn);
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                searchTimer = null;
                applySearch(input.value);
            }, SEARCH_DEBOUNCE_MS);
        });
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                input.value = '';
                syncClearButton(input, clearBtn);
                applySearch('');
                input.focus();
            });
        }
    }

    // ------------------------------------------------------------------
    // Quick chips — thin toggles over FilterStore fields
    // ------------------------------------------------------------------

    const CHIPS = [
        {
            id: 'chip-has-metadata',
            isActive: (f) => f.hasMetadata === true,
            toggle: (f, on) => { f.hasMetadata = on ? true : null; },
        },
        {
            id: 'chip-aesthetic-7',
            isActive: (f) => Number(f.minAesthetic) >= 7 && f.aestheticUnscored !== true,
            toggle: (f, on) => {
                f.minAesthetic = on ? 7 : null;
                if (on) f.aestheticUnscored = null;
            },
        },
        {
            id: 'chip-no-caption',
            isActive: (f) => f.noCaption === true,
            toggle: (f, on) => { f.noCaption = on ? true : null; },
        },
    ];

    function wireChips() {
        CHIPS.forEach((chip) => {
            const btn = document.getElementById(chip.id);
            if (!btn) return;
            btn.addEventListener('click', () => {
                const a = app();
                if (!a || typeof a.updateFilters !== 'function') return;
                const currentlyActive = btn.getAttribute('aria-pressed') === 'true';
                a.updateFilters((filters) => chip.toggle(filters, !currentlyActive));
                if (typeof a.updateFilterSummary === 'function') a.updateFilterSummary();
                if (typeof a.loadImages === 'function') a.loadImages();
                syncFromFilters(a.AppState ? a.AppState.filters : null);
            });
        });
    }

    function syncFromFilters(filters) {
        if (!filters) return;
        CHIPS.forEach((chip) => {
            const btn = document.getElementById(chip.id);
            if (!btn) return;
            const active = !!chip.isActive(filters);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            btn.classList.toggle('is-active', active);
        });
    }

    // ------------------------------------------------------------------
    // Bottom action bar
    // ------------------------------------------------------------------

    function closeMoreMenu() {
        const toggle = document.getElementById('btn-gallery-action-more');
        const menu = document.getElementById('gallery-action-more-menu');
        if (menu) menu.hidden = true;
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }

    function wireMoreMenu() {
        const toggle = document.getElementById('btn-gallery-action-more');
        const menu = document.getElementById('gallery-action-more-menu');
        if (!toggle || !menu) return;

        const close = closeMoreMenu;

        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            const isOpen = !menu.hidden;
            menu.hidden = isOpen;
            toggle.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
        });
        // Any action click closes the menu (the handlers themselves live in app.js).
        menu.addEventListener('click', () => close());
        document.addEventListener('click', (event) => {
            if (!menu.hidden && !menu.contains(event.target) && event.target !== toggle) close();
        });
        // Capture phase + stopPropagation: with the menu open, ESC closes ONLY
        // the menu — it must not fall through to app.js (which would also exit
        // selection mode) or entry-page.js (which would jump to the entry).
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !menu.hidden) {
                event.stopPropagation();
                event.preventDefault();
                close();
            }
        }, true);
    }

    function formatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)}G`;
        return `${Math.round(n / (1024 * 1024))}M`;
    }

    async function refreshBarStats() {
        const statsEl = document.getElementById('gallery-action-bar-stats');
        if (!statsEl) return;
        const now = Date.now();

        if (now - cacheStats.at > CACHE_STATS_TTL_MS) {
            cacheStats.at = now;
            try {
                const resp = await fetch('/api/thumbnail-cache/stats');
                if (resp.ok) {
                    const data = await resp.json();
                    const bytes = data.total_size_bytes ?? data.stats?.total_size_bytes;
                    if (bytes != null) {
                        cacheStats.text = `${t('actionBar.statsCache', 'Cache')} ${formatBytes(bytes)}`;
                    }
                }
            } catch (e) { /* stats are decorative — never block the bar */ }
        }

        if (!queueStats.unsupported && now - queueStats.at > QUEUE_STATS_TTL_MS) {
            queueStats.at = now;
            try {
                const resp = await fetch('/api/tags/pipeline-queue');
                if (resp.status === 404) {
                    queueStats.unsupported = true;
                } else if (resp.ok) {
                    const data = await resp.json();
                    const depth = Number(data.total_queued || 0);
                    queueStats.text = depth > 0 ? `${t('actionBar.statsQueue', 'Queue')} ${depth}` : '';
                }
            } catch (e) { /* ignore */ }
        }

        renderBarStats();
    }

    function renderBarStats() {
        const statsEl = document.getElementById('gallery-action-bar-stats');
        if (!statsEl) return;
        const parts = [];
        const st = app() && app().AppState;
        const selectedCount = statsEl.dataset.selectedCount || '';
        if (selectedCount) {
            parts.push(`${t('actionBar.statsSelected', 'Selected')} ${selectedCount}`);
        }
        const countEl = document.getElementById('image-count');
        if (countEl && countEl.textContent.trim()) parts.push(countEl.textContent.trim());
        if (cacheStats.text) parts.push(cacheStats.text);
        if (queueStats.text) parts.push(queueStats.text);
        statsEl.textContent = parts.join(' · ');
        void st; // (AppState reserved for future stats)
    }

    function syncActionBar(options) {
        const bar = document.getElementById('gallery-action-bar');
        if (!bar) return;
        const visible = !!(options && options.visible);
        bar.hidden = !visible;
        // Hiding the bar with the More menu open would otherwise leave the
        // menu pre-opened the next time a selection brings the bar back.
        if (!visible) {
            closeMoreMenu();
            return;
        }

        const statsEl = document.getElementById('gallery-action-bar-stats');
        if (statsEl) {
            statsEl.dataset.selectedCount = String(options.selectedCount ?? '');
        }

        const tagBtn = document.getElementById('btn-tag-selected');
        if (tagBtn) {
            const tokenScoped = !!options.tokenScoped;
            tagBtn.disabled = tokenScoped;
            tagBtn.title = tokenScoped
                ? t('actionBar.tagSelectedTokenHint', 'Select-all-matching selections tag via the main AI Tag entry (whole library / untagged).')
                : t('actionBar.tagSelectedTooltip', 'AI-tag the selected images');
        }

        renderBarStats();
        refreshBarStats();
    }

    // ------------------------------------------------------------------
    // Selection-scoped tagging
    // ------------------------------------------------------------------

    function showScopeNote(count) {
        const note = document.getElementById('tag-scope-note');
        const text = document.getElementById('tag-scope-note-text');
        if (!note || !text) return;
        text.textContent = t('tagModal.scopeSelected', 'Tagging only the {count} selected images.')
            .replace('{count}', String(count));
        note.hidden = false;
    }

    function disarmTagSelection() {
        armedTagIds = null;
        const note = document.getElementById('tag-scope-note');
        if (note) note.hidden = true;
    }

    function wireTagSelected() {
        const btn = document.getElementById('btn-tag-selected');
        if (btn) {
            btn.addEventListener('click', () => {
                const a = app();
                const st = a && a.AppState;
                if (!a || !st || st.selectionToken) return;
                const ids = Array.from(st.selectedIds || []);
                if (!ids.length) return;
                armedTagIds = ids;
                showScopeNote(ids.length);
                if (typeof a.showModal === 'function') a.showModal('tag-modal');
                // Aurora Phase 3 (#25b): [打标] lands on the 智能一趟 (Smart Tag)
                // tab with this selection scope, regardless of the last-used tab.
                try { window.V321Integration?.setTaggerTab?.('smart'); } catch (_e) { /* tagger UI not ready */ }
            });
        }
        // The global AI Tag entry always means "whole library" — disarm.
        const globalTagBtn = document.getElementById('btn-tag');
        if (globalTagBtn) globalTagBtn.addEventListener('click', disarmTagSelection);
        const clearBtn = document.getElementById('btn-tag-scope-clear');
        if (clearBtn) clearBtn.addEventListener('click', disarmTagSelection);
    }

    /** Called by app.js startTagging(): returns armed ids (or null). */
    function consumeTagSelectionIds() {
        return Array.isArray(armedTagIds) && armedTagIds.length ? [...armedTagIds] : null;
    }

    // ------------------------------------------------------------------

    function boot() {
        wireSearch();
        wireChips();
        wireMoreMenu();
        wireTagSelected();
        const a = app();
        if (a && a.AppState) syncFromFilters(a.AppState.filters);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.GalleryToolbar = {
        syncActionBar,
        syncFromFilters,
        consumeTagSelectionIds,
        disarmTagSelection,
        parseQuery,
    };
})();
