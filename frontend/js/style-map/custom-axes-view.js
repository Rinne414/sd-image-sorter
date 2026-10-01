/**
 * The "my axes" tab of the axis card (slice S4g): per axis two ends, each with
 * a name field, the example pictures as removable chips and an "add the
 * selected pictures" button; below, Apply and Back to the model's layout and
 * the honest state of the last answer (not separable, missing pictures,
 * parallel axes). Every text is composed from i18n keys at write time and
 * repainted on a language switch; none of these elements carries data-i18n.
 */
import { t } from './text.js';
import { readDefinitions } from './custom-axes.js';

const AXES = ['x', 'y', 'z'];
const THUMBNAIL_SIZE = 64;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export class CustomAxesView {
    /** `custom` is the CustomAxes controller; `host.hasSelection()` tells whether dots are picked. */
    constructor(custom, host) {
        this.custom = custom;
        this.host = host;
        this.root = el('div', 'stylemap-custom');
        this.focusKey = null;
        // Axes without a definition stay folded to one button until asked for (X is open at the start).
        this.expanded = new Set(['x']);
    }

    /** Rebuild the tab (keeps the focus in a name field the user is typing in). */
    render() {
        const active = document.activeElement;
        this.focusKey = active && this.root.contains(active) && active.dataset.key ? active.dataset.key : null;
        const caret = this.focusKey ? active.selectionStart : null;
        const open = AXES.filter((axis) => this.isOpen(axis));
        const folded = AXES.filter((axis) => !this.isOpen(axis));
        const notes = this.notes();
        this.root.replaceChildren(
            ...open.map((axis) => this.axisBlock(axis)),
            ...(folded.length ? [this.foldedRow(folded)] : []),
            ...notes.filter((note) => note.dataset.tone === 'info'),
            this.foot(notes.filter((note) => note.dataset.tone !== 'info')),
        );
        if (this.focusKey) {
            const again = this.root.querySelector(`[data-key="${this.focusKey}"]`);
            if (again) {
                again.focus();
                if (caret !== null && again.setSelectionRange) again.setSelectionRange(caret, caret);
            }
        }
        return this.root;
    }

    /** A defined axis is always open; an empty one opens when the user asks. */
    isOpen(axis) {
        const def = this.custom.defs[axis];
        return def.a.length > 0 || def.b.length > 0 || this.expanded.has(axis);
    }

    foldedRow(axes) {
        const row = el('div', 'stylemap-custom-folded');
        for (const axis of axes) {
            const button = el('button', 'btn btn-secondary btn-small stylemap-custom-open', t('stylemap.customOpenAxis', '+ {axis}', { axis: t(`stylemap.axis.${axis}`, `${axis.toUpperCase()} axis`) }));
            button.type = 'button';
            button.dataset.axis = axis;
            button.addEventListener('click', () => {
                this.expanded.add(axis);
                this.custom.host.onChange();
            });
            row.append(button);
        }
        return row;
    }

    /** The bottom block that stays in view: the state lines, then Apply and Back. */
    foot(lines) {
        const foot = el('div', 'stylemap-custom-foot');
        foot.append(...lines, this.actions());
        return foot;
    }

    axisBlock(axis) {
        const block = el('div', 'stylemap-custom-axis');
        block.dataset.axis = axis;
        const head = el('div', 'stylemap-custom-axis-head');
        head.append(el('span', 'stylemap-axes-axis-name', t(`stylemap.axis.${axis}`, `${axis.toUpperCase()} axis`)));
        const def = this.custom.defs[axis];
        if (def.a.length || def.b.length) {
            const clear = el('button', 'btn btn-ghost btn-small stylemap-custom-clear', t('stylemap.customClearAxis', 'Clear'));
            clear.type = 'button';
            clear.addEventListener('click', () => this.custom.clearAxis(axis));
            head.append(clear);
        }
        const ends = el('div', 'stylemap-axes-ends');
        ends.append(this.endBlock(axis, 'a'), this.endBlock(axis, 'b'));
        block.append(head, ends);
        return block;
    }

    endBlock(axis, end) {
        const def = this.custom.defs[axis];
        const ids = def[end];
        const block = el('div', 'stylemap-custom-end');
        block.dataset.end = end;
        const input = el('input', 'input-field stylemap-custom-name');
        input.type = 'text';
        input.maxLength = 40;
        input.value = end === 'a' ? def.nameA : def.nameB;
        input.placeholder = end === 'a'
            ? t('stylemap.customNamePlaceholder', 'e.g. thick paint')
            : t('stylemap.customNamePlaceholderB', 'e.g. flat color');
        input.dataset.key = `${axis}-${end}`;
        input.setAttribute('aria-label', `${t(`stylemap.axis.${axis}`, axis)} · ${end === 'a' ? t('stylemap.customEndA', 'End A') : t('stylemap.customEndB', 'End B')}`);
        input.addEventListener('input', () => this.custom.setName(axis, end, input.value));
        const chips = el('div', 'stylemap-custom-chips');
        for (const id of ids) chips.append(this.chip(axis, end, id));
        const add = el('button', 'btn btn-secondary btn-small stylemap-custom-add', t('stylemap.customAdd', 'Add selected pictures'));
        add.type = 'button';
        const canAdd = this.host.hasSelection();
        add.disabled = !canAdd;
        add.title = canAdd ? '' : t('stylemap.customAddNone', 'Pick some dots on the map first (drag a box or click dots)');
        add.addEventListener('click', () => this.custom.addSelection(axis, end));
        block.append(input, chips, add);
        return block;
    }

    chip(axis, end, id) {
        const chip = el('span', 'stylemap-custom-chip');
        const img = el('img');
        img.alt = '';
        img.decoding = 'async';
        img.src = `/api/image-thumbnail/${id}?size=${THUMBNAIL_SIZE}`;
        const remove = el('button', 'stylemap-custom-chip-x', '×');
        remove.type = 'button';
        remove.title = t('stylemap.customRemove', 'Remove');
        remove.setAttribute('aria-label', t('stylemap.customRemove', 'Remove'));
        remove.addEventListener('click', () => this.custom.remove(axis, end, id));
        chip.append(img, remove);
        return chip;
    }

    actions() {
        const row = el('div', 'stylemap-custom-actions');
        const working = this.custom.status === 'working';
        const apply = el('button', 'btn btn-primary btn-small stylemap-custom-apply', t('stylemap.customApply', 'Apply'));
        apply.type = 'button';
        apply.disabled = working;
        apply.addEventListener('click', () => this.custom.apply());
        const revert = el('button', 'btn btn-secondary btn-small stylemap-custom-revert', t('stylemap.customRevert', 'Back to the model layout'));
        revert.type = 'button';
        revert.disabled = !this.custom.applied;
        revert.addEventListener('click', () => this.custom.revert());
        row.append(apply, revert);
        return row;
    }

    /** The state lines: working, error, and what the last answer says about the examples. */
    notes() {
        const { status, error, result, applied } = this.custom;
        const lines = [];
        const add = (text, tone) => {
            const note = el('p', 'stylemap-custom-note', text);
            note.dataset.tone = tone;
            lines.push(note);
        };
        if (status === 'working') add(t('stylemap.customWorking', 'Placing the pictures...'), 'busy');
        if (status === 'error' && error) add(error, 'error');
        const { problems } = readDefinitions(this.custom.defs);
        if (problems.length && status !== 'error') add(t('stylemap.customNeedTwo', 'Each end needs at least 2 pictures'), 'warn');
        if (applied && result?.status === 'ok') {
            add(t('stylemap.customApplied', 'Applied: the map is laid out along your axes'), 'ok');
            for (const axis of AXES) {
                const info = result.axes?.[axis];
                if (!info) continue;
                const label = t(`stylemap.axis.${axis}`, axis);
                if (!info.applied) add(`${label}: ${t('stylemap.customTooFew', 'not applied, fewer than 2 usable pictures at an end')}`, 'warn');
                else if (!info.separable) {
                    add(`${label}: ${t('stylemap.customNotSeparable', 'These two groups are hard to tell apart ({agree}/{total}); the model may not see this difference. Add more pictures, or use more typical ones.', { agree: info.agree, total: info.total })}`, 'warn');
                }
                if (info.missing_ids?.length) {
                    add(`${label}: ${t('stylemap.customMissing', '{n} pictures could not be used (not in this library, or no style data yet)', { n: info.missing_ids.length })}`, 'warn');
                }
            }
            for (const warning of result.warnings || []) {
                add(t('stylemap.customParallel', '{a} and {b} point almost the same way, so they will look alike.', {
                    a: t(`stylemap.axis.${warning.axes[0]}`, warning.axes[0]),
                    b: t(`stylemap.axis.${warning.axes[1]}`, warning.axes[1]),
                }), 'warn');
            }
            add(t('stylemap.customHidden', 'While your axes are on, the region landmarks and the model’s axis meanings are hidden: they describe the original layout.'), 'info');
        }
        return lines;
    }
}
