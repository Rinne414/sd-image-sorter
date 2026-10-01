/**
 * Custom axes of the Style Map (slice S4g): the user decides what an axis
 * means. Each of x/y/z takes two groups of example pictures (end A, end B) and
 * an optional name per end; POST /api/style-map/custom-axes lays the map out
 * along "more like B than A". This module owns the definitions (stored per
 * library, as picture ids, so a space switch recomputes from the same
 * examples), the request and its answer; the card (custom-axes-view.js) edits
 * them and the controller (state.js) draws the answer through `host.show`.
 *
 * While the axes are applied the map is laid out along them and everything
 * that describes the ORIGINAL layout (region landmarks, the model's axis
 * meanings) is hidden with a note, never shown stale. A `not_started` answer
 * rebuilds the map once per user action (armRetries), never in a loop.
 */
import { t, formatError } from './text.js';

const AXES = ['x', 'y', 'z'];
const MIN_EXAMPLES = 2;
const STORAGE_PREFIX = 'sd-stylemap-custom-axes:';

export function emptyDefinitions() {
    return Object.fromEntries(AXES.map((axis) => [axis, { a: [], b: [], nameA: '', nameB: '' }]));
}

/** Only the ids and names survive a reload; anything else in storage is dropped. */
export function sanitizeDefinitions(raw) {
    const out = emptyDefinitions();
    for (const axis of AXES) {
        const entry = raw?.[axis];
        if (!entry) continue;
        const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
        out[axis] = {
            a: ids(entry.a),
            b: ids(entry.b),
            nameA: String(entry.nameA || '').slice(0, 40),
            nameB: String(entry.nameB || '').slice(0, 40),
        };
    }
    return out;
}

/**
 * What the request defines and what is wrong with the definitions as typed:
 * `axes` ({x: {a, b}} for the complete ones), `problems` (axis names with a
 * one-sided or too short definition), `names` ({x: {a, b}} of the defined ones).
 */
export function readDefinitions(defs) {
    const axes = {};
    const names = {};
    const problems = [];
    for (const axis of AXES) {
        const d = defs[axis];
        if (!d.a.length && !d.b.length) continue;
        if (d.a.length < MIN_EXAMPLES || d.b.length < MIN_EXAMPLES) {
            problems.push(axis);
            continue;
        }
        axes[axis] = { a: d.a, b: d.b };
        names[axis] = { a: d.nameA.trim(), b: d.nameB.trim() };
    }
    return { axes, names, problems };
}

export class CustomAxes {
    /**
     * `host.getMap()` -> {query, body: {space, map_id, layout}} or null,
     * `host.getSelection()` -> the picked dots' picture ids, `host.show(body)`
     * lays the map out (null: back to the original layout), `host.refreshMap()`
     * asks for the points again, `host.isActive()` tells whether the page is on
     * screen, `host.libraryId()` names the library the definitions belong to,
     * `host.reloadModel()` asks for the model's axis meanings again after a
     * revert, `host.onChange()` repaints the card.
     */
    constructor(host) {
        this.host = host;
        this.libraryId = null;
        this.defs = emptyDefinitions();
        this.applied = false;
        this.status = 'idle'; // idle | working | ok | error
        this.result = null;
        this.error = '';
        this.seq = 0;
        this.retried = false;
        // The last answers by (map, layout, definitions): the same request is never sent twice.
        this.cache = new Map();
        this.loadFor(host.libraryId());
    }

    /**
     * The user may have switched libraries since the definitions were read:
     * they belong to ONE library, so the other library's are loaded (and the
     * applied state with them) before anything is shown or saved.
     */
    syncLibrary() {
        const id = this.host.libraryId() || 'main';
        if (id === this.libraryId) return false;
        this.seq += 1;
        this.cache.clear();
        this.status = 'idle';
        this.result = null;
        this.error = '';
        this.loadFor(id);
        return true;
    }

    /** True when at least one axis has two usable boxes (the Apply button needs it). */
    canApply() {
        return Object.keys(readDefinitions(this.defs).axes).length > 0;
    }

    storageKey() {
        return `${STORAGE_PREFIX}${this.libraryId}`;
    }

