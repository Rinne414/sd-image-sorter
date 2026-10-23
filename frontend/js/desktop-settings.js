/**
 * Settings > Desktop (classic): only inside the desktop shell. Start at login,
 * keep running in the tray when the window is closed, the global shortcut,
 * and a button for Quick collect. Values live in the shell
 * (data/config/desktop-shell.json, start at login in the OS); this module
 * reads and writes them through window.sdDesktop (desktop-bridge.js starts it).
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

    window.DesktopSettings = { start, acceleratorFrom, displayShortcut };
})();
