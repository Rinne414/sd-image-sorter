/**
 * Control identity for the V4 click-coverage ledger (docs/COVERAGE_LEDGER.md),
 * injected as a context init script.
 *
 * window.__controlKey(el)       -> stable key for the control el belongs to
 * window.__controlContext(el)   -> where it lives: the open dialog or the page
 * window.__controlsInView()     -> [{ key, context }] for every control shown now
 *
 * The same functions name the controls a spec showed and the ones it used, so
 * scripts/coverage_gate.py can diff them exactly.
 */
(() => {
    'use strict';
    if (window.__controlKey) return;

    const CONTROL_SELECTOR = [
        'button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
        '[role="button"]', '[role="menuitem"]', '[role="menuitemradio"]', '[role="menuitemcheckbox"]',
        '[role="tab"]', '[role="radio"]', '[role="checkbox"]', '[role="switch"]', '[role="option"]',
    ].join(', ');

    // Runs of digits in a test id or name are item numbers (card-1234, 第 3 张):
    // one control, however many items it is drawn for.
    const squash = (value) => String(value).replace(/\d{2,}/g, '#').replace(/\s+/g, ' ').trim();

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
        const text = node.textContent || node.getAttribute('placeholder') || node.getAttribute('name') || '';
        return text;
    };

    const dialogOf = (node) => node.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');

    window.__controlContext = (el) => {
        const node = el ? controlOf(el) || el : null;
        const dialog = node ? dialogOf(node) : null;
        if (dialog) {
            const role = dialog.getAttribute('role');
            const name = dialog.getAttribute('aria-label')
                || (dialog.getAttribute('aria-labelledby') && document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent)
                || dialog.getAttribute('data-testid')
                || '';
            return `${role === 'alertdialog' ? 'dialog' : role}:${squash(name).slice(0, 48) || 'unnamed'}`;
        }
        const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
        if (hash) return `page:${squash(hash).replace(/\d+/g, "#")}`;
        // The page is the first thing under the top bar; the library page has no
        // test id of its own, so the current top-bar tab names it.
        const root = document.querySelector('header')?.nextElementSibling?.firstElementChild;
        const id = root?.getAttribute('data-testid');
        if (id) return `page:${id}`;
        const tab = document.querySelector('nav[aria-label="main"] [aria-current="page"]');
        return tab ? `page:${squash(tab.textContent || '').toLowerCase()}` : 'page:unknown';
    };

    window.__controlKey = (el) => {
        const node = controlOf(el);
        if (!node) return null;
        const testId = node.getAttribute('data-testid');
        if (testId) return `tid:${squash(testId)}`;
        const role = node.getAttribute('role') || node.tagName.toLowerCase();
        const type = node.tagName === 'INPUT' ? `[${node.getAttribute('type') || 'text'}]` : '';
        const name = squash(nameOf(node)).slice(0, 48);
        // A control without a test id is named inside its nearest named container,
        // so "关闭" in two different dialogs stays two controls.
        const scope = node.parentElement?.closest('[data-testid]');
        const where = scope ? `${squash(scope.getAttribute('data-testid'))} ` : '';
        return `${where}${role}${type}:${name || 'unnamed'}`;
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
