/**
 * Control identity for the V4 click-coverage ledger (docs/COVERAGE_LEDGER.md),
 * injected as a context init script after window.__uiStrings (the language
 * packs' strings, set by click-ledger.ts).
 *
 * window.__controlKey(el)       -> stable key for the control el belongs to
 * window.__controlContext(el)   -> where it lives: the open dialog or the page
 * window.__controlsInView()     -> [{ key, context }] for every control shown now
 *
 * The same functions name the controls a spec showed and the ones it used, so
 * scripts/coverage_gate.py can diff them exactly. A key must depend on the
 * interface, never on the test data: a tag, folder, batch or image name in a
 * control's label must not make it a new control.
 */
(() => {
    'use strict';
    if (window.__controlKey) return;

    const CONTROL_SELECTOR = [
        'button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
        '[role="button"]', '[role="menuitem"]', '[role="menuitemradio"]', '[role="menuitemcheckbox"]',
        '[role="tab"]', '[role="radio"]', '[role="checkbox"]', '[role="switch"]', '[role="option"]',
    ].join(', ');
    // One row of a list the data fills: every row is the same control.
    const ITEM_SELECTOR = 'li, tr, [role="row"], [role="listitem"], [role="treeitem"], [role="option"], [role="gridcell"], .chip';

    // Every number is data (ids, counts, "第 3 张"): one control however many there are.
    const squash = (value) => String(value).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

    // ---- the language packs: a label that is a UI string is named by its key ----
    let exact = null;
    let templates = null;
    const labelCache = new Map();

    const loosen = (literal) => literal
        .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
        // "{n} images" reads "1 image" when n is 1 (i18n/plural.ts)
        .replace(/\b([A-Za-z]{3,})s\b/g, '$1s?')
        .replace(/\bare\b/g, '(?:are|is)')
        .replace(/\bhave\b/g, '(?:have|has)');

    const buildIndex = () => {
        const source = window.__uiStrings || { exact: [], templates: [] };
        exact = new Map(source.exact.map(([text, key]) => [squash(text), key]));
        templates = [];
        for (const [text, key] of source.templates) {
            const parts = squash(text).split(/\{\w+\}|#/);
            if (parts.join('').trim().length < 2) continue; // "{name}" alone says nothing
            try {
                templates.push([new RegExp(`^${parts.map(loosen).join('.+?')}$`), key, parts.join('').length]);
            } catch {
                // a string that makes no pattern is simply not used
            }
        }
        // The template with the most fixed text wins: "Tag {n}" must not claim
        // a label that "Tag {n} of {total}" wrote.
        templates.sort((a, b) => b[2] - a[2]);
    };

    // "In" is a UI string; "Inbox" does not start with it.
    const wordChar = /[A-Za-z0-9#]/;
    const startsWithWord = (text, ui) =>
        text.startsWith(ui) && !(wordChar.test(ui.charAt(ui.length - 1)) && wordChar.test(text.charAt(ui.length)));

    /** The pack key a label was written from (whole, or a template), or null. */
    const uiKeyOf = (label) => {
        const text = squash(label);
        if (!text) return null;
        if (labelCache.has(text)) return labelCache.get(text);
        if (!exact) buildIndex();
        let key = exact.get(text) || null;
        if (!key) {
            for (const [pattern, name] of templates) {
                if (pattern.test(text)) {
                    key = name;
                    break;
                }
            }
        }
        labelCache.set(text, key);
        return key;
    };

    /**
     * A UI string followed by data or a key hint ("Negative" + the prompt,
     * "Open large" + "Enter"): the key of the longest UI string it starts with.
     */
    const uiPrefixOf = (label) => {
        const text = squash(label);
        if (!exact) buildIndex();
        let best = '';
        let key = null;
        for (const [ui, name] of exact) {
            if (ui.length > best.length && ui.length >= 2 && startsWithWord(text, ui)) {
                best = ui;
                key = `${name}…`;
            }
        }
        return key;
    };

    const controlOf = (el) => {
        if (!el || el.nodeType !== 1) return null;
        const label = el.closest('label');
        if (label) {
            const inner = label.querySelector('input, select, textarea');
            if (inner) return inner;
        }
        return el.closest(CONTROL_SELECTOR);
    };

    const nameOf = (node) => {
        const aria = node.getAttribute('aria-label');
        if (aria) return aria;
        const labelled = node.getAttribute('aria-labelledby');
        if (labelled) {
            const text = labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
            if (text.trim()) return text;
        }
        if (node.id) {
            const label = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
            if (label?.textContent?.trim()) return label.textContent;
        }
        const wrapping = node.closest('label');
        if (wrapping?.textContent?.trim()) return wrapping.textContent;
        const title = node.getAttribute('title');
        if (title) return title;
        return node.textContent || node.getAttribute('placeholder') || node.getAttribute('name') || '';
    };

    const dialogOf = (node) => node.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');

    /** A label as a key part: its pack key, or the words themselves (numbers folded). */
    const labelPart = (label) => {
        const key = uiKeyOf(label);
        return key ? `@${key}` : squash(label).slice(0, 48);
    };

    window.__controlContext = (el) => {
        const node = el ? controlOf(el) || el : null;
        const dialog = node ? dialogOf(node) : null;
        if (dialog) {
            const role = dialog.getAttribute('role');
            const name = dialog.getAttribute('aria-label')
                || (dialog.getAttribute('aria-labelledby') && document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent)
                || '';
            const testId = dialog.getAttribute('data-testid');
            const label = testId ? squash(testId) : name ? labelPart(name) : 'unnamed';
            return `${role === 'alertdialog' ? 'dialog' : role}:${label}`;
        }
        const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
        if (hash) return `page:${squash(hash)}`;
        // The page is the first thing under the top bar; the library page has no
        // test id of its own, so the current top-bar tab names it.
        const root = document.querySelector('header')?.nextElementSibling?.firstElementChild;
        const id = root?.getAttribute('data-testid');
        if (id) return `page:${id}`;
        const tab = document.querySelector('nav[aria-label="main"] [aria-current="page"]');
        return tab ? `page:${labelPart(tab.textContent || '')}` : 'page:unknown';
    };

    window.__controlKey = (el) => {
        const node = controlOf(el);
        if (!node) return null;
        const testId = node.getAttribute('data-testid');
        if (testId) return `tid:${squash(testId)}`;
        const role = node.getAttribute('role') || node.tagName.toLowerCase();
        const type = node.tagName === 'INPUT' ? `[${node.getAttribute('type') || 'text'}]` : '';
        // A control without a test id is named inside its nearest named container,
        // so "Close" in two different dialogs stays two controls.
        const scopeNode = node.parentElement?.closest('[data-testid]');
        const where = scopeNode ? `${squash(scopeNode.getAttribute('data-testid'))} ` : '';
        const label = nameOf(node);
        const uiKey = uiKeyOf(label);
        if (uiKey) return `${where}${role}${type}:@${uiKey}`;
        // Not a UI string: a label the data wrote. In a row the data fills
        // (a tag chip, a folder, a batch, a menu of libraries), every row is one control.
        const item = node.closest(ITEM_SELECTOR);
        const inRow = item && (!scopeNode || scopeNode.contains(item));
        const inDataMenu = node.matches('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]');
        if (inRow || inDataMenu) return `${where}${role}${type}:(row)`;
        const prefix = uiPrefixOf(label);
        if (prefix) return `${where}${role}${type}:@${prefix}`;
        return `${where}${role}${type}:${squash(label).slice(0, 48) || 'unnamed'}`;
    };

    window.__controlsInView = () => {
        const seen = new Map();
        for (const node of document.querySelectorAll(CONTROL_SELECTOR)) {
            if (node.closest('[hidden], [inert]')) continue;
            const box = node.getBoundingClientRect();
            if (box.width === 0 && box.height === 0 && node.getClientRects().length === 0) continue;
            const key = window.__controlKey(node);
            if (key && !seen.has(key)) seen.set(key, window.__controlContext(node));
        }
        return [...seen].map(([key, context]) => ({ key, context }));
    };
})();
