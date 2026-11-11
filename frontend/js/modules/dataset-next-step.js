/**
 * Dataset Maker: one line that says what is left and where to do it.
 *
 * The page has three tabs and, inside the Workbench, four more steps. This
 * line sits under the header on every tab and answers the question the tabs
 * do not: "what is still missing before I can export?"
 *
 *   no pictures        -> add pictures            (Import)
 *   some uncaptioned   -> N of M have no caption  (Workbench)
 *   export not set up  -> the export's own reason (Export)
 *   all done           -> ready to export         (Export)
 *
 * Its button leads to the tab where that is done and is left out when that
 * tab is already open; the line itself is left out while there is nothing to
 * add to what the open tab already says (no pictures, on Import).
 *
 * Reads the page's own state (window.DatasetMaker); changes nothing.
 */
(function initDatasetNextStep(global) {
    'use strict';

    const TYPING_DELAY_MS = 250;
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    let timer = null;

    /** What is left, from the page's own state. */
    function assess(maker) {
        const ids = Array.from(maker.imageIds || []);
        const logical = typeof maker._getLogicalDatasetCount === 'function' ? maker._getLogicalDatasetCount() : ids.length;
        if (logical <= 0) {
            return { tab: 'import', text: tr('datasetNext.none', 'No pictures in this dataset yet.'), go: tr('datasetNext.goImport', 'Add pictures') };
        }
        // A caption is tags, a sentence, or both: a dataset captioned in sentences only is captioned.
        const captioned = (id) => Boolean(
            String(maker._booruTextFor?.(id) || '').trim() || String(maker._nlTextFor?.(id) || '').trim()
        );
        const without = ids.filter((id) => !captioned(id)).length;
        if (without > 0) {
            return {
                tab: 'workbench',
                text: tr('datasetNext.captions', 'No caption yet: {n} of {total} pictures.', { n: without, total: ids.length }),
                go: tr('datasetNext.goWorkbench', 'Caption them'),
            };
        }
        const reason = String(maker._exportDisabledReason?.() || '').trim();
        if (reason) {
            return {
                tab: 'export',
                text: tr('datasetNext.exportBlocked', 'Every picture has a caption. Before exporting: {reason}', { reason }),
                go: tr('datasetNext.goExport', 'Open Export'),
            };
        }
        return {
            tab: 'export',
            text: tr('datasetNext.ready', 'Every picture has a caption and the export is set up: {total} pictures are ready.', { total: logical }),
            go: tr('datasetNext.goExport', 'Open Export'),
        };
    }

    function render() {
        const line = document.getElementById('dataset-next');
        const maker = global.DatasetMaker;
        const page = document.querySelector('.dataset-maker');
        if (!line || !maker || !page) return;
        // Nothing to say while another page is open; the next look at this one draws it.
        if (!document.getElementById('view-dataset')?.classList.contains('active')) return;
        const step = assess(maker);
        const openTab = page.getAttribute('data-active-tab') || 'import';
        const elsewhere = step.tab !== openTab;
        // On Import with no pictures the tab itself already says "add pictures".
        line.hidden = step.tab === 'import' && !elsewhere;
        document.getElementById('dataset-next-text').textContent = step.text;
        const button = document.getElementById('btn-dataset-next');
        button.hidden = !elsewhere;
        button.textContent = step.go;
        button.dataset.tab = step.tab;
    }

    let frame = 0;

    /** Draw on the next frame: a change of pictures or tab must not move the page later on. */
    function refreshSoon() {
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            render();
        });
    }

    /** Typing a caption changes the count at most once per pause. */
    function refreshAfterTyping() {
        clearTimeout(timer);
        timer = setTimeout(render, TYPING_DELAY_MS);
    }

    function wire() {
        const page = document.querySelector('.dataset-maker');
        if (!page || !document.getElementById('dataset-next')) return;
        document.getElementById('btn-dataset-next').addEventListener('click', (event) => {
            global.DatasetMaker?._setPipelineTab?.(event.currentTarget.dataset.tab || 'import');
            refreshSoon();
        });
        // The dataset changed, a caption was typed, tagging ended, another tab or language was chosen.
        global.addEventListener('dataset:changed', refreshSoon);
        ['taggingCompleted', 'vlmBatchCompleted', 'languageChanged'].forEach((name) => document.addEventListener(name, refreshSoon));
        page.addEventListener('input', refreshAfterTyping);
        page.addEventListener('change', refreshSoon);
        page.addEventListener('click', refreshSoon);
        new MutationObserver(refreshSoon).observe(page, { attributes: true, attributeFilter: ['data-active-tab'] });
        // Coming back to this page from another one.
        const view = document.getElementById('view-dataset');
        if (view) new MutationObserver(refreshSoon).observe(view, { attributes: true, attributeFilter: ['class'] });
        // The count in the header is rewritten on every membership change, including the ones that send no event.
        const count = document.getElementById('dataset-count-num');
        if (count) new MutationObserver(refreshSoon).observe(count, { childList: true, characterData: true, subtree: true });
        refreshSoon();
        // The page's own scripts load after this one: draw as soon as they are there.
        const waiting = setInterval(() => {
            if (!global.DatasetMaker) return;
            clearInterval(waiting);
            render();
        }, 100);
    }

    global.DatasetNextStep = Object.freeze({ render, assess });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
