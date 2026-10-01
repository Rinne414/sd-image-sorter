/**
 * The "what the axes mean" card of the Style Map (S4e): a floating card on the
 * canvas with, for each of the three axes, the pictures at its low and high
 * end and the tags that set the two ends apart (GET /api/style-map/axes).
 * Clicking a picture previews it and turns the camera to its dot, like a row
 * of the nearest-picture list. Every text is composed from i18n keys at write
 * time and repainted on a language switch; none of these elements carries
 * data-i18n, so the ui-refresh re-apply cannot reset them.
 *
 * The card is an overlay that owns Esc while it is open: the entry page's
 * Esc-to-home skips a keypress when OVERLAY_SELECTOR (entry-page.js) matches
 * it, and it must leave the DOM with the page (close() on dispose).
 */
import { t } from './text.js';

const THUMBNAIL_SIZE = 128; // cached size closest to the 52 px tile (2x for HiDPI)
const AXES = ['x', 'y', 'z'];
const ENDS = ['low', 'high'];

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export class AxesPanel {
    /**
     * `host.pick(id)` previews a picture and turns the camera to it,
     * `host.retry()` asks again after a failure, `host.tagText(item)` names a
     * tag, `host.onClose()` is told when the card closes itself (Esc, the
     * close button).
     */
    constructor(card, host) {
        this.host = host;
        this.card = card;
        this.activeId = null;
        this.open = false;
        this.root = el('section', 'stylemap-axes-panel');
        this.root.id = 'stylemap-axes-panel';
        this.root.hidden = true;
        this.root.setAttribute('aria-labelledby', 'stylemap-axes-title');
        this.title = el('h4', 'stylemap-axes-title');
        this.title.id = 'stylemap-axes-title';
        this.close = el('button', 'btn btn-ghost btn-small stylemap-axes-close', '×');
        this.close.type = 'button';
        this.close.addEventListener('click', () => this.setOpen(false, true));
        const head = el('div', 'stylemap-axes-head');
        head.append(this.title, this.close);
        this.note = el('p', 'stylemap-axes-note');
        this.body = el('div', 'stylemap-axes-body');
        this.root.append(head, this.note, this.body);
        card.append(this.root);
        this.onKeydown = (event) => this.handleKey(event);
        this.view = { status: 'idle', data: null, layout: 'pca' };
    }

    /** Esc closes the card; a box drag in progress and form fields keep their own Esc. */
    handleKey(event) {
        if (event.key !== 'Escape' || !this.open) return;
        if (document.querySelector('.stylemap-lasso:not([hidden])')) return;
        const tag = (event.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        event.preventDefault();
        this.setOpen(false, true);
    }

    setOpen(flag, notify = false) {
        const on = Boolean(flag);
        if (on === this.open) return;
        this.open = on;
        this.root.hidden = !on;
        if (on) document.addEventListener('keydown', this.onKeydown);
        else document.removeEventListener('keydown', this.onKeydown);
        if (on) this.paint();
        if (notify) this.host.onClose();
    }

    /** `view` = {status: idle | loading | ok | error, data, layout}. */
    render(view) {
        this.view = view;
        if (this.open) this.paint();
    }

    paint() {
        const { status, data, layout } = this.view;
        this.title.textContent = t('stylemap.axesTitle', 'What the axes mean');
        const closeLabel = t('stylemap.axesClose', 'Close');
        this.close.title = closeLabel;
        this.close.setAttribute('aria-label', closeLabel);
        this.note.textContent = layout === 'umap'
            ? t('stylemap.axesUmapNote', 'UMAP: directions are not fixed, only distances mean something')
            : t('stylemap.axesNote', 'Pictures at the two ends of each axis, and the tags that set the ends apart');
        this.note.classList.toggle('is-umap', layout === 'umap');
        if (status === 'ok' && data?.axes) {
            this.body.replaceChildren(...AXES.map((axis) => this.axisBlock(axis, data.axes[axis])));
            this.markActive();
            return;
        }
        this.body.replaceChildren(this.stateLine(status));
    }

    stateLine(status) {
        const line = el('div', 'stylemap-axes-state');
        if (status === 'error') {
            line.append(el('span', '', t('stylemap.axesError', 'The axis meanings could not be loaded')));
            const retry = el('button', 'btn btn-ghost btn-small', t('stylemap.axesRetry', 'Retry'));
            retry.type = 'button';
            retry.addEventListener('click', () => this.host.retry());
            line.append(retry);
        } else if (status === 'loading') {
            line.textContent = t('stylemap.axesLoading', 'Reading the axes...');
        } else {
            line.textContent = t('stylemap.axesIdle', 'Needs a map first');
        }
        return line;
    }

    axisBlock(axis, entry) {
        const block = el('div', 'stylemap-axes-axis');
        block.dataset.axis = axis;
        block.classList.toggle('is-weak', Boolean(entry?.weak));
        block.append(el('div', 'stylemap-axes-axis-name', t(`stylemap.axis.${axis}`, `${axis.toUpperCase()} axis`)));
        const ends = el('div', 'stylemap-axes-ends');
        for (const end of ENDS) ends.append(this.endBlock(end, entry?.[end]));
        block.append(ends);
        if (entry?.weak) {
            block.append(el('div', 'stylemap-axes-weak', t('stylemap.axesWeak', 'No clear shared trait in this direction')));
        }
        return block;
    }

    endBlock(end, data) {
        const block = el('div', 'stylemap-axes-end');
        block.dataset.end = end;
        block.append(el('div', 'stylemap-axes-end-name', end === 'low' ? t('stylemap.axesLow', 'Low end') : t('stylemap.axesHigh', 'High end')));
        const thumbs = el('div', 'stylemap-axes-thumbs');
        for (const id of data?.representatives || []) thumbs.append(this.thumb(id));
        block.append(thumbs);
        const tags = (data?.tags || []).map((item) => this.host.tagText(item));
        if (tags.length) block.append(el('div', 'stylemap-axes-tags', tags.join(' · ')));
        return block;
    }

    thumb(id) {
        const button = el('button', 'stylemap-axes-thumb');
        button.type = 'button';
        button.dataset.id = String(id);
        button.title = t('stylemap.axesPickTip', 'Preview this picture and fly to its dot');
        const img = el('img');
        img.alt = '';
        img.decoding = 'async';
        img.src = `/api/image-thumbnail/${id}?size=${THUMBNAIL_SIZE}`;
        button.append(img);
        button.addEventListener('click', () => {
            this.activeId = id;
            this.host.pick(id);
            this.markActive();
        });
        return button;
    }

    markActive() {
        for (const button of this.body.querySelectorAll('.stylemap-axes-thumb')) {
            const active = String(this.activeId) === button.dataset.id;
            button.classList.toggle('is-active', active);
            if (active) button.setAttribute('aria-current', 'true');
            else button.removeAttribute('aria-current');
        }
    }

    dispose() {
        this.setOpen(false);
        this.root.remove();
    }
}
