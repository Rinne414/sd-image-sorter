/**
 * Style Map picks -> the app's own selection. A box on the map picks dots
 * (representatives); a dot can stand for several near-identical pictures, so
 * the dots are expanded into every picture they stand for (POST
 * /api/style-map/members, skipped when no picked dot is merged) before the
 * ids are written to the shared selection store (App.updateSelectionState).
 * The floating action bar then hands the ids to the existing tools by calling
 * their one implementation on the App context: add to a collection, send to
 * Censor, send to Dataset Maker, show in the Gallery. Nothing here
 * re-implements an action (design rule 11).
 */
import { t, formatError } from './text.js';

const MEMBERS_ENDPOINT = '/api/style-map/members';

function app() {
    return window.App || null;
}

export class MapSelection {
    /**
     * @param view     #view-stylemap
     * @param options  {getScene, getMap: () => ({space, mapId} | null)}
     */
    constructor(view, { getScene, getMap } = {}) {
        this.getScene = getScene;
        this.getMap = getMap;
        const $ = (id) => view.querySelector(`#${id}`);
        this.el = {
            bar: $('stylemap-selbar'),
            count: $('stylemap-selbar-count'),
            collection: $('stylemap-sel-collection'),
            censor: $('stylemap-sel-censor'),
            dataset: $('stylemap-sel-dataset'),
            gallery: $('stylemap-sel-gallery'),
            clear: $('stylemap-sel-clear'),
        };
        this.repIds = new Set(); // picked dots, by picture id (survives a layout change)
        this.ids = []; // every picture the picked dots stand for
        this.priorMode = null; // the Gallery's selection mode before the first pick
        this.seq = 0;
        this.bind();
        document.addEventListener('selection-state-changed', () => this.syncFromApp());
        document.addEventListener('keydown', (event) => this.onKeydown(event));
    }

    bind() {
        const { el } = this;
        el.collection?.addEventListener('click', () => app()?.addSelectionToCollectionPicker?.());
        el.censor?.addEventListener('click', () => this.sendToCensor());
        el.dataset?.addEventListener('click', () => app()?.addToDatasetMaker?.([...this.ids]));
        el.gallery?.addEventListener('click', () => this.openInGallery());
        el.clear?.addEventListener('click', () => this.clear());
    }

    /** The Gallery shows only these pictures (js/gallery-pin.js), all of them selected. */
    async openInGallery() {
        try {
            await window.GalleryPin.open([...this.ids]);
        } catch (error) {
            app()?.showToast?.(formatError(error), 'error');
        }
    }

    /**
     * Censor reads a selection token in chunks, so a big pick is handed over as
     * a token (its pictures stored as a pinned set) instead of one huge id list.
     */
    async sendToCensor() {
        try {
            const source = await window.GalleryPin.tokenFor([...this.ids]);
            app()?.addToCensorQueue?.(source || [...this.ids]);
        } catch (error) {
            app()?.showToast?.(formatError(error), 'error');
        }
    }

    get active() {
        return this.repIds.size > 0;
    }

