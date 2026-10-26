/**
 * Subject-count fixes in the Dataset Maker health check.
 *
 * The backend finding `subject-count-conflict` (services/subject_count_rules.py)
 * carries one proposal per picture: the count tags it keeps and the ones it
 * loses (`1girl` beside `2girls`, `solo` beside two or more people). This turns
 * the proposals into a preview with a tick per picture and one button that
 * takes the ticked tags out of the tag boxes as a single change, with one
 * button to put every one of them back.
 *
 * Only the tag box (booru captions) is edited. A tag that is not in the tag box
 * of a picture (it came from natural-language text) is left alone and counted
 * as not changed, so the result never claims more than it did.
 */
(function () {
    'use strict';

    // Rows drawn before "Show all" (a display choice: every row can be ticked and applied).
    const SHOWN_ROWS = 30;
    const UNDO_DEPTH = 20;

    function tr(key, fallback, params) {
        if (typeof window.appT === 'function') return window.appT(key, fallback, params);
        return window.I18n.format(fallback, params);
    }

    // Same folding as the backend (services/subject_count_rules.py): lower case,
    // spaces instead of underscores.
    function fold(tag) {
        return String(tag || '').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
    }

    /** The caption without the given tags (spelling-insensitive); the other tags keep their spacing. */
    function removeTags(caption, drop) {
        const gone = new Set((drop || []).map(fold).filter(Boolean));
        const original = String(caption || '');
        if (gone.size === 0) return original;
        const parts = original.split(',');
        const kept = parts.filter((part) => !gone.has(fold(part)));
        if (kept.length === parts.length) return original;
        return kept.join(',').replace(/^\s+/, '');
    }

    /** Valid proposals of a finding, one per picture, as `{image_id, keep, drop}`. */
    function proposalsOf(finding) {
        const raw = Array.isArray(finding?.fix?.proposals) ? finding.fix.proposals : [];
        const seen = new Set();
        const out = [];
        for (const item of raw) {
            const id = item?.image_id;
            if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
            if (!Array.isArray(item.drop) || item.drop.length === 0) continue;
            seen.add(id);
            out.push({
                image_id: id,
                keep: Array.isArray(item.keep) ? item.keep.map(String) : [],
                drop: item.drop.map(String),
            });
        }
        return out;
    }

    function pushUndo(dm, id, previous) {
        const stack = dm._undoStacks.get(id) || [];
        stack.push(previous);
        if (stack.length > UNDO_DEPTH) stack.shift();
        dm._undoStacks.set(id, stack);
    }

    function refreshAfter(dm, ids) {
        dm._renderQueue?.();
        if (dm.activeId != null && ids.includes(Number(dm.activeId))) dm._setActive(dm.activeId);
        dm._markReadinessStale?.();
    }

    /** Takes each fix's tags out of its caption. Returns what was changed so it can be put back. */
    function applyFixes(dm, fixes) {
        dm._flushPendingDatasetEdits?.();
        const record = [];
        for (const fix of fixes) {
            const id = fix.image_id;
            if (!dm.imageIds.includes(id)) continue;
            const before = dm._booruTextFor(id);
            const after = removeTags(before, fix.drop);
            if (after === before) continue;
            record.push({ id, before, after, hadEdit: dm.captionEdits.has(id) });
            pushUndo(dm, id, before);
            dm.captionEdits.set(id, after);
        }
        refreshAfter(dm, record.map((r) => r.id));
        return record;
    }

    /** Puts back every caption the fix changed that has not been edited since. Returns how many. */
    function undoFixes(dm, record) {
        dm._flushPendingDatasetEdits?.();
        const restored = [];
        for (const r of record) {
            if (!dm.imageIds.includes(r.id) || dm._booruTextFor(r.id) !== r.after) continue;
            if (!r.hadEdit && dm.captions.get(r.id) === r.before) dm.captionEdits.delete(r.id);
            else dm.captionEdits.set(r.id, r.before);
            const stack = dm._undoStacks.get(r.id);
            if (stack && stack[stack.length - 1] === r.before) stack.pop();
            restored.push(r.id);
        }
        refreshAfter(dm, restored);
        return restored.length;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function tagChip(tag, kind, title) {
        const chip = el('span', `dchk-tag dchk-tag-${kind}`, tag);
        chip.title = title;
        return chip;
    }

    function buildRow(dm, fix, off, onTick) {
        const row = el('li', 'dchk-row dchk-subject-row');
        row.dataset.testid = 'check-subject-row';
        row.dataset.imageId = String(fix.image_id);
        const name = dm.meta?.get?.(fix.image_id)?.filename || `#${fix.image_id}`;

        const tick = document.createElement('input');
        tick.type = 'checkbox';
        tick.checked = !off.has(fix.image_id);
        tick.setAttribute('aria-label', name);
        tick.dataset.testid = 'check-subject-tick';
        tick.addEventListener('change', () => {
            if (tick.checked) off.delete(fix.image_id);
            else off.add(fix.image_id);
            onTick();
        });

        const pic = el('button', 'dchk-pic');
        pic.type = 'button';
        pic.title = tr('dataset.healthLocate', 'Locate this image in the Dataset Maker queue');
        const src = dm._thumbSrc?.(fix.image_id, 96) || '';
        if (src) {
            const img = document.createElement('img');
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = src;
            pic.appendChild(img);
        }
        pic.addEventListener('click', () => dm._setActive?.(fix.image_id));

        const tags = el('span', 'dchk-subject-tags');
        for (const tag of fix.keep) {
            tags.appendChild(tagChip(tag, 'keep', tr('dataset.subjectFixKeeps', 'Stays in the caption')));
        }
        for (const tag of fix.drop) {
            tags.appendChild(tagChip(tag, 'drop', tr('dataset.subjectFixDrops', 'Taken out of the caption')));
        }
        const main = el('div', 'dchk-subject-main');
        main.append(el('span', 'dchk-name mono', name), tags);
        row.append(tick, pic, main);
        return row;
    }

    function button(className, testid, hidden = false) {
        const node = el('button', className);
        node.type = 'button';
        node.dataset.testid = testid;
        node.hidden = hidden;
        return node;
    }

    /**
     * The preview for one `subject-count-conflict` finding, or null when it carries no usable proposal.
     * @param {object} finding the finding as `/api/tags/consistency/report` returns it
     * @param {object} dm the Dataset Maker
     */
    function build(finding, dm) {
        const fixes = proposalsOf(finding);
        if (!dm || fixes.length === 0) return null;

        const box = el('div', 'dchk-subject');
        box.dataset.testid = 'check-subject-fixes';
        const list = el('ul', 'dchk-list');
        const status = el('p', 'dchk-note');
        status.hidden = true;
        status.setAttribute('aria-live', 'polite');
        const apply = button('btn btn-secondary btn-small', 'check-subject-apply');
        const toggle = button('btn btn-ghost btn-small', 'check-subject-toggle');
        const undo = button('btn btn-ghost btn-small', 'check-subject-undo', true);
        const showAll = button('btn btn-ghost btn-small', 'check-subject-show-all', fixes.length <= SHOWN_ROWS);
        showAll.textContent = tr('dataset.subjectFixShowAll', 'Show all {count} pictures', { count: fixes.length });

        const off = new Set(); // unticked pictures, drawn or not
        const ticked = () => fixes.filter((fix) => !off.has(fix.image_id));
        const sync = () => {
            const n = ticked().length;
            apply.textContent = tr('dataset.subjectFixApply', 'Apply to the {count} ticked', { count: n });
            apply.disabled = n === 0;
            toggle.textContent = off.size === 0
                ? tr('dataset.subjectFixUntickAll', 'Untick all')
                : tr('dataset.subjectFixTickAll', 'Tick all');
        };
        const draw = (limit) => {
            list.textContent = '';
            for (const fix of fixes.slice(0, limit)) list.appendChild(buildRow(dm, fix, off, sync));
        };
        draw(SHOWN_ROWS);

        showAll.addEventListener('click', () => {
            draw(fixes.length);
            showAll.hidden = true;
        });
        toggle.addEventListener('click', () => {
            const untick = off.size === 0;
            off.clear();
            if (untick) for (const fix of fixes) off.add(fix.image_id);
            for (const tick of list.querySelectorAll('input[type="checkbox"]')) tick.checked = !untick;
            sync();
        });

        let record = [];
        apply.addEventListener('click', () => {
            const chosen = ticked();
            record = applyFixes(dm, chosen);
            status.textContent = record.length < chosen.length
                ? tr('dataset.subjectFixSome', 'Changed {count} of {total} captions. The other pictures do not have these tags in their tag box (they come from natural-language text), so change them there.', { count: record.length, total: chosen.length })
                : tr('dataset.subjectFixDone', 'Changed {count} captions.', { count: record.length });
            status.hidden = false;
            apply.hidden = true;
            toggle.hidden = true;
            undo.hidden = record.length === 0;
            undo.textContent = tr('dataset.subjectFixUndo', 'Undo ({count})', { count: record.length });
            if (record.length) {
                window.App?.showToast?.(tr('dataset.subjectFixDone', 'Changed {count} captions.', { count: record.length }), 'success');
            }
        });
        undo.addEventListener('click', () => {
            const total = record.length;
            const restored = undoFixes(dm, record);
            status.textContent = restored < total
                ? tr('dataset.subjectFixUndoSome', 'Put back {count} of {total} captions. The others were edited after the fix and are left as they are.', { count: restored, total })
                : tr('dataset.subjectFixUndone', 'Put back {count} captions.', { count: restored });
            undo.hidden = true;
            record = [];
            apply.hidden = false;
            toggle.hidden = false;
            sync();
        });

        const actions = el('div', 'dchk-actions');
        actions.append(apply, toggle, undo, showAll);
        // Actions first: with a long list the buttons must not sit at the end of a scroll box.
        box.append(actions, status, list);
        sync();
        return box;
    }

    window.SubjectFixes = Object.freeze({ build, proposalsOf, removeTags, applyFixes, undoFixes });
})();
