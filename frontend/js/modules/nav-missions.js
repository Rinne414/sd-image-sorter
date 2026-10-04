/**
 * Mission-scoped smart nav bar + customizable tab visibility.
 *
 * Owner FB (2026-07-07): "if user click those missions in the main page, the
 * topest bar will smartly switch to only needed tab there, so user know how
 * to going. Yes, make the bar customerize."
 *
 * Three layers decide which direct tabs are visible:
 * 1. Mission mode (persisted): entry-page mission tiles enter a mission; the
 *    bar shows ONLY that mission's tabs in pipeline order with step badges,
 *    plus a chip whose ✕ exits back to the user's own set.
 * 2. Base set (persisted, customizable): a checklist under More decides which
 *    views stay in the bar and in what order (owner 2026-09-30: every view,
 *    reorderable — "why limit users here?"). The Library is always shown,
 *    first. Dataset, Reverse Prompt, Prompt Helper and Style Finder are out
 *    of the default set (More + catalog + entry tiles reach them). Users who
 *    already saved a custom set keep it.
 * 3. Contextual reveal: the active view's tab is always shown, so an open
 *    view never lacks its highlighted tab.
 *
 * Tucked views stay reachable through More-menu mirrors (#nav-tools-{view}).
 * Mirrors carry data-mirror-view, NOT data-view — Playwright page objects
 * click plain [data-view=...] locators and a second match would violate
 * strict mode (the pre-existing promptlab/artist mirrors are grandfathered).
 */