    /** Esc clears a finished pick (a drag in progress is the box selector's). */
    onKeydown(event) {
        if (event.key !== 'Escape' || !this.active || this.el.bar?.hidden) return;
        if (document.querySelector('.stylemap-lasso:not([hidden])')) return;
        const target = event.target;
        const tag = (target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (!document.getElementById('view-stylemap')?.classList.contains('active')) return;
        event.preventDefault();
        this.clear();
    }

    /** Flags of the dots currently picked, in point order. */
    flags() {
        const scene = this.getScene();
        const flags = new Uint8Array(scene.count);
        for (let i = 0; i < scene.count; i += 1) {
            if (this.repIds.has(scene.ids[i])) flags[i] = 1;
        }
        return flags;
    }

    pickBox(indices) {
        const scene = this.getScene();
        this.commit(new Set(indices.map((index) => scene.ids[index])));
    }

    toggle(index) {
        const scene = this.getScene();
        const picked = new Set(this.repIds);
        const id = scene.ids[index];
        if (picked.has(id)) picked.delete(id);
        else picked.add(id);
        this.commit(picked);
    }

    /** A new map was drawn: keep the picked dots that are still on it. */
    mapChanged() {
        if (!this.active) return;
        const scene = this.getScene();
        const present = new Set();
        const onMap = new Set(scene.ids);
        for (const id of this.repIds) if (onMap.has(id)) present.add(id);
        if (present.size === this.repIds.size) {
            scene.setSelected(this.flags());
            return;
        }
        this.commit(present);
    }

    /** Make `repIds` the pick: highlight, expand to every picture, write the store. */
    async commit(repIds) {
        const scene = this.getScene();
        const seq = ++this.seq;
        this.repIds = repIds;
        if (repIds.size === 0) {
            this.clear();
            return;
        }
        const flags = this.flags();
        scene.setSelected(flags);
        let ids;
        try {
            ids = await this.expand(flags);
        } catch (error) {
            if (seq !== this.seq) return;
            app()?.showToast?.(formatError(error), 'error');
            this.clear();
            return;
        }
        if (seq !== this.seq) return;
        if (ids === null) {
            app()?.showToast?.(t('stylemap.selStale', 'The map changed meanwhile. Select again.'), 'info');
            this.clear();
            return;
        }
        this.ids = ids;
        this.writeStore(ids);
        this.render();
    }

    /** Every picture behind the flagged dots; null when the server lost this map. */
    async expand(flags) {
        const scene = this.getScene();
        const reps = [];
        let total = 0;
        for (let i = 0; i < scene.count; i += 1) {
            if (!flags[i]) continue;
            reps.push(scene.ids[i]);
            total += scene.members[i];
        }
        // Nothing merged behind the picked dots: the dots are the pictures.
        if (total === reps.length) return reps;
        const map = this.getMap();
        const body = { space: map?.space, map_id: map?.mapId, rep_ids: reps };
        const answer = await app().API.post(MEMBERS_ENDPOINT, body);
        return answer?.status === 'ok' ? answer.ids : null;
    }

    writeStore(ids) {
        const api = app();
        if (!api) return;
        if (this.priorMode === null) this.priorMode = Boolean(api.AppState?.selectionMode);
        api.updateSelectionState((selection) => ({
            ...selection,
            selectionMode: true,
            scope: 'visible',
            filterKey: null,
            selectionToken: null,
            selectionTotal: 0,
            selectedIds: new Set(ids),
        }));
        api.updateSelectionUI?.();
        api.emitSelectionStateChanged?.();
    }

    clear() {
        this.seq += 1;
        const hadStore = this.priorMode !== null;
        const prior = this.priorMode;
        this.reset();
        const api = app();
        if (!api || !hadStore) return;
        if (prior) {
            api.clearSelectedIds?.({ scope: 'visible' });
            api.updateSelectionUI?.();
            api.emitSelectionStateChanged?.();
        } else {
            api.setSelectionMode?.(false);
        }
    }

    /** Forget the local pick and hide the bar (the store is untouched). */
    reset() {
        this.repIds = new Set();
        this.ids = [];
        this.priorMode = null;
        this.getScene()?.setSelected(null);
        this.render();
    }

    /** The Gallery (or Esc there) emptied the shared selection: drop the local pick too. */
    syncFromApp() {
        if (!this.active) return;
        const count = app()?.getSelectedGalleryCount?.();
        if (count === 0) {
            this.seq += 1;
            this.reset();
        }
    }

    render() {
        const { bar, count } = this.el;
        if (!bar) return;
        bar.hidden = !this.active || this.ids.length === 0;
        if (count) count.textContent = t('stylemap.selCount', '{n} selected', { n: this.ids.length.toLocaleString() });
    }

    repaintText() {
        this.render();
    }
}
