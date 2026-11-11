/**
 * The viewer's "Changed from the picture before" section.
 *
 * While iterating, the question is what was changed between two tries. The
 * section lists only the differences from the picture made just before this
 * one (the nearest earlier picture that has generation data): prompt words
 * added and removed, settings that differ, LoRAs added, removed or
 * re-weighted. The seed is told in one quiet line, since it differs on almost
 * every try. Nothing to compare with: the section is not shown at all.
 *
 * GET /api/images/{id}/changes does the comparing (services/generation_diff.py).
 */
(function initModalChanges(global) {
    'use strict';

    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const KEY_LABELS = {
        model: ['changes.key.model', 'Model'],
        steps: ['changes.key.steps', 'Steps'],
        sampler: ['changes.key.sampler', 'Sampler'],
        scheduler: ['changes.key.scheduler', 'Scheduler'],
        cfg: ['changes.key.cfg', 'CFG'],
        denoise: ['changes.key.denoise', 'Denoise'],
        clip_skip: ['changes.key.clipSkip', 'Clip skip'],
        size: ['changes.key.size', 'Size'],
    };
    let turn = 0;

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const shown = (value) => (value === null || value === undefined || value === '' ? tr('changes.none', 'none') : String(value));

    function wordRow(label, change) {
        if (!change.added.length && !change.removed.length) return null;
        const row = el('div', 'modal-change-row');
        row.appendChild(el('span', 'modal-change-label', label));
        const words = el('span', 'modal-change-words');
        change.added.forEach((word) => words.appendChild(el('span', 'modal-change-word is-added', `+ ${word}`)));
        change.removed.forEach((word) => words.appendChild(el('span', 'modal-change-word is-removed', `- ${word}`)));
        row.appendChild(words);
        return row;
    }

    function valueRow(label, before, after) {
        const row = el('div', 'modal-change-row');
        row.appendChild(el('span', 'modal-change-label', label));
        const value = el('span', 'modal-change-value');
        value.append(el('span', 'modal-change-before', shown(before)), el('span', 'modal-change-arrow', tr('changes.to', 'to')), el('span', 'modal-change-after', shown(after)));
        row.appendChild(value);
        return row;
    }

    function loraRows(loras) {
        const rows = [];
        const weight = (entry) => (entry.weight === null || entry.weight === undefined ? entry.name : `${entry.name} (${entry.weight})`);
        if (loras.added.length || loras.removed.length) {
            rows.push(wordRow('LoRA', { added: loras.added.map(weight), removed: loras.removed.map(weight) }));
        }
        loras.reweighted.forEach((entry) => rows.push(valueRow(`LoRA ${entry.name}`, entry.before, entry.after)));
        return rows;
    }

    function draw(body, data) {
        body.textContent = '';
        const head = el('p', 'modal-change-head');
        head.append(`${tr('changes.comparedWith', 'Compared with')} `);
        const link = el('button', 'modal-change-link', data.before.filename || `#${data.before.id}`);
        link.type = 'button';
        link.title = tr('changes.openBefore', 'Open that picture');
        link.addEventListener('click', () => global.Gallery?.openPreview?.(data.before.id));
        head.appendChild(link);
        body.appendChild(head);

        if (data.same) {
            body.appendChild(el('p', 'modal-change-same', data.seed.same
                ? tr('changes.identical', 'Same prompt, settings and seed.')
                : tr('changes.sameButSeed', 'Same prompt and settings; only the seed differs.')));
            return;
        }
        const rows = [
            wordRow(tr('modal.prompt', 'Prompt'), data.prompt),
            wordRow(tr('modal.negativePrompt', 'Negative Prompt'), data.negative_prompt),
            ...data.settings.map((item) => valueRow(tr(...(KEY_LABELS[item.key] || ['', item.key])), item.before, item.after)),
            ...loraRows(data.loras),
        ].filter(Boolean);
        rows.forEach((row) => body.appendChild(row));
        body.appendChild(el('p', 'modal-change-seed', data.seed.same
            ? tr('changes.seedSame', 'The seed is the same.')
            : tr('changes.seedDiffers', 'The seed differs too.')));
    }

    function clear() {
        turn += 1;
        const section = document.getElementById('modal-changes-section');
        if (section) section.hidden = true;
    }

    /** Fill the section for the picture now in the viewer. */
    async function show(image) {
        const section = document.getElementById('modal-changes-section');
        const body = document.getElementById('modal-changes-body');
        if (!section || !body || !image?.id) return;
        const mine = ++turn;
        section.hidden = true;
        // A picture with no prompt has nothing to compare.
        if (!String(image.prompt || '').trim()) return;
        let data = null;
        try {
            data = await global.App.API.get(`/api/images/${image.id}/changes`);
        } catch (_error) {
            return; // the section simply stays away; the rest of the viewer is unaffected
        }
        // The user moved to another picture while this one was being compared.
        if (mine !== turn || !data?.before || !data.comparable) return;
        draw(body, data);
        section.hidden = false;
        // The viewer hides a section whose body was empty when it drew; this one has just been filled.
        section.style.display = '';
        global.Gallery?._applyModalSectionStates?.();
    }

    global.ModalChanges = Object.freeze({ show, clear });
})(window);