    /** Read the definitions of this library (the user may have switched libraries). */
    loadFor(libraryId) {
        this.libraryId = libraryId || 'main';
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(this.storageKey()) || 'null');
        } catch (_error) {
            saved = null;
        }
        this.defs = sanitizeDefinitions(saved?.axes);
        this.applied = Boolean(saved?.applied) && Object.keys(readDefinitions(this.defs).axes).length > 0;
    }

    save() {
        try {
            localStorage.setItem(this.storageKey(), JSON.stringify({ v: 1, applied: this.applied, axes: this.defs }));
        } catch (_error) {
            // private window or blocked storage: the definitions hold for this visit
        }
    }

    armRetries() {
        this.retried = false;
    }

    /** Names of the defined axes, for the labels on the grid (null when not applied). */
    names() {
        return this.applied ? readDefinitions(this.defs).names : null;
    }

    change(mutate, { silent = false } = {}) {
        this.syncLibrary();
        const next = structuredClone(this.defs);
        mutate(next);
        this.defs = next;
        this.save();
        if (!silent) this.host.onChange();
    }

    /** Add the dots picked on the map to one end (a picture can be at one end of an axis only). */
    addSelection(axis, end) {
        const picked = this.host.getSelection();
        const other = end === 'a' ? 'b' : 'a';
        this.change((defs) => {
            const mine = new Set(defs[axis][end]);
            for (const id of picked) mine.add(id);
            defs[axis][end] = [...mine];
            defs[axis][other] = defs[axis][other].filter((id) => !mine.has(id));
        });
    }

    remove(axis, end, id) {
        this.change((defs) => {
            defs[axis][end] = defs[axis][end].filter((value) => value !== id);
        });
        return this.followEdit();
    }

    /** Typing a name never repaints the card (the field keeps its caret, a click on a button still lands). */
    setName(axis, end, name) {
        this.change((defs) => {
            defs[axis][end === 'a' ? 'nameA' : 'nameB'] = String(name).slice(0, 40);
        }, { silent: true });
    }

    clearAxis(axis) {
        this.change((defs) => {
            defs[axis] = { a: [], b: [], nameA: '', nameB: '' };
        });
        return this.followEdit();
    }

    /**
     * Taking pictures away while the axes are on: the map follows what is
     * left (laid out again from the complete axes), and with none left it goes
     * back to the model's layout and the model's labels.
     */
    followEdit() {
        if (!this.applied) return Promise.resolve();
        if (!this.canApply()) {
            this.revert();
            return Promise.resolve();
        }
        return this.run();
    }

    /** The user pressed Apply. */
    apply() {
        this.syncLibrary();
        const { axes, problems } = readDefinitions(this.defs);
        if (problems.length || !Object.keys(axes).length) {
            this.status = 'error';
            this.error = problems.length
                ? t('stylemap.customNeedTwo', 'Each end needs at least 2 pictures')
                : t('stylemap.customNeedOne', 'Define at least one axis');
            this.host.onChange();
            return Promise.resolve();
        }
        this.armRetries();
        this.applied = true;
        this.save();
        return this.run();
    }

    /** Back to the layout the model computed. */
    revert() {
        this.seq += 1;
        this.syncLibrary();
        this.applied = false;
        this.status = 'idle';
        this.result = null;
        this.error = '';
        this.save();
        this.host.show(null);
        this.host.reloadModel();
        this.host.onChange();
    }

    /** A new map is on screen: lay it out along the stored axes again. */
    mapChanged() {
        if (this.syncLibrary()) this.host.onChange();
        if (this.applied && this.host.getMap()) return this.run();
        return Promise.resolve();
    }

    async run() {
        const map = this.host.getMap();
        if (!map) return;
        const { axes } = readDefinitions(this.defs);
        const seq = ++this.seq;
        const key = JSON.stringify([map.body.map_id, map.body.layout, map.body.space, axes]);
        const known = this.cache.get(key);
        if (known) {
            // The same map, layout and definitions as before: nothing to ask.
            this.result = known;
            this.status = 'ok';
            this.host.show(known);
            this.host.onChange();
            return;
        }
        // While it is asked for, the last custom layout (if any) stays on screen.
        this.status = 'working';
        this.error = '';
        this.host.onChange();
        try {
            const body = await window.App.API.post(`/api/style-map/custom-axes?${map.query}`, { ...map.body, axes });
            if (seq !== this.seq) return;
            if (!this.host.isActive()) {
                this.status = 'idle';
                this.host.onChange();
                return;
            }
            if (body?.status === 'not_started') {
                if (!this.retried) {
                    this.retried = true;
                    await this.host.refreshMap();
                    return;
                }
                throw new Error('not_started');
            }
            if (body?.status !== 'ok') throw new Error(String(body?.status || 'bad answer'));
            if (this.host.show(body) === false) {
                // The answer does not match the points on screen (a refresh in between): ask once more.
                if (!this.retried) {
                    this.retried = true;
                    await this.host.refreshMap();
                    return;
                }
                throw new Error('layout_changed');
            }
            this.cache.set(key, body);
            if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
            this.result = body;
            this.status = 'ok';
        } catch (error) {
            if (seq !== this.seq) return;
            this.status = 'error';
            this.error = t('stylemap.customError', 'Could not apply: {error}', { error: formatError(error) });
            this.result = null;
            this.host.show(null);
        }
        this.host.onChange();
    }
}
