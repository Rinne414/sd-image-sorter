/**
 * "From an Eagle library…": bring an Eagle library in without copying it.
 *
 * A small dialog, opened from the Import dialog: choose the library folder,
 * look at what it holds (items, tags, stars, notes, folders, and what will be
 * passed over), then bring it in. The pictures are indexed where Eagle keeps
 * them; stars, notes, tags, folders (as collections) and source pages come
 * with them, and nothing a picture already has here is overwritten.
 *
 * POST /api/eagle/preview, POST /api/eagle/import, GET /api/eagle/import
 * (backend/routers/eagle.py).
 */
(function initEagleImport(global) {
    'use strict';

    const MODAL_ID = 'eagle-import-modal';
    const POLL_MS = 600;
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const app = () => global.App || null;
    const byId = (id) => document.getElementById(id);
    let looked = '';
    let polling = null;

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    function say(text, tone) {
        const status = byId('eagle-import-status');
        status.textContent = text || '';
        status.dataset.tone = tone || 'info';
    }

    function rows(target, pairs) {
        const list = el('dl', 'eagle-import-facts');
        pairs.filter(([, value]) => value !== null).forEach(([label, value]) => {
            list.append(el('dt', null, label), el('dd', null, String(value)));
        });
        target.replaceChildren(list);
        target.hidden = false;
    }

    function showFound(found) {
        rows(byId('eagle-import-summary'), [
            [tr('eagle.foundItems', 'Pictures and videos'), found.items],
            [tr('eagle.foundTags', 'With tags'), `${found.with_tags} (${tr('eagle.distinctTags', '{n} different tags', { n: found.distinct_tags })})`],
            [tr('eagle.foundStars', 'With stars'), found.with_stars],
            [tr('eagle.foundNotes', 'With notes'), found.with_notes],
            [tr('eagle.foundFolders', 'In folders'), `${found.in_folders} (${tr('eagle.folderCount', '{n} folders', { n: found.folders })})`],
            [tr('eagle.foundSource', 'With a source page'), found.with_source],
            [tr('eagle.skippedDeleted', 'Passed over: in the Eagle trash'), found.skipped_deleted || null],
            [tr('eagle.skippedNoFile', 'Passed over: bookmarks and items without a file'), found.skipped_no_file || null],
            [tr('eagle.skippedUnreadable', 'Passed over: item folders that cannot be read'), found.skipped_unreadable || null],
        ]);
    }

    function showResult(result) {
        rows(byId('eagle-import-result'), [
            [tr('eagle.doneIndexed', 'Now in the Gallery'), result.indexed],
            [tr('eagle.doneNotIndexed', 'Not a type this program shows'), result.not_indexed || null],
            [tr('eagle.doneStars', 'Stars brought over'), result.stars_set],
            [tr('eagle.doneNotes', 'Notes brought over'), result.notes_set],
            [tr('eagle.doneTags', 'Tags added'), result.tags_added],
            [tr('eagle.doneCollections', 'Collections made from folders'), result.collections_created],
            [tr('eagle.doneMemberships', 'Pictures put into collections'), result.collection_memberships],
            [tr('eagle.doneSources', 'Source pages recorded'), result.sources_set],
        ]);
    }

    function setBusy(busy) {
        ['btn-eagle-preview', 'btn-eagle-browse', 'eagle-import-path'].forEach((id) => { byId(id).disabled = busy; });
        byId('btn-eagle-run').disabled = busy || !looked;
    }

    async function look() {
        const path = byId('eagle-import-path').value.trim();
        if (!path) {
            say(tr('eagle.needFolder', 'Choose the Eagle library folder first (its name ends in .library).'), 'error');
            return;
        }
        looked = '';
        byId('eagle-import-result').hidden = true;
        setBusy(true);
        say(tr('eagle.looking', 'Reading the library...'));
        try {
            const found = await app().API.post('/api/eagle/preview', { path });
            looked = path;
            showFound(found);
            say(found.items
                ? tr('eagle.ready', 'The pictures stay where Eagle keeps them. Nothing is copied, and nothing in the Eagle folder is changed.')
                : tr('eagle.nothing', 'This library has no picture or video to bring in.'), found.items ? 'info' : 'error');
            if (!found.items) looked = '';
        } catch (error) {
            byId('eagle-import-summary').hidden = true;
            say(error?.message || String(error), 'error');
        } finally {
            setBusy(false);
        }
    }

    function describe(state) {
        if (state.step === 'details') return tr('eagle.stepDetails', 'Bringing stars, notes, tags and folders over: {current} of {total}', state);
        return tr('eagle.stepIndex', 'Adding the pictures to the Gallery: {current} of {total}', state);
    }

    async function follow() {
        clearTimeout(polling);
        let state;
        try {
            state = await app().API.get('/api/eagle/import');
        } catch (error) {
            say(error?.message || String(error), 'error');
            setBusy(false);
            return;
        }
        if (state.status === 'running') {
            say(describe({ step: state.step, current: state.current || 0, total: state.total || 0 }));
            polling = setTimeout(follow, POLL_MS);
            return;
        }
        setBusy(false);
        if (state.status === 'error') {
            say(tr('eagle.failed', 'The import stopped: {reason}', { reason: state.error || '' }), 'error');
            return;
        }
        if (state.status === 'done' && state.result) {
            showResult(state.result);
            say(tr('eagle.done', 'Done. The Eagle folder was not changed.'), 'success');
            const api = app();
            api.resetSelectionDataCache?.();
            api.loadImages?.(false, { keepPosition: true });
            api.loadStats?.();
            global.FolderTreeUI?.refresh?.();
            global.CollectionsUI?.refresh?.();
        }
    }

    async function run() {
        if (!looked) return;
        setBusy(true);
        byId('eagle-import-result').hidden = true;
        try {
            await app().API.post('/api/eagle/import', { path: looked });
        } catch (error) {
            say(error?.message || String(error), 'error');
            setBusy(false);
            return;
        }
        follow();
    }

    function open() {
        const api = app();
        if (!api || !byId(MODAL_ID)) return;
        api.hideModal?.('scan-modal');
        api.showModal?.(MODAL_ID);
        setBusy(false);
        // An import started earlier (or in another tab) is picked up where it is.
        follow();
    }

    function wire() {
        if (!byId(MODAL_ID)) return;
        byId('btn-scan-from-eagle')?.addEventListener('click', open);
        byId('eagle-import-close').addEventListener('click', () => app()?.hideModal?.(MODAL_ID));
        byId(MODAL_ID).querySelector('.modal-backdrop').addEventListener('click', () => app()?.hideModal?.(MODAL_ID));
        byId('btn-eagle-browse').addEventListener('click', () => global.showFolderBrowser?.(byId('eagle-import-path')));
        byId('btn-eagle-preview').addEventListener('click', look);
        byId('btn-eagle-run').addEventListener('click', run);
        byId('eagle-import-path').addEventListener('input', () => {
            // Another folder: what was looked at no longer stands.
            if (byId('eagle-import-path').value.trim() !== looked) {
                looked = '';
                byId('btn-eagle-run').disabled = true;
            }
        });
        byId('eagle-import-path').addEventListener('keydown', (event) => {
            if (event.key === 'Enter') look();
        });
    }

    global.EagleImport = Object.freeze({ open });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
