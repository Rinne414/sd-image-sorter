/**
 * "Locate a picture" search box of the Style Map toolbar (S4f).
 *
 * The text is the Gallery's own search language (window.GallerySearchQuery,
 * the parser of the Gallery search bar), turned into the same filter fields
 * the Gallery would use, stored as a selection token and sent to
 * POST /api/style-map/locate together with the handle of the map on screen.
 * The server intersects the matches with the map's pictures (merged ones
 * included), so a hit always has a dot. Picking a result turns the camera to
 * its dot, rings it and shows its picture in the preview.
 *
 * Every text is composed from i18n keys when written and repainted on a
 * language switch; no element here carries data-i18n, so the ui-refresh
 * re-apply cannot reset them.
 */
import { t, formatError } from './text.js';

const DEBOUNCE_MS = 350;
const THUMBNAIL_SIZE = 96;
// Gallery filter fields the box writes. Lists are taken as parsed; the two
// narrowing lists (generators, ratings) only when the query names some, since
// their default is "everything".
const LIST_FIELDS = [
    'tags', 'excludeTags', 'checkpoints', 'excludeCheckpoints', 'loras', 'excludeLoras',
    'prompts', 'excludePrompts', 'excludeGenerators', 'excludeRatings', 'excludeColors',
    'colorHues', 'excludeColorHues',
];
const NARROW_FIELDS = ['generators', 'ratings'];

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** The Gallery filter a parsed search stands for, over `defaults` (nothing else is filtered). */
export function filtersFromSearch(parsed, defaults) {
    const filters = { ...defaults };
    for (const field of LIST_FIELDS) {
        if (parsed[field]?.length) filters[field] = [...parsed[field]];
    }
    for (const field of NARROW_FIELDS) {
        if (parsed[field]?.length) filters[field] = [...new Set(parsed[field])];
    }
    Object.assign(filters, parsed.scalars || {});
    filters.search = (parsed.freeText || []).join(' ').trim();
    return filters;
}

/** The query's parts the Gallery grammar did not understand (shown as a hint). */
function ignoredParts(parsed) {
    return (parsed.parts || []).filter((part) => part.kind === 'warn').map((part) => part.value);
}

export class MapLocator {
    /**
     * `host.getMap()` gives {space, mapId, signature} of the map on screen
     * (null while there is none), `host.refreshMap()` asks for the points
     * again, `host.preview(id)` shows a picture, `host.mark(position)` rings
     * a dot, `host.showAll()` clears the Gallery filter, `host.getApp()` the
     * shared App object.
     */
    constructor(root, host, scene) {
        this.host = host;
        this.scene = scene;
        const $ = (id) => root.querySelector(`#${id}`);
        this.el = {
            box: $('stylemap-locate'),
            input: $('stylemap-locate-input'),
            clear: $('stylemap-locate-clear'),
            pop: $('stylemap-locate-pop'),
            status: $('stylemap-locate-status'),
            action: $('stylemap-locate-action'),
            list: $('stylemap-locate-list'),
            foot: $('stylemap-locate-foot'),
        };
        this.answer = null;
        this.state = null; // {key, fallback, params, tone}: what the pop says besides the list
        this.ignored = [];
        this.active = -1;
        this.sig = null; // the map the answer belongs to
        this.seq = 0;
        this.abort = null;
        this.timer = null;
        this.refreshing = false;
        this.bind();
        this.paintStatic();
    }

    bind() {
        const { input, clear, pop, box } = this.el;
        if (!input) return;
        input.addEventListener('input', () => this.onInput());
        input.addEventListener('keydown', (event) => this.onKeydown(event));
        input.addEventListener('focus', () => {
            if (this.hasContent()) this.open();
        });
        clear.addEventListener('click', () => {
            this.reset();
            input.focus();
        });
        // Clicks inside the pop must not take the focus from the input.
        pop.addEventListener('mousedown', (event) => event.preventDefault());
        document.addEventListener('mousedown', (event) => {
            if (!box.contains(event.target)) this.close();
        });
    }

    // ------------------------------------------------------------ behaviour
    hasContent() {
        return Boolean(this.answer || this.state);
    }

    onInput() {
        clearTimeout(this.timer);
        this.el.clear.hidden = !this.el.input.value;
        if (!this.el.input.value.trim()) {
            this.reset(false);
            return;
        }
        this.timer = setTimeout(() => this.search(false), DEBOUNCE_MS);
    }

