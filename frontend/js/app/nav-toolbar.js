/**
 * app/nav-toolbar.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 2312-2474 (of 10,152): nav overflow ladder + tools menu + generator rail.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
function updateNavigationOverflowState() {
    const navBar = $('.nav-bar');
    const navTabs = $('.nav-tabs');
    if (!navBar || !navTabs) return window.innerWidth <= 768;

    const forceMobileLayout = window.innerWidth <= 768;
    navBar.classList.remove(
        'nav-tabs-overflow',
        'nav-actions-compact',
        'nav-tabs-icon-only',
        'nav-tabs-compact-labels',
        'nav-tabs-compact-secondary',
        'nav-tabs-compact-brand',
        'nav-priority-overflow'
    );
    if (forceMobileLayout) {
        navBar.classList.add('nav-tabs-overflow');
        return true;
    }

    // Owner 2026-07-05: the Aurora left rail is reverted to the classic top
    // bar, so the horizontal width-degradation ladder below is live again
    // (it was a no-op at >=769px while the rail was vertical).
    const needsOverflow = () => {
        // v3.2.2: simplest possible overflow detection — does the
        // ``navTabs`` flex container's scrollWidth (its natural,
        // un-clipped width) exceed its clientWidth (what the layout
        // gave it)? If yes, content is being clipped, regardless of
        // what nav-actions-compact / brand width / etc. compute to.
        // The previous formula tried to predict the available width
        // from sibling sizes; on 1440 px laptops it under-counted the
        // gap and let the last tab silently clip.
        return navTabs.scrollWidth > navTabs.clientWidth + 1;
    };

    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    // Desktop-first degradation: show Prompt Helper / Style Finder directly
    // when there is room, then move only those low-priority tools into More.
    navBar.classList.add('nav-priority-overflow');
    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    // Keep the core pipeline labels readable before falling back to icon-only.
    navBar.classList.add('nav-tabs-compact-labels');
    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    navBar.classList.add('nav-tabs-compact-secondary');
    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    navBar.classList.add('nav-tabs-compact-brand');
    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    navBar.classList.add('nav-actions-compact');
    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    navBar.classList.add('nav-tabs-icon-only');
    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    navBar.classList.remove(
        'nav-actions-compact',
        'nav-tabs-icon-only',
        'nav-tabs-compact-labels',
        'nav-tabs-compact-secondary',
        'nav-tabs-compact-brand',
        'nav-priority-overflow'
    );
    navBar.classList.add('nav-tabs-overflow');
    return true;
}

// v3.4.3: Prompt Helper + Style Finder render as direct tabs when space allows.
// The More dropdown is a responsive fallback for narrow windows / long labels.
// Menu items stay .nav-tab buttons, so switchView and the shared click binding
// continue to treat them like normal tabs.
function setupNavToolsMenu() {
    const toggle = document.getElementById('nav-tools-toggle');
    const menu = document.getElementById('nav-tools-menu');
    if (!toggle || !menu) return;

    const close = () => {
        if (menu.hidden) return;
        menu.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.classList.remove('menu-open');
    };
    const open = () => {
        menu.hidden = false;
        window.PopupPosition?.place(menu, {
            anchor: toggle,
            placement: 'bottom-end',
            gap: 8,
        });
        toggle.setAttribute('aria-expanded', 'true');
        toggle.classList.add('menu-open');
    };

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.hidden) open(); else close();
    });
    // Close on any outside click.
    document.addEventListener('click', (e) => {
        if (menu.hidden) return;
        if (toggle.contains(e.target) || menu.contains(e.target)) return;
        close();
    });
    // Close on Escape and return focus to the toggle.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) {
            close();
            toggle.focus();
        }
    });

    // Exposed so switchView can collapse the menu after a tool is chosen.
    window._closeNavToolsMenu = close;
}

// Reflect the active state onto the Tools toggle when a tool view is open, since
// its menu items live inside a (usually closed) dropdown where the .active
// highlight would otherwise be invisible.
function updateNavToolsActive(viewName) {
    const toggle = document.getElementById('nav-tools-toggle');
    const TOOL_VIEWS = ['promptlab', 'artist'];
    if (toggle) toggle.classList.toggle('active', TOOL_VIEWS.includes(viewName));
    document.querySelectorAll('.nav-tools-mirror').forEach((item) => {
        const isActive = item.dataset.view === viewName;
        item.classList.toggle('active', isActive);
        item.setAttribute('aria-selected', String(isActive));
    });
}

function syncGeneratorRailOverflow() {
    const tabs = document.getElementById('generator-tabs');
    const scroller = document.getElementById('generator-tabs-scroll');
    if (!tabs || !scroller) return;
    const canScroll = scroller.scrollWidth > scroller.clientWidth + 1;
    const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 2;
    tabs.classList.toggle('no-scroll', !canScroll);
    tabs.style.setProperty('--generator-overflow-end', canScroll && !atEnd ? '1' : '0');
}

