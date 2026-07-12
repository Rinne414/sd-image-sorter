/**
 * Dataset Maker — custom dark dropdown wrapper for native selects in the dataset panes (own IIFE; shared outside-interaction listeners).
 * Moved VERBATIM from dataset-maker-pipeline.js L1505-1682.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */

/* ============== Custom dark dropdown for native selects ============== */
//
// Each native <select> in the dataset panes gets a styled button +
// floating list. The previous implementation leaked listeners: every
// wrapped select added its own ``document.addEventListener('click')``,
// ``window.addEventListener('resize')``, and
// ``window.addEventListener('scroll', …, true)``, none of which were
// ever removed. ``initCustomDropdowns`` runs on every view activation,
// so re-opening the Dataset tab stacked more listeners each time.
//
// The fix below:
//   * Registers the three outside-interaction listeners ONCE (module
//     scope), not per-select.
//   * Tracks every open list in a single registry the shared handlers
//     consult, so adding/removing a dropdown no longer grows the
//     listener count.
//   * Removes the body-appended list node when the underlying select is
//     taken out of the DOM (MutationObserver on view-dataset), so a
//     dataset teardown doesn't leave orphan list nodes in <body>.
(function () {
    'use strict';

    const OPEN_LISTS = new Set();        // currently-visible list nodes
    const LIST_BY_SELECT = new Map();    // select -> { list, display, wrapper, observer }
    let SHARED_LISTENERS_INSTALLED = false;

    function closeAllLists(except) {
        for (const list of Array.from(OPEN_LISTS)) {
            if (list === except) continue;
            list.hidden = true;
            OPEN_LISTS.delete(list);
        }
    }

    function ensureSharedListeners() {
        if (SHARED_LISTENERS_INSTALLED) return;
        SHARED_LISTENERS_INSTALLED = true;
        // One outside-click closer for every dropdown.
        document.addEventListener('click', (e) => {
            for (const list of Array.from(OPEN_LISTS)) {
                const display = list.dataset.displayId
                    ? document.getElementById(list.dataset.displayId)
                    : null;
                if (display && (e.target === display || display.contains(e.target))) continue;
                if (e.target === list || list.contains(e.target)) continue;
                list.hidden = true;
                OPEN_LISTS.delete(list);
            }
        });
        // One resize closer (position is stale after resize).
        window.addEventListener('resize', () => closeAllLists());
        // Scroll closer that preserves the original contract: scrolling
        // INSIDE an open list must NOT close it (the user is scrolling
        // the option list), but scrolling anywhere else closes every
        // open list because the anchored position is stale.
        window.addEventListener('scroll', (e) => {
            const target = e.target;
            for (const list of Array.from(OPEN_LISTS)) {
                if (target instanceof Node && (target === list || list.contains(target))) {
                    continue;   // scrolling inside this list — keep it open
                }
                list.hidden = true;
                OPEN_LISTS.delete(list);
            }
        }, true);
    }

    function wrapSelect(sel) {
        if (sel.dataset.customDropdown) return;
        sel.dataset.customDropdown = '1';
        ensureSharedListeners();
        sel.style.display = 'none';

        const wrapper = document.createElement('div');
        wrapper.className = 'dataset-custom-dropdown';
        wrapper.dataset.selectId = sel.id;

        const display = document.createElement('button');
        display.type = 'button';
        display.className = 'dataset-custom-dropdown-display';
        display.textContent = sel.options[sel.selectedIndex]?.textContent || '';

        const list = document.createElement('div');
        list.className = 'dataset-custom-dropdown-list';
        list.hidden = true;
        // The shared outside-click handler needs to recognize this list's
        // anchor without a per-select closure, so stamp ids it can read.
        list.dataset.displayId = '';
        document.body.appendChild(list);

        function positionList() {
            const rect = display.getBoundingClientRect();
            window.PopupPosition?.place(list, {
                anchor: display,
                placement: 'bottom-start',
                gap: 4,
                width: Math.max(160, rect.width),
                maxHeight: Math.min(220, Math.max(120, window.innerHeight - 24)),
            });
        }

        function buildOptions() {
            list.innerHTML = '';
            for (const opt of sel.options) {
                const item = document.createElement('div');
                item.className = 'dataset-custom-dropdown-option';
                if (opt.selected) item.classList.add('selected');
                item.textContent = opt.textContent;
                item.dataset.value = opt.value;
                item.addEventListener('click', () => {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    display.textContent = opt.textContent;
                    list.hidden = true;
                    OPEN_LISTS.delete(list);
                    for (const o of list.children) o.classList.remove('selected');
                    item.classList.add('selected');
                });
                list.appendChild(item);
            }
        }
        buildOptions();

        // Give the list a stable id so the shared outside-click handler
        // can resolve its anchor button.
        const displayId = `dataset-dd-display-${Math.random().toString(36).slice(2, 10)}`;
        display.id = displayId;
        list.dataset.displayId = displayId;

        display.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = list.hidden;
            closeAllLists();
            if (willOpen) {
                list.hidden = false;
                OPEN_LISTS.add(list);
                positionList();
            }
        });

        sel.addEventListener('change', () => {
            display.textContent = sel.options[sel.selectedIndex]?.textContent || '';
            buildOptions();
        });

        wrapper.append(display);
        sel.parentNode.insertBefore(wrapper, sel.nextSibling);

        // Tear the body-appended list down when the underlying select
        // leaves the DOM (e.g. the dataset view is rebuilt). Without
        // this, orphan list nodes accumulated in <body> across view
        // activations.
        const observer = new MutationObserver(() => {
            if (!document.body.contains(sel)) {
                list.remove();
                OPEN_LISTS.delete(list);
                LIST_BY_SELECT.delete(sel);
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        LIST_BY_SELECT.set(sel, { list, display, wrapper, observer });
    }

    function initCustomDropdowns() {
        const container = document.getElementById('view-dataset');
        if (!container) return;
        const selects = container.querySelectorAll('.dataset-export-pane select, .dataset-card select');
        for (const sel of selects) wrapSelect(sel);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCustomDropdowns, { once: true });
    } else {
        initCustomDropdowns();
    }
})();
