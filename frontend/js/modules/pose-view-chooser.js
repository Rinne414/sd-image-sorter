/**
 * Find by pose or camera angle.
 *
 * Nothing searches drawn pictures by pose well, but the tagger already says
 * it in words (from_above, cowboy_shot, sitting, arms_up). The chooser lists
 * the pose and camera-angle tags this library really has, most used first
 * with their counts; pressing one filters the Gallery by it, and several can
 * be pressed together. It says what it cannot know: pictures that were never
 * tagged, and it is as right as the tagger was.
 *
 * GET /api/tags/pose-view supplies the list (services/pose_view_tags.py).
 */
(function initPoseViewChooser(global) {
    'use strict';

    const MODAL_ID = 'pose-view-modal';
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const app = () => global.App || null;
    const norm = (tag) => String(tag || '').trim().toLowerCase().replace(/ /g, '_');

    let listed = null; // { view, pose, untagged }
    let modal = null;

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    function chosenTags() {
        const active = new Set((app()?.AppState?.filters?.tags || []).map(norm));
        const known = [...(listed?.view || []), ...(listed?.pose || [])];
        return known.filter((row) => active.has(norm(row.tag))).map((row) => row.tag);
    }

    function toggle(tag) {
        const api = app();
        if (!api?.updateFilters) return;
        api.updateFilters((filters) => {
            const tags = Array.isArray(filters.tags) ? filters.tags : [];
            const has = tags.some((value) => norm(value) === norm(tag));
            filters.tags = has ? tags.filter((value) => norm(value) !== norm(tag)) : [...tags, tag];
            filters.cursor = null;
            filters.offset = 0;
        });
        global.renderActiveTagFilters?.();
        api.updateFilterSummary?.();
        api.loadImages?.();
        draw();
        syncChip();
    }

    function clearChosen() {
        const api = app();
        const chosen = new Set(chosenTags().map(norm));
        if (!chosen.size || !api?.updateFilters) return;
        api.updateFilters((filters) => {
            filters.tags = (filters.tags || []).filter((value) => !chosen.has(norm(value)));
            filters.cursor = null;
            filters.offset = 0;
        });
        global.renderActiveTagFilters?.();
        api.updateFilterSummary?.();
        api.loadImages?.();
        draw();
        syncChip();
    }

    function group(title, rows, active) {
        const section = el('section', 'pose-view-group');
        section.appendChild(el('h4', 'pose-view-group-title', title));
        const list = el('div', 'pose-view-tags');
        rows.forEach((row) => {
            const pressed = active.has(norm(row.tag));
            const button = el('button', 'pose-view-tag');
            button.type = 'button';
            button.dataset.tag = row.tag;
            button.setAttribute('aria-pressed', String(pressed));
            // The Chinese name leads when the table has one; the tag itself is always shown.
            if (row.name) button.appendChild(el('span', 'pose-view-tag-name', row.name));
            button.appendChild(el('span', 'pose-view-tag-id', row.tag));
            button.appendChild(el('span', 'pose-view-tag-count', Number(row.count).toLocaleString()));
            button.addEventListener('click', () => toggle(row.tag));
            list.appendChild(button);
        });
        section.appendChild(list);
        return section;
    }

    function openTagging() {
        app()?.hideModal?.(MODAL_ID);
        document.getElementById('btn-tag')?.click();
    }

    function draw() {
        if (!modal) return;
        const body = modal.querySelector('.pose-view-body');
        const status = modal.querySelector('.pose-view-status');
        const note = modal.querySelector('.pose-view-note');
        const clear = modal.querySelector('#pose-view-clear');
        body.textContent = '';
        if (!listed) {
            body.appendChild(el('p', 'pose-view-empty', tr('poseView.loading', 'Reading the tags...')));
            return;
        }
        const active = new Set(chosenTags().map(norm));
        if (!listed.view.length && !listed.pose.length) {
            body.appendChild(el('p', 'pose-view-empty', tr('poseView.none', 'This library has no pose or camera-angle tags yet. Tag the pictures with AI first: the tagger writes them.')));
        } else {
            if (listed.view.length) body.appendChild(group(tr('poseView.view', 'Camera angle and framing'), listed.view, active));
            if (listed.pose.length) body.appendChild(group(tr('poseView.pose', 'Pose'), listed.pose, active));
        }
        const state = app()?.AppState || {};
        const total = Number(state.pagination?.total ?? state.images?.length ?? 0);
        status.textContent = active.size
            ? tr('poseView.chosen', '{n} chosen, {total} pictures match', { n: active.size, total: total.toLocaleString() })
            : tr('poseView.chooseHint', 'Press a tag to see its pictures. Several can be pressed together.');
        clear.hidden = active.size === 0;
        note.hidden = !(listed.untagged > 0);
        if (!note.hidden) {
            note.firstChild.textContent = `${tr('poseView.untagged', '{n} pictures have no tags yet, so they cannot be found here.', { n: Number(listed.untagged).toLocaleString() })} `;
        }
    }

    function build() {
        modal = el('div', 'modal');
        modal.id = MODAL_ID;
        modal.innerHTML = `
            <div class="modal-backdrop"></div>
            <div class="modal-content pose-view-content" role="dialog" aria-modal="true" aria-labelledby="pose-view-title">
                <button type="button" class="modal-close" id="pose-view-close">${global.UiIcon?.html?.('i-close') || ''}</button>
                <h3 id="pose-view-title"></h3>
                <p class="pose-view-intro"></p>
                <div class="pose-view-body"></div>
                <p class="pose-view-note" hidden><span></span><button type="button" class="pose-view-link" id="pose-view-tag-now"></button></p>
                <div class="modal-actions pose-view-actions">
                    <span class="pose-view-status" aria-live="polite"></span>
                    <button type="button" class="btn btn-ghost" id="pose-view-clear" hidden></button>
                    <button type="button" class="btn btn-primary" id="pose-view-done"></button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.querySelector('#pose-view-title').textContent = tr('poseView.title', 'Find by pose or camera angle');
        modal.querySelector('.pose-view-intro').textContent = tr('poseView.intro', 'These are the tags the AI tagger wrote on your pictures. The result is as right as the tagger was.');
        const close = modal.querySelector('#pose-view-close');
        close.setAttribute('aria-label', tr('common.close', 'Close'));
        modal.querySelector('#pose-view-tag-now').textContent = tr('poseView.tagNow', 'Tag them now');
        modal.querySelector('#pose-view-clear').textContent = tr('poseView.clear', 'Clear these');
        modal.querySelector('#pose-view-done').textContent = tr('poseView.done', 'Show the pictures');
        const hide = () => app()?.hideModal?.(MODAL_ID);
        close.addEventListener('click', hide);
        modal.querySelector('.modal-backdrop').addEventListener('click', hide);
        modal.querySelector('#pose-view-done').addEventListener('click', hide);
        modal.querySelector('#pose-view-clear').addEventListener('click', clearChosen);
        modal.querySelector('#pose-view-tag-now').addEventListener('click', openTagging);
    }

    async function open() {
        if (!modal) build();
        listed = null;
        draw();
        app()?.showModal?.(MODAL_ID);
        try {
            listed = await app().API.get('/api/tags/pose-view');
        } catch (error) {
            listed = { view: [], pose: [], untagged: 0 };
            app()?.showToast?.(error?.message || String(error), 'error');
        }
        draw();
        syncChip();
    }

    /** The sidebar button is lit while a pose or angle tag it listed is among the filters. */
    function syncChip() {
        const chip = document.getElementById('btn-pose-view');
        if (chip) chip.setAttribute('aria-pressed', String(Boolean(listed) && chosenTags().length > 0));
    }

    function wire() {
        document.getElementById('btn-pose-view')?.addEventListener('click', open);
        // The count in the dialog follows the Gallery as it loads.
        global.addEventListener('gallery-images-loaded', () => {
            if (modal?.classList.contains('visible')) draw();
            syncChip();
        });
        global.addEventListener('gallery-filters-changed', syncChip);
    }

    global.PoseViewChooser = Object.freeze({ open });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