    onKeydown(event) {
        const items = this.answer?.results || [];
        if (event.key === 'Escape' && this.isOpen()) {
            event.preventDefault();
            event.stopPropagation();
            this.close();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!items.length) return;
            event.preventDefault();
            this.open();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            this.setActive((this.active + step + items.length) % items.length);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            clearTimeout(this.timer);
            if (this.isOpen() && items[this.active]) this.pick(items[this.active]);
            else if (this.el.input.value.trim()) this.search(false);
        }
    }

    /** Empty the box and the list (a map change or the clear button). */
    reset(clearText = true) {
        this.seq += 1;
        this.abort?.abort();
        clearTimeout(this.timer);
        this.answer = null;
        this.state = null;
        this.ignored = [];
        this.active = -1;
        if (clearText) this.el.input.value = '';
        this.el.clear.hidden = !this.el.input.value;
        this.host.mark(null);
        this.close();
        this.render();
    }

    /** A new map is on screen: the dots of the old answer are gone; ask again for a typed query. */
    mapChanged(signature) {
        if (signature === this.sig || this.refreshing) return;
        this.answer = null;
        this.state = null;
        this.active = -1;
        this.render();
        if (this.el.input.value.trim() && this.host.getMap()) this.search(false);
        else this.close();
    }

    // --------------------------------------------------------------- search
    /** The token of the box text through the Gallery grammar; null when it names nothing to look for. */
    async searchToken(text) {
        const app = this.host.getApp();
        const parsed = window.GallerySearchQuery ? window.GallerySearchQuery.parse(text) : { freeText: [text], parts: [] };
        this.ignored = ignoredParts(parsed);
        const parts = parsed.parts || [];
        if (parts.length && parts.every((part) => part.kind === 'warn')) return null;
        const defaults = app.createDefaultFilterState();
        const made = await app.API.createSelectionToken({ ...filtersFromSearch(parsed, defaults), sortBy: 'newest' });
        return made?.selection_token || null;
    }

    async search(retried) {
        const map = this.host.getMap();
        const text = this.el.input.value.trim();
        if (!text) return;
        this.seq += 1;
        const seq = this.seq;
        this.abort?.abort();
        this.abort = new AbortController();
        this.answer = null;
        this.active = -1;
        if (!map) {
            this.setState('stylemap.locateNoMap', 'There is no map to search yet', 'info');
            return;
        }
        this.setState('stylemap.locateWorking', 'Searching...', 'busy');
        try {
            const token = await this.searchToken(text);
            if (seq !== this.seq) return;
            if (!token) {
                this.setState('stylemap.locateNoTerms', 'Type a file name, tag:name or prompt:word', 'info');
                return;
            }
            const answer = await this.host.getApp().API.post('/api/style-map/locate', {
                space: map.space,
                map_id: map.mapId,
                search_token: token,
            });
            if (seq !== this.seq) return;
            if (answer?.status === 'not_started') {
                await this.retryAfterRefresh(retried, seq);
                return;
            }
            this.accept(answer, map.signature);
        } catch (error) {
            if (seq !== this.seq || error?.name === 'AbortError') return;
            this.setState('stylemap.locateErr', 'The search failed: {error}', 'error', { error: formatError(error) });
        }
    }

    /** The server lost the map: rebuild it once, then ask again (never in a loop). */
    async retryAfterRefresh(retried, seq) {
        if (retried) throw new Error('not_started');
        this.refreshing = true;
        try {
            await this.host.refreshMap();
        } finally {
            this.refreshing = false;
        }
        if (seq === this.seq) await this.search(true);
    }

    accept(answer, signature) {
        this.answer = answer;
        this.sig = signature;
        this.state = null;
        this.active = answer.results.length ? 0 : -1;
        if (!answer.results.length) this.state = this.emptyState(answer);
        this.render();
        this.openIfTyping();
    }

    /** Why nothing was found, in the order the user can act on it. */
    emptyState(answer) {
        if (answer.outside_filter > 0) {
            return {
                key: 'stylemap.locateOutsideCount',
                fallback: '{count} matching pictures are outside the current Gallery filter, so they are not on this map.',
                params: { count: answer.outside_filter },
                tone: 'warn',
                action: { key: 'stylemap.locateShowAll', fallback: 'Show all pictures', run: () => this.host.showAll() },
            };
        }
        if (answer.without_data > 0) {
            return {
                key: 'stylemap.locateNoData',
                fallback: '{count} matching pictures have no style data yet, so they have no dot.',
                params: { count: answer.without_data },
                tone: 'warn',
            };
        }
        return { key: 'stylemap.locateNone', fallback: 'No picture on this map matches.', params: {}, tone: 'info' };
    }

    setState(key, fallback, tone, params = {}) {
        this.state = { key, fallback, params, tone };
        this.render();
        this.openIfTyping();
    }

    /** New words or results open the list for the user who is typing; a repaint never reopens one they closed. */
    openIfTyping() {
        if (document.activeElement === this.el.input) this.open();
    }

    // ----------------------------------------------------------------- pick
    pick(item) {
        const position = { x: item.x, y: item.y, z: item.z };
        this.scene?.flyTo([item.x, item.y, item.z]);
        this.host.mark(position);
        this.host.preview(item.id);
        this.close();
    }

    setActive(index) {
        this.active = index;
        const rows = [...this.el.list.querySelectorAll('.stylemap-locate-row')];
        rows.forEach((row, i) => {
            row.classList.toggle('is-active', i === index);
            row.setAttribute('aria-selected', i === index ? 'true' : 'false');
        });
        const row = rows[index];
        const { pop } = this.el;
        if (row) {
            // Scroll the list itself; scrollIntoView would also move the page.
            if (row.offsetTop < pop.scrollTop) pop.scrollTop = row.offsetTop;
            else if (row.offsetTop + row.offsetHeight > pop.scrollTop + pop.clientHeight) pop.scrollTop = row.offsetTop + row.offsetHeight - pop.clientHeight;
        }
        this.el.input.setAttribute('aria-activedescendant', rows[index]?.id || '');
    }

    isOpen() {
        return !this.el.pop.hidden;
    }

    open() {
        if (!this.hasContent()) return;
        this.el.pop.hidden = false;
        this.el.input.setAttribute('aria-expanded', 'true');
    }

    close() {
        this.el.pop.hidden = true;
        this.el.input.setAttribute('aria-expanded', 'false');
        this.el.input.removeAttribute('aria-activedescendant');
    }

    // ---------------------------------------------------------------- paint
    paintStatic() {
        const { input, clear } = this.el;
        if (!input) return;
        const label = t('stylemap.locateLabel', 'Locate a picture');
        input.placeholder = t('stylemap.locatePlaceholder', 'Locate a picture: file name, tag:, prompt:');
        input.setAttribute('aria-label', label);
        this.el.box.title = t('stylemap.locateTip', 'Find a picture on this map by file name, tag or prompt (the Gallery search language)');
        const clearLabel = t('stylemap.nearClear', 'Clear');
        clear.title = clearLabel;
        clear.setAttribute('aria-label', clearLabel);
    }

    /** Repaint every JS-written text (also on a language switch). */
    render() {
        this.paintStatic();
        this.renderStatus();
        this.renderList();
        this.renderFoot();
        if (!this.hasContent()) this.close();
    }

    renderStatus() {
        const { status, action } = this.el;
        const s = this.state;
        status.hidden = !s;
        action.hidden = !s?.action;
        if (!s) return;
        status.textContent = t(s.key, s.fallback, s.params);
        status.dataset.tone = s.tone;
        if (s.action) {
            action.textContent = t(s.action.key, s.action.fallback);
            action.onclick = s.action.run;
        }
    }

    renderList() {
        const { list } = this.el;
        list.replaceChildren();
        const results = this.answer?.results || [];
        results.forEach((item, index) => list.append(this.row(item, index)));
        if (this.answer && results.length) {
            const { total } = this.answer;
            const key = total > results.length ? 'stylemap.locateCountMore' : 'stylemap.locateCount';
            const fallback = total > results.length ? '{shown} of {total} matches on this map' : '{total} matches on this map';
            list.prepend(el('li', 'stylemap-locate-count', t(key, fallback, { shown: results.length, total })));
        }
    }

    renderFoot() {
        const { foot } = this.el;
        const ignored = this.ignored;
        foot.hidden = !ignored.length || !this.hasContent();
        if (!foot.hidden) {
            foot.textContent = t('stylemap.locateIgnored', 'Not understood and ignored: {terms}', { terms: ignored.join(', ') });
        }
    }

    row(item, index) {
        const li = el('li', 'stylemap-locate-item');
        const button = el('button', 'stylemap-locate-row');
        button.type = 'button';
        button.id = `stylemap-locate-row-${index}`;
        button.tabIndex = -1;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', index === this.active ? 'true' : 'false');
        button.classList.toggle('is-active', index === this.active);
        button.dataset.id = String(item.id);
        const thumb = el('img', 'stylemap-locate-thumb');
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.src = `/api/image-thumbnail/${item.id}?size=${THUMBNAIL_SIZE}`;
        const text = el('span', 'stylemap-locate-text');
        const name = item.filename || `#${item.id}`;
        const nameNode = el('span', 'stylemap-locate-name', name);
        nameNode.title = name;
        text.append(nameNode);
        if (item.merged) text.append(el('span', 'stylemap-locate-flag', t('stylemap.nearMerged', 'merged into the same dot as another picture')));
        button.append(thumb, text);
        button.addEventListener('click', () => this.pick(item));
        button.addEventListener('mousemove', () => {
            if (this.active !== index) this.setActive(index);
        });
        li.setAttribute('role', 'presentation');
        li.append(button);
        return li;
    }
}
