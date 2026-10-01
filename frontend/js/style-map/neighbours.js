/**
 * "Drop a picture, find the nearest" card of the Style Map side column (S4c).
 *
 * The picture is posted to POST /api/style-map/query (multipart, nothing is
 * stored); the answer is drawn twice: rings on the map (the query point,
 * near and far neighbours: rings.js) and a list here with thumbnail, name
 * and similarity. Clicking a row turns the camera to that point and shows
 * its picture in the preview. Every text is composed from i18n keys at write
 * time and repainted on a language switch; none of these elements carries
 * data-i18n, so the ui-refresh re-apply cannot reset them.
 */
import { t } from './text.js';

const THUMBNAIL_SIZE = 256;
const SLOW_MODEL_MS = 1500; // past this the first-use model load is the likely reason
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // the server's own ceiling
const SCORE_DECIMALS = 2;
const COLD_SECONDS = 15;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** The server's answer as one sentence for the status line. */
async function failureOf(response) {
    const body = await response.json().catch(() => ({}));
    const detail = String(body?.detail || body?.error || '');
    if (response.status === 413) return ['stylemap.nearErrTooLarge', 'The picture is too large (50 MB at most)', {}];
    if (response.status === 409) {
        return ['stylemap.nearErrBusy', 'Another AI task is running; try again in a moment', {}];
    }
    if (response.status === 400 && /image/i.test(detail)) {
        return ['stylemap.nearErrNotImage', 'This file is not a picture the program can read', {}];
    }
    return ['stylemap.nearErr', 'The lookup failed: {error}', { error: detail || `HTTP ${response.status}` }];
}

export class NeighbourCard {
    /**
     * `host.getRequest()` gives {space, query} for the map on screen (null
     * while there is none), `host.refreshMap()` asks for the points again
     * (a server that lost the map), `host.preview(id)` shows a picture in
     * the preview pane. `scene` draws the rings and turns the camera.
     */
    constructor(root, host, scene) {
        this.host = host;
        this.scene = scene;
        const $ = (id) => root.querySelector(`#${id}`);
        this.el = {
            card: $('stylemap-near'),
            clear: $('stylemap-near-clear'),
            drop: $('stylemap-drop'),
            dropMain: $('stylemap-drop-main'),
            dropSub: $('stylemap-drop-sub'),
            file: $('stylemap-near-file'),
            status: $('stylemap-near-status'),
            list: $('stylemap-near-list'),
            note: $('stylemap-near-note'),
        };
        this.file = null;
        this.previewUrl = null;
        this.result = null;
        this.resultSig = null;
        this.runSig = null; // the map signature of the lookup in flight
        this.refreshing = false;
        this.focusQuery = false;
        this.status = null; // {key, fallback, params, tone}
        this.available = false;
        this.activeId = null;
        this.seq = 0;
        this.abort = null;
        this.slowTimer = null;
        this.bind();
        this.render();
    }

