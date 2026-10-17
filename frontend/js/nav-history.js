/**
 * Browser Back and the mouse back button go up one level, like Esc: the
 * topmost dialog, panel or menu closes first (by sending it the same Escape
 * key, so every guard Esc has still applies), otherwise the page shown before
 * comes back. Forward returns to where the user had been.
 *
 * Only a change of screen (a page tab, or the entry page) adds a history entry;
 * a redraw of the same screen adds none. Dialogs add none either: Back is
 * answered by closing one and putting the entry it used back.
 *
 * The first screen is the root. Back there would leave the program, so the
 * first press only says so and a second one within a few seconds leaves.
 *
 * History entries are only added after the first key or click, so the browser
 * treats them as the user's own and does not skip them on Back.
 */
(function () {
    'use strict';

    const MARK = 'sdSorter';
    const ROOT_LEAVE_WINDOW_MS = 3000;

    let armed = false;
    let current = null;
    let lastRootBackAt = 0;

    const stateFor = (screen) => ({ [MARK]: 'app', screen });

    function entryVisible() {
        return document.body.classList.contains('entry-active');
    }

    function screenNow() {
        if (entryVisible()) return 'entry';
        return document.querySelector('.nav-bar')?.getAttribute('data-view') || 'gallery';
    }

    function arm() {
        if (armed) return;
        armed = true;
        current = screenNow();
        // After a reload the entry is already ours; refresh what it says.
        if (history.state?.[MARK] === 'app') {
            history.replaceState(stateFor(current), '');
            return;
        }
        // Behind the first screen, an entry to land on so Back can be answered.
        if (history.state?.[MARK] !== 'base') history.replaceState({ [MARK]: 'base' }, '');
        history.pushState(stateFor(current), '');
    }

    function onScreenMaybeChanged() {
        if (!armed) return;
        const screen = screenNow();
        if (screen === current) return;
        current = screen;
        history.pushState(stateFor(screen), '');
    }

    function showScreen(screen) {
        // Set first, so the change below is not recorded as new navigation.
        current = screen;
        if (screen === 'entry') {
            if (!entryVisible()) window.EntryPage?.show?.();
            return;
        }
        if (!document.getElementById(`view-${screen}`)) return;
        if (entryVisible()) window.EntryPage?.hide?.();
        if (screenNow() !== screen) switchView(screen);
    }

    function closeTopOverlay() {
        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true,
        }));
    }

    function onRootBack() {
        const now = Date.now();
        if (now - lastRootBackAt <= ROOT_LEAVE_WINDOW_MS) {
            lastRootBackAt = 0;
            history.back();
            return;
        }
        lastRootBackAt = now;
        history.pushState(stateFor(current), '');
        if (typeof showToast === 'function') {
            showToast(appT('nav.backAtStart', 'This is the first screen. Press Back again to leave.'), 'info');
        }
    }

    function onPopState(event) {
        const state = event.state;
        if (!armed || !state || !state[MARK]) return;
        if (window.EntryPage?.hasOverlay?.()) {
            history.pushState(stateFor(current), '');
            closeTopOverlay();
            return;
        }
        if (state[MARK] === 'base') {
            onRootBack();
            return;
        }
        showScreen(state.screen);
    }

    function init() {
        const armOnce = () => {
            window.removeEventListener('pointerdown', armOnce, true);
            window.removeEventListener('keydown', armOnce, true);
            arm();
        };
        window.addEventListener('pointerdown', armOnce, true);
        window.addEventListener('keydown', armOnce, true);

        const observer = new MutationObserver(onScreenMaybeChanged);
        const navBar = document.querySelector('.nav-bar');
        if (navBar) observer.observe(navBar, { attributes: true, attributeFilter: ['data-view'] });
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

        window.addEventListener('popstate', onPopState);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