(function () {
    'use strict';

    const TABS_KEY = 'aurora-nav-tabs';
    const MISSION_KEY = 'aurora-nav-mission';
    // Missions whose steps already popped open once; later entries stay quiet.
    const STEPS_SEEN_KEY = 'aurora-nav-mission-steps-seen';

    const ALL_VIEWS = ['gallery', 'reader', 'sorting', 'censor', 'similar', 'dataset', 'promptlab', 'artist', 'stylemap', 'reverse'];
    // Owner 2026-09-30: the Style Map is a default tab (sixth, after Similar).
    const DEFAULT_TABS = ['gallery', 'reader', 'sorting', 'censor', 'similar', 'stylemap'];
    const LOCKED_TABS = ['gallery'];
    const CUSTOM_VIEWS = ALL_VIEWS.filter((view) => !LOCKED_TABS.includes(view));

    // Steps shown by the chip's panel. Several steps can live in one view
    // (Pixiv: censor, order and export all happen in Censor Edit), so the bar
    // keeps one tab per view and the panel says what each step asks.
    const MISSIONS = {
        lora: {
            labelKey: 'entry.missionLoraTitle', fallback: 'LoRA Dataset', tabs: ['gallery', 'dataset'],
            steps: [
                { view: 'gallery', key: 'navMission.lora.pick', title: 'Pick', hint: 'Select the training images in the Gallery, then click To Dataset Maker at the front of the bar at the bottom. You can also import a folder in the dataset directly.' },
                { view: 'dataset', key: 'navMission.lora.build', title: 'Tag and export', hint: 'Tag, edit captions, then export a training set kohya can read.' },
            ],
        },
        pixiv: {
            labelKey: 'entry.missionPixivTitle', fallback: 'Pixiv Set Publishing', tabs: ['gallery', 'censor'],
            steps: [
                { view: 'gallery', key: 'navMission.pixiv.pick', title: 'Pick', hint: 'Select the images for this set in the Gallery, then click Censor in the bar at the bottom.' },
                { view: 'censor', key: 'navMission.pixiv.censor', title: 'Censor', hint: 'Censor each image, or start with Auto detect on the right.' },
                { view: 'censor', key: 'navMission.pixiv.order', title: 'Order and rename', hint: 'Order the queue with the arrows on the left; name the files with Batch Rename on the right.' },
                { view: 'censor', key: 'navMission.pixiv.export', title: 'Export', hint: 'Click To Publish Set at the bottom right, check the set, then export it.' },
            ],
        },
        organize: {
            labelKey: 'entry.missionOrganizeTitle', fallback: 'Batch Organize', tabs: ['gallery', 'sorting'],
            steps: [
                { view: 'gallery', key: 'navMission.organize.look', title: 'Look', hint: 'See which images need a home; Organize has its own filters.' },
                { view: 'sorting', key: 'navMission.organize.sort', title: 'Sort', hint: 'Auto-Separate moves images into folders by rule; sort the rest by hand with WASD in Manual Sort.' },
            ],
        },
    };

    function t(key, fallback) {
        const value = window.I18n && window.I18n.t ? window.I18n.t(key) : null;
        return (value && value !== key) ? value : (fallback || key);
    }

    function readJson(key) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            return null;
        }
    }

    function baseTabs() {
        const stored = readJson(TABS_KEY);
        if (!Array.isArray(stored)) return DEFAULT_TABS.slice();
        const valid = stored.filter((view) => ALL_VIEWS.includes(view));
        LOCKED_TABS.forEach((view) => {
            if (!valid.includes(view)) valid.unshift(view);
        });
        return valid;
    }

    function setBaseTabs(list) {
        try { localStorage.setItem(TABS_KEY, JSON.stringify(list)); } catch (error) { /* ignore */ }
        apply();
    }

    function activeMission() {
        let key = null;
        try { key = localStorage.getItem(MISSION_KEY); } catch (error) { /* ignore */ }
        return MISSIONS[key] ? key : null;
    }

    function enter(missionKey) {
        if (!MISSIONS[missionKey]) return;
        try { localStorage.setItem(MISSION_KEY, missionKey); } catch (error) { /* ignore */ }
        apply();
        // A mission shows its steps the first time only; after that they would
        // just cover the page, and the chip label reopens them.
        const seen = readJson(STEPS_SEEN_KEY);
        const seenList = Array.isArray(seen) ? seen : [];
        if (seenList.includes(missionKey)) return;
        try { localStorage.setItem(STEPS_SEEN_KEY, JSON.stringify([...seenList, missionKey])); } catch (error) { /* ignore */ }
        // Deferred: the entry tile's own click is still bubbling and would
        // otherwise count as a click outside the panel.
        window.setTimeout(openSteps, 0);
    }

    function exit() {
        try { localStorage.removeItem(MISSION_KEY); } catch (error) { /* ignore */ }
        closeSteps();
        apply();
    }

    // ------------------------------------------------------------------
    // Step panel under the mission chip
    // ------------------------------------------------------------------

    function stepsPanel() {
        let panel = document.getElementById('nav-mission-steps');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'nav-mission-steps';
        panel.className = 'nav-mission-steps';
        panel.setAttribute('role', 'dialog');
        panel.hidden = true;
        document.body.appendChild(panel);
        return panel;
    }

    function stepsOpen() {
        const panel = document.getElementById('nav-mission-steps');
        return Boolean(panel && !panel.hidden);
    }

    function renderSteps() {
        if (!stepsOpen()) return;
        const missionKey = activeMission();
        if (!missionKey) {
            closeSteps();
            return;
        }
        const panel = stepsPanel();
        const mission = MISSIONS[missionKey];
        const view = currentView();
        const title = t(mission.labelKey, mission.fallback);
        panel.setAttribute('aria-label', title);
        const heading = document.createElement('div');
        heading.className = 'nav-mission-steps-title';
        heading.textContent = title;
        const list = document.createElement('ol');
        list.className = 'nav-mission-steps-list';
        mission.steps.forEach((step, index) => {
            const item = document.createElement('li');
            item.className = 'nav-mission-step';
            item.classList.toggle('is-here', step.view === view);
            const number = document.createElement('span');
            number.className = 'nav-mission-step-number';
            number.textContent = String(index + 1);
            const body = document.createElement('span');
            body.className = 'nav-mission-step-body';
            const name = document.createElement('strong');
            name.textContent = t(`${step.key}.title`, step.title);
            const hint = document.createElement('span');
            hint.textContent = t(`${step.key}.hint`, step.hint);
            body.append(name, hint);
            item.append(number, body);
            list.appendChild(item);
        });
        panel.replaceChildren(heading, list);
        positionSteps(panel);
    }

    function positionSteps(panel) {
        const chip = document.getElementById('nav-mission-chip');
        if (!chip || chip.hidden) return;
        const rect = chip.getBoundingClientRect();
        const left = Math.min(rect.left, window.innerWidth - panel.offsetWidth - 12);
        panel.style.top = `${Math.round(rect.bottom + 8)}px`;
        panel.style.left = `${Math.round(Math.max(12, left))}px`;
    }

    function openSteps() {
        if (!activeMission()) return;
        stepsPanel().hidden = false;
        document.getElementById('nav-mission-chip-label')?.setAttribute('aria-expanded', 'true');
        renderSteps();
    }

    function closeSteps() {
        const panel = document.getElementById('nav-mission-steps');
        if (panel) panel.hidden = true;
        document.getElementById('nav-mission-chip-label')?.setAttribute('aria-expanded', 'false');
    }

    function wireSteps() {
        const label = document.getElementById('nav-mission-chip-label');
        if (label) {
            label.addEventListener('click', () => {
                if (stepsOpen()) closeSteps();
                else openSteps();
            });
        }
        // Capture-phase pointerdown: canvases (Censor Edit) stop their clicks
        // from bubbling, and a click there must still close the panel.
        window.addEventListener('pointerdown', (event) => {
            if (!stepsOpen()) return;
            const target = event.target;
            if (target?.closest?.('#nav-mission-steps, #nav-mission-chip-label')) return;
            closeSteps();
        }, true);
        // Window capture runs before the entry page's Esc-to-home handler; the
        // prevented event tells it this Esc was spent closing the panel.
        window.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !stepsOpen()) return;
            event.preventDefault();
            closeSteps();
        }, true);
        window.addEventListener('resize', () => {
            if (stepsOpen()) positionSteps(stepsPanel());
        });
    }

    function currentView() {
        const active = document.querySelector('.nav-tab.active[data-view]');
        return active ? active.dataset.view : null;
    }

    function renderStepBadges(missionTabs) {
        ALL_VIEWS.forEach((view) => {
            const tab = document.getElementById(`nav-tab-${view}`);
            if (!tab) return;
            const existing = tab.querySelector('.nav-step-badge');
            const step = missionTabs ? missionTabs.indexOf(view) : -1;
            if (step === -1) {
                if (existing) existing.remove();
                return;
            }
            if (existing) {
                existing.textContent = String(step + 1);
                return;
            }
            const badge = document.createElement('span');
            badge.className = 'nav-step-badge';
            badge.setAttribute('aria-hidden', 'true');
            badge.textContent = String(step + 1);
            tab.insertBefore(badge, tab.firstChild);
        });
    }

    function renderChip(missionKey) {
        const chip = document.getElementById('nav-mission-chip');
        if (!chip) return;
        if (!missionKey) {
            chip.hidden = true;
            return;
        }
        const mission = MISSIONS[missionKey];
        const label = document.getElementById('nav-mission-chip-label');
        if (label) label.textContent = t(mission.labelKey, mission.fallback);
        chip.hidden = false;
    }

    // The bar follows the saved order: chosen tabs right after the Library, in
    // order; the rest keep their places behind them. Nodes only move when they
    // are out of place, so a re-apply on every tab click is not a DOM churn.
    function orderTabs(order) {
        let anchor = document.getElementById('nav-tab-gallery');
        if (!anchor) return;
        order.forEach((view) => {
            const tab = LOCKED_TABS.includes(view) ? null : document.getElementById(`nav-tab-${view}`);
            if (!tab) return;
            if (anchor.nextElementSibling !== tab) anchor.after(tab);
            anchor = tab;
        });
    }

    // The Gallery's batch bar leads with the step the mission asks for next:
    // LoRA sends the pick to the Dataset Maker, Pixiv to Censor Edit. Anything
    // else leads with Move. The Dataset Maker button lives in the More menu
    // until promoted; it is moved, never copied, so its handler stays bound.
    const ACTION_BAR_PRIMARY = { lora: 'btn-send-selection-to-dataset-maker', pixiv: 'btn-send-to-censor' };
    const ACTION_BAR_LEADERS = ['btn-move-selected', 'btn-send-to-censor', 'btn-send-selection-to-dataset-maker'];

    function syncActionBar(missionKey) {
        const buttons = document.querySelector('#gallery-action-bar .gallery-action-bar-buttons');
        const menu = document.getElementById('gallery-action-more-menu');
        const dataset = document.getElementById('btn-send-selection-to-dataset-maker');
        const move = document.getElementById('btn-move-selected');
        if (!buttons || !menu || !dataset || !move) return;

        const primaryId = ACTION_BAR_PRIMARY[missionKey] || 'btn-move-selected';
        if (primaryId === dataset.id) {
            if (dataset.parentElement !== buttons) buttons.insertBefore(dataset, buttons.firstElementChild);
        } else if (dataset.parentElement !== menu) {
            const copy = document.getElementById('btn-copy-selected');
            menu.insertBefore(dataset, copy ? copy.nextSibling : menu.firstChild);
        }
        ACTION_BAR_LEADERS.forEach((id) => {
            const button = document.getElementById(id);
            if (!button) return;
            const isPrimary = id === primaryId;
            const inBar = button.parentElement === buttons;
            button.classList.toggle('btn-primary', isPrimary);
            button.classList.toggle('btn-secondary', !isPrimary && inBar);
            button.classList.toggle('btn-ghost', !isPrimary && !inBar);
            // The promoted button leads the row; the rest keep their order.
            button.style.order = isPrimary ? '-1' : '';
        });
    }

    function apply() {
        const missionKey = activeMission();
        syncActionBar(missionKey);
        orderTabs(baseTabs());
        const visible = missionKey ? MISSIONS[missionKey].tabs.slice() : baseTabs();
        const active = currentView();
        if (active && !visible.includes(active)) visible.push(active);

        ALL_VIEWS.forEach((view) => {
            const tab = document.getElementById(`nav-tab-${view}`);
            if (tab) tab.classList.toggle('nav-tab-tucked', !visible.includes(view));
        });

        document.querySelectorAll('[data-mirror-view]').forEach((mirror) => {
            const view = mirror.dataset.mirrorView;
            // Only mirrors whose tab this module alone decides. The width ladder
            // can also take away the advanced tools (Reverse Prompt, Prompt
            // Helper, Style Finder) on a narrow bar, so `visible` says nothing
            // about whether their tab is on screen; hiding on that basis removed
            // their only entrance. Their mirrors' CSS rules own visibility.
            const tab = document.getElementById(`nav-tab-${view}`);
            if (!ALL_VIEWS.includes(view) || tab?.matches('.nav-priority-tool, .nav-priority-advanced')) return;
            mirror.hidden = visible.includes(view);
        });

        renderStepBadges(missionKey ? MISSIONS[missionKey].tabs : null);
        renderChip(missionKey);
        renderSteps();

        // The width-degradation ladder re-measures on resize (app.js binds it
        // there); tab visibility changes shift scrollWidth the same way.
        window.dispatchEvent(new Event('resize'));
    }

    // ------------------------------------------------------------------
    // Customize modal (自定义标签栏)
    // ------------------------------------------------------------------

    function moveButton(view, label, direction) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn btn-ghost btn-small btn-icon-only nav-customize-${direction}`;
        button.dataset.customMove = direction;
        button.dataset.customView = view;
        const text = direction === 'up'
            ? t('navCustom.moveUp', 'Move up')
            : t('navCustom.moveDown', 'Move down');
        button.title = text;
        button.setAttribute('aria-label', `${text}: ${label}`);
        button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-arrow-up"/></svg>';
        return button;
    }

    // One row per view, built from its own nav tab so the icon and name always
    // match the bar: the Library (fixed, first), the chosen views in bar
    // order with up/down, then the views waiting under More.
    function customizeRow(view, chosen, index) {
        const tab = document.getElementById(`nav-tab-${view}`);
        const labelKey = tab?.querySelector('.tab-text')?.dataset.i18n || `nav.${view}`;
        const label = t(labelKey, view);
        const locked = LOCKED_TABS.includes(view);
        const on = locked || chosen.includes(view);

        const row = document.createElement('div');
        row.className = 'nav-customize-row';
        row.classList.toggle('is-on', on);
        row.classList.toggle('is-locked', locked);
        row.dataset.customRow = view;

        const pick = document.createElement('label');
        pick.className = 'nav-customize-pick';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.customView = view;
        box.checked = on;
        box.disabled = locked;
        const icon = document.createElement('span');
        icon.className = 'row-icon';
        icon.setAttribute('aria-hidden', 'true');
        const iconHref = tab?.querySelector('use')?.getAttribute('href') || '#i-image';
        icon.innerHTML = `<svg class="icon" aria-hidden="true"><use href="${iconHref}"/></svg>`;
        const name = document.createElement('span');
        name.textContent = label;
        pick.append(box, icon, name);
        row.appendChild(pick);

        const side = document.createElement('span');
        side.className = 'nav-customize-move';
        if (locked) {
            side.classList.add('nav-customize-note');
            side.textContent = t('navCustom.galleryFixed', 'Always first');
        } else {
            const up = moveButton(view, label, 'up');
            const down = moveButton(view, label, 'down');
            up.disabled = !on || index === 0;
            down.disabled = !on || index === chosen.length - 1;
            side.append(up, down);
        }
        row.appendChild(side);
        return row;
    }

    function renderCustomize() {
        const list = document.getElementById('nav-customize-list');
        if (!list) return;
        const chosen = baseTabs().filter((view) => !LOCKED_TABS.includes(view));
        const rest = CUSTOM_VIEWS.filter((view) => !chosen.includes(view));
        list.replaceChildren(
            ...LOCKED_TABS.map((view) => customizeRow(view, chosen, -1)),
            ...chosen.map((view, index) => customizeRow(view, chosen, index)),
            ...rest.map((view) => customizeRow(view, chosen, -1)),
        );
    }

    function saveCustomize(chosen, focusSelector) {
        setBaseTabs([...LOCKED_TABS, ...chosen]);
        renderCustomize();
        if (focusSelector) document.querySelector(`#nav-customize-list ${focusSelector}`)?.focus();
    }

    function toggleView(view, on) {
        const chosen = baseTabs().filter((item) => !LOCKED_TABS.includes(item) && item !== view);
        if (on) chosen.push(view);
        saveCustomize(chosen, `input[data-custom-view="${view}"]`);
    }

    function moveView(view, direction) {
        const chosen = baseTabs().filter((item) => !LOCKED_TABS.includes(item));
        const from = chosen.indexOf(view);
        const to = from + (direction === 'up' ? -1 : 1);
        if (from === -1 || to < 0 || to >= chosen.length) return;
        [chosen[from], chosen[to]] = [chosen[to], chosen[from]];
        // Keep the keyboard on the arrow that was pressed, or on the other one
        // once the row reaches an end and this arrow turns off.
        const other = direction === 'up' ? 'down' : 'up';
        const atEnd = to === 0 || to === chosen.length - 1;
        saveCustomize(chosen, `[data-custom-view="${view}"][data-custom-move="${atEnd ? other : direction}"]`);
    }

    function openCustomize() {
        const modal = document.getElementById('nav-customize-modal');
        if (!modal) return;
        renderCustomize();
        modal.classList.add('visible');
    }

    function closeCustomize() {
        const modal = document.getElementById('nav-customize-modal');
        if (modal) modal.classList.remove('visible');
    }

    function wireCustomize() {
        const opener = document.getElementById('nav-tools-customize');
        if (opener) {
            opener.addEventListener('click', () => {
                if (typeof window._closeNavToolsMenu === 'function') window._closeNavToolsMenu();
                openCustomize();
            });
        }
        const modal = document.getElementById('nav-customize-modal');
        if (!modal) return;
        const list = document.getElementById('nav-customize-list');
        if (list) {
            list.addEventListener('change', (event) => {
                const box = event.target.closest('input[data-custom-view]');
                if (box && !box.disabled) toggleView(box.dataset.customView, box.checked);
            });
            list.addEventListener('click', (event) => {
                const button = event.target.closest('button[data-custom-move]');
                if (button && !button.disabled) moveView(button.dataset.customView, button.dataset.customMove);
            });
        }
        const reset = document.getElementById('nav-customize-reset');
        if (reset) {
            reset.addEventListener('click', () => {
                setBaseTabs(DEFAULT_TABS.slice());
                renderCustomize();
            });
        }
        const close = document.getElementById('nav-customize-close');
        if (close) close.addEventListener('click', closeCustomize);
        const backdrop = modal.querySelector('.modal-backdrop');
        if (backdrop) backdrop.addEventListener('click', closeCustomize);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && modal.classList.contains('visible')) {
                event.stopPropagation();
                closeCustomize();
            }
        }, true);
    }

    // ------------------------------------------------------------------
    // Boot
    // ------------------------------------------------------------------

    function wire() {
        document.querySelectorAll('[data-mirror-view]').forEach((mirror) => {
            mirror.addEventListener('click', () => {
                const tab = document.getElementById(`nav-tab-${mirror.dataset.mirrorView}`);
                if (tab) tab.click();
                if (typeof window._closeNavToolsMenu === 'function') window._closeNavToolsMenu();
            });
        });

        const exitButton = document.getElementById('nav-mission-exit');
        if (exitButton) exitButton.addEventListener('click', exit);

        // Contextual reveal: any tab activation (direct click, entry-page
        // navigate, mirror proxy) may change the active view — re-apply on
        // the next frame so the new view's tab is shown.
        document.addEventListener('click', (event) => {
            if (event.target && event.target.closest && event.target.closest('.nav-tab[data-view]')) {
                window.requestAnimationFrame(apply);
            }
        });

        window.addEventListener('languageChanged', () => {
            renderChip(activeMission());
            renderSteps();
            renderCustomize();
        });

        wireCustomize();
        wireSteps();
        apply();
        renderCustomize();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }

    window.NavMissions = { enter, exit, activeMission, apply, baseTabs, setBaseTabs, MISSIONS };
})();