    bind() {
        const { drop, file, clear, card } = this.el;
        if (!drop) return;
        const choose = () => {
            if (!this.available) return;
            file.value = '';
            file.click();
        };
        drop.addEventListener('click', choose);
        drop.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                choose();
            }
        });
        file.addEventListener('change', () => {
            const picked = file.files?.[0];
            if (picked) this.lookup(picked);
        });
        for (const name of ['dragenter', 'dragover']) {
            card.addEventListener(name, (event) => {
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = this.available ? 'copy' : 'none';
                drop.classList.toggle('is-active', this.available);
            });
        }
        card.addEventListener('dragleave', (event) => {
            if (!card.contains(event.relatedTarget)) drop.classList.remove('is-active');
        });
        card.addEventListener('drop', (event) => {
            event.preventDefault();
            drop.classList.remove('is-active');
            const dropped = event.dataTransfer?.files?.[0];
            if (dropped && this.available) this.lookup(dropped);
        });
        clear?.addEventListener('click', () => this.clear());
    }

    /** The map on screen can answer lookups (points arrived and are not empty). */
    setAvailable(flag) {
        this.available = Boolean(flag);
        if (!this.available) {
            this.abortRun();
            this.result = null;
            this.resultSig = null;
            this.scene?.setRings([]);
        }
        this.render();
    }

    /**
     * A new map is on screen (space, filter, or PCA -> UMAP): the rings of
     * the old coordinates are gone, so the picture dropped last is looked up
     * again; with none, nothing to do.
     */
    mapChanged(signature) {
        if (this.available && this.result && signature === this.resultSig) {
            this.drawRings(); // a new points answer cleared the rings of the same map
            return;
        }
        if (!this.available || !this.file) return;
        if (signature === this.resultSig || signature === this.runSig || this.refreshing) return;
        this.run(false);
    }

    clear() {
        this.abortRun();
        this.file = null;
        this.result = null;
        this.resultSig = null;
        this.activeId = null;
        this.status = null;
        this.revokePreview();
        this.scene?.setRings([]);
        this.render();
    }

    revokePreview() {
        if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
        this.previewUrl = null;
    }

    abortRun() {
        this.seq += 1;
        this.abort?.abort();
        this.abort = null;
        clearTimeout(this.slowTimer);
        this.slowTimer = null;
    }

    lookup(file) {
        if (file.type && !file.type.startsWith('image/')) {
            this.fail('stylemap.nearErrNotImage', 'This file is not a picture the program can read', {});
            return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            this.fail('stylemap.nearErrTooLarge', 'The picture is too large (50 MB at most)', {});
            return;
        }
        this.file = file;
        this.revokePreview();
        this.previewUrl = URL.createObjectURL(file);
        this.activeId = null;
        this.focusQuery = true; // a fresh drop turns the camera to the query point
        this.run(false);
    }

    fail(key, fallback, params) {
        this.focusQuery = false;
        this.result = null;
        this.resultSig = null;
        this.scene?.setRings([]);
        this.status = { key, fallback, params, tone: 'error' };
        this.render();
    }

    /** One upload; a map the server lost (not_started) is rebuilt once and asked again. */
    async run(retried) {
        const request = this.host.getRequest();
        if (!request || !this.file) return;
        this.abortRun();
        const seq = this.seq;
        this.runSig = request.signature;
        const controller = new AbortController();
        this.abort = controller;
        this.status = { key: 'stylemap.nearWorking', fallback: 'Finding the nearest pictures...', params: {}, tone: 'busy' };
        this.result = null;
        this.scene?.setRings([]);
        this.render();
        if (request.space === 'kaloscope') {
            this.slowTimer = setTimeout(() => {
                if (seq !== this.seq) return;
                this.status = {
                    key: 'stylemap.nearLoadingModel',
                    fallback: 'Loading the Style Finder model; the first time takes about {seconds} seconds...',
                    params: { seconds: COLD_SECONDS },
                    tone: 'busy',
                };
                this.renderStatus();
            }, SLOW_MODEL_MS);
        }
        try {
            const body = new FormData();
            body.append('file', this.file, this.file.name || 'upload');
            const response = await fetch(`/api/style-map/query?${request.query}`, {
                method: 'POST',
                body,
                signal: controller.signal,
            });
            if (seq !== this.seq) return;
            if (!response.ok) {
                const [key, fallback, params] = await failureOf(response);
                if (seq === this.seq) this.fail(key, fallback, params);
                return;
            }
            const answer = await response.json();
            if (seq !== this.seq) return;
            if (answer?.status === 'not_started') {
                if (retried) throw new Error('not_started');
                clearTimeout(this.slowTimer);
                this.refreshing = true;
                try {
                    await this.host.refreshMap();
                } finally {
                    this.refreshing = false;
                }
                if (seq === this.seq) await this.run(true);
                return;
            }
            this.accept(answer, request);
        } catch (error) {
            if (seq !== this.seq || error?.name === 'AbortError') return;
            this.fail('stylemap.nearErr', 'The lookup failed: {error}', { error: String(error?.message || error) });
        } finally {
            if (seq === this.seq) {
                clearTimeout(this.slowTimer);
                this.slowTimer = null;
                this.runSig = null;
            }
        }
    }

    accept(answer, request) {
        this.result = answer;
        this.resultSig = request.signature;
        this.status = null;
        this.drawRings();
        if (this.focusQuery && answer.query) {
            this.activeId = 'query';
            this.scene?.flyTo([answer.query.x, answer.query.y, answer.query.z]);
        }
        this.focusQuery = false;
        this.render();
        this.markActive();
    }

    drawRings() {
        const answer = this.result;
        const rings = [];
        if (answer?.query) rings.push({ kind: 'query', ...answer.query });
        for (const n of answer?.neighbors || []) {
            if (n.in_filter) rings.push({ kind: n.weak ? 'far' : 'near', x: n.x, y: n.y, z: n.z });
        }
        this.scene?.setRings(rings);
    }

    /** Turn the camera to a row's point and show its picture. */
    pick(id, position) {
        this.activeId = id;
        if (position) this.scene?.flyTo(position);
        if (id !== null) this.host.preview(id);
        this.markActive();
    }

    markActive() {
        for (const row of this.el.list.querySelectorAll('.stylemap-near-row')) {
            const active = String(this.activeId) === row.dataset.id;
            row.classList.toggle('is-active', active);
            if (active) row.setAttribute('aria-current', 'true');
            else row.removeAttribute('aria-current');
        }
    }

    // --------------------------------------------------------------- paint
    render() {
        const { drop, dropMain, dropSub, clear, card } = this.el;
        if (!card) return;
        dropMain.textContent = t('stylemap.nearDrop', 'Drop a picture here');
        dropSub.textContent = this.available
            ? t('stylemap.nearDropSub', 'or click to choose · uses the model of this map')
            : t('stylemap.nearDropOff', 'Needs a map first: build the style index, or pick a space that has data');
        // Once a picture was dropped the zone shrinks to its title: the list needs the room.
        dropSub.hidden = Boolean(this.file) && this.available;
        drop.classList.toggle('is-compact', dropSub.hidden);
        drop.setAttribute('aria-disabled', this.available ? 'false' : 'true');
        drop.tabIndex = this.available ? 0 : -1;
        clear.hidden = !this.file;
        this.renderStatus();
        this.renderList();
    }

    renderStatus() {
        const { status } = this.el;
        const s = this.status;
        status.hidden = !s;
        if (!s) return;
        status.textContent = t(s.key, s.fallback, s.params);
        status.dataset.tone = s.tone;
    }

    renderList() {
        const { list, note } = this.el;
        list.replaceChildren();
        const answer = this.result;
        if (!answer) {
            // Nothing to list yet: say what will appear (a status line replaces it).
            note.hidden = Boolean(this.status);
            note.textContent = t('stylemap.nearEmpty', 'The nearest pictures are listed here and ringed on the map.');
            return;
        }
        note.hidden = false;
        list.append(this.queryRow(answer));
        const neighbours = answer.neighbors || [];
        for (const n of neighbours) list.append(this.neighbourRow(n));
        if (!neighbours.length) {
            note.textContent = t('stylemap.nearNothing', 'The library has no style data to compare with yet.');
            return;
        }
        const placed = Boolean(answer.query);
        const threshold = Number(answer.weak_threshold).toFixed(SCORE_DECIMALS);
        note.textContent = placed
            ? t('stylemap.nearNote', 'Your picture is placed next to its three closest matches, so the spot is an estimate. Scores are cosine similarity; grey ones below {threshold} are not really close.', { threshold })
            : t('stylemap.nearNoPlace', 'None of the closest pictures is in the current filter, so your picture is not marked on the map.');
        this.markActive();
    }

    queryRow(answer) {
        const row = el('li', 'stylemap-near-item');
        const button = el('button', 'stylemap-near-row is-query');
        button.type = 'button';
        button.dataset.id = 'query';
        const thumb = el('img', 'stylemap-near-thumb');
        thumb.alt = '';
        if (this.previewUrl) thumb.src = this.previewUrl;
        const text = el('span', 'stylemap-near-text');
        text.append(
            el('span', 'stylemap-near-name', this.file?.name || t('stylemap.nearQuery', 'Your picture')),
            el('span', 'stylemap-near-flag', t('stylemap.nearQuery', 'Your picture')),
        );
        button.append(thumb, text);
        const position = answer.query ? [answer.query.x, answer.query.y, answer.query.z] : null;
        button.addEventListener('click', () => {
            this.activeId = 'query';
            if (position) this.scene?.flyTo(position);
            this.markActive();
        });
        row.append(button);
        return row;
    }

    neighbourRow(n) {
        const item = el('li', 'stylemap-near-item');
        const button = el('button', 'stylemap-near-row');
        button.type = 'button';
        button.dataset.id = String(n.id);
        button.dataset.weak = n.weak ? 'true' : 'false';
        button.dataset.inFilter = n.in_filter ? 'true' : 'false';
        const thumb = el('img', 'stylemap-near-thumb');
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.src = `/api/image-thumbnail/${n.id}?size=${THUMBNAIL_SIZE}`;
        const name = n.filename || `#${n.id}`;
        const text = el('span', 'stylemap-near-text');
        const nameNode = el('span', 'stylemap-near-name', name);
        nameNode.title = name;
        text.append(nameNode);
        const flags = [];
        if (n.weak) flags.push(t('stylemap.nearFar', 'far away'));
        if (!n.in_filter) flags.push(t('stylemap.nearOutside', 'not in the current filter'));
        if (flags.length) text.append(el('span', 'stylemap-near-flag', flags.join(' · ')));
        const score = el('span', 'stylemap-near-score', Number(n.score).toFixed(SCORE_DECIMALS));
        button.append(thumb, text, score);
        const position = n.in_filter ? [n.x, n.y, n.z] : null;
        button.addEventListener('click', () => this.pick(n.id, position));
        item.append(button);
        return item;
    }
}
