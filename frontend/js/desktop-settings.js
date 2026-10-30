/**
 * Settings > Desktop (classic): only inside the desktop shell. Start at login,
 * keep running in the tray when the window is closed, the global shortcut,
 * and a button for Quick collect. Values live in the shell
 * (data/config/desktop-shell.json, start at login in the OS); this module
 * reads and writes them through window.sdDesktop (desktop-bridge.js starts it).
 * In a browser on Windows a separate note says where the desktop program is,
 * or how to get it when this folder has none.
 */
(function () {
    'use strict';

    const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS']);
    const CODE_NAMES = {
        Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
        Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
        ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    };

    let ctx = null;
    let current = null;

    const el = (id) => document.getElementById(id);

    /** "Control+Alt+Space" -> "Ctrl+Alt+Space" for display. */
    function displayShortcut(accelerator) {
        return String(accelerator || '').replace(/Control/g, 'Ctrl').replace(/Super/g, 'Win');
    }

    function keyName(event) {
        const code = event.code || '';
        if (/^Key[A-Z]$/.test(code)) return code.slice(3);
        if (/^Digit[0-9]$/.test(code)) return code.slice(5);
        if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
        return CODE_NAMES[code] || null;
    }

    /** A pressed combination as an accelerator, or null while only modifiers are down. */
    function acceleratorFrom(event) {
        if (MODIFIER_KEYS.has(event.key)) return null;
        const key = keyName(event);
        if (!key) return null;
        const parts = [];
        if (event.ctrlKey) parts.push('Control');
        if (event.altKey) parts.push('Alt');
        if (event.shiftKey) parts.push('Shift');
        if (event.metaKey) parts.push('Super');
        if (!parts.length) return null;
        return [...parts, key].join('+');
    }

    function setToggle(buttonId, labelId, on) {
        const button = el(buttonId);
        const label = el(labelId);
        if (!button || !label) return;
        button.setAttribute('aria-pressed', String(on));
        // Move the key with the words: the i18n pass re-applies data-i18n.
        label.dataset.i18n = on ? 'desktop.on' : 'desktop.off';
        label.textContent = on ? ctx.t('desktop.on', 'On') : ctx.t('desktop.off', 'Off');
    }

    function shortcutStatus(settings) {
        const status = el('settings-desktop-shortcut-status');
        if (!status) return;
        let key = 'desktop.shortcutBody';
        let fallback = 'Works from any program and puts the cursor in the gallery search. Click the box, then press the keys.';
        if (!settings.shortcutOk && settings.shortcutReason === 'refused') {
            key = 'desktop.shortcutRefused';
            fallback = 'The system refused this shortcut: another program probably uses it. Press another one.';
        } else if (!settings.shortcutOk) {
            key = 'desktop.shortcutInvalid';
            fallback = 'This is not a shortcut the program can use. Press a key together with Ctrl, Alt or Win.';
        }
        status.dataset.i18n = key;
        status.textContent = ctx.t(key, fallback);
        status.classList.toggle('settings-desktop-error', !settings.shortcutOk);
    }

    function render(settings) {
        current = settings;
        setToggle('btn-settings-desktop-login', 'settings-desktop-login-label', Boolean(settings.startAtLogin));
        setToggle('btn-settings-desktop-close', 'settings-desktop-close-label', Boolean(settings.closeToTray));
        const input = el('settings-desktop-shortcut');
        if (input && document.activeElement !== input) input.value = displayShortcut(settings.shortcut);
        shortcutStatus(settings);
    }

    async function change(key, value) {
        try {
            render(await ctx.desktop.setSetting(key, value));
        } catch (error) {
            if (typeof showToast === 'function') {
                showToast(ctx.t('desktop.settingFailed', 'Could not change this setting: {error}', { error: error?.message || String(error) }), 'error');
            }
        }
    }

    async function refresh() {
        try {
            render(await ctx.desktop.getSettings());
        } catch (_error) {
            // The shell answers only the program's own page; nothing to show otherwise.
        }
    }

    function onShortcutKeydown(event) {
        const input = event.currentTarget;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            input.blur();
            return;
        }
        if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
        event.preventDefault();
        const accelerator = acceleratorFrom(event);
        if (!accelerator) return;
        input.value = displayShortcut(accelerator);
        change('shortcut', accelerator);
    }

    function bind() {
        el('btn-settings-desktop-login')?.addEventListener('click', () => change('startAtLogin', !current?.startAtLogin));
        el('btn-settings-desktop-close')?.addEventListener('click', () => change('closeToTray', !current?.closeToTray));
        el('btn-settings-desktop-quick-collect')?.addEventListener('click', () => ctx.openQuickCollect());
        el('btn-settings-desktop-shortcut-reset')?.addEventListener('click', () => change('shortcut', ctx.DEFAULT_SHORTCUT));
        const input = el('settings-desktop-shortcut');
        input?.addEventListener('keydown', onShortcutKeydown);
        input?.addEventListener('blur', () => { if (current) input.value = displayShortcut(current.shortcut); });
        window.addEventListener('focus', refresh);
    }

    function start(desktop, options) {
        const panel = el('settings-desktop-panel');
        if (!panel || ctx) return;
        ctx = { desktop, ...options };
        panel.hidden = false;
        bind();
        refresh();
    }

    /**
     * In a browser on Windows: say where the desktop program is, or, when this
     * folder has none (in-app updates never install it), how to get it.
     */
    async function showBrowserNote() {
        const panel = el('settings-desktop-browser');
        if (!panel || window.sdDesktop) return;
        let state = null;
        try {
            const response = await fetch('/api/updates/desktop-program', { headers: { Accept: 'application/json' } });
            state = response.ok ? await response.json() : null;
        } catch (_error) {
            state = null;
        }
        if (!state?.windows || window.sdDesktop) return;
        const t = (key, fallback) => {
            const value = window.I18n?.t?.(key);
            return value && value !== key ? value : fallback;
        };
        let words;
        if (state.installed) {
            words = ['desktop.browserHereTitle', 'The desktop program is in this folder',
                'desktop.browserHereBody', 'Double-click SD Image Sorter.exe in the program folder. The tray, start at login and the global shortcut are set there.'];
        } else if (state.portable) {
            words = ['desktop.browserMissingTitle', 'The desktop program is not in this folder',
                'desktop.browserMissingBody', 'In-app updates do not install the desktop program (tray, start at login, global shortcut). To get it: quit the program, download the full Windows package, extract it into this folder and replace the files, then double-click SD Image Sorter.exe. Your library, settings and models are in the data folder, which the package does not contain, so they stay.'];
        } else {
            // Run from the source code: the desktop program comes only with the full package.
            words = ['desktop.browserMissingTitle', 'The desktop program is not in this folder',
                'desktop.browserSourceBody', 'The desktop program (tray, start at login, global shortcut) comes with the full Windows package; running from the source code has none.'];
        }
        // Move the keys with the words: the i18n pass re-applies data-i18n.
        [['settings-desktop-browser-heading', 0], ['settings-desktop-browser-body', 2]].forEach(([id, at]) => {
            const node = el(id);
            if (!node) return;
            node.dataset.i18n = words[at];
            node.textContent = t(words[at], words[at + 1]);
        });
        const download = el('btn-settings-desktop-download');
        if (download) {
            download.hidden = Boolean(state.installed);
            download.onclick = () => window.open(state.download_url, '_blank', 'noopener');
        }
        panel.hidden = false;
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showBrowserNote);
    else showBrowserNote();

    window.DesktopSettings = { start, acceleratorFrom, displayShortcut };
})();
