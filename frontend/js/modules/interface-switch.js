/**
 * Interface switch: the classic UI and Vopus work on one backend and library.
 *
 * Settings › General offers the other interface. The choice is remembered on
 * the backend (PUT /api/interface), so every browser and every launch opens
 * that one at "/"; Vopus's own Settings switches back. The catalog row calls
 * the same function (DESIGN rule 11).
 */
(function () {
    'use strict';

    function t(key, params, fallback) {
        const value = window.I18n && window.I18n.t ? window.I18n.t(key, params) : null;
        if (value && value !== key) return value;
        let text = fallback || key;
        Object.entries(params || {}).forEach(([name, val]) => {
            text = text.replace(new RegExp('\\{' + name + '\\}', 'g'), String(val));
        });
        return text;
    }

    function el(id) {
        return document.getElementById(id);
    }

    async function readChoice() {
        const res = await fetch('/api/interface');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    function render(state) {
        const button = el('btn-settings-interface');
        const note = el('settings-interface-note');
        if (!button) return;
        const built = !!(state && state.vopus_built);
        button.disabled = !built;
        if (note) note.hidden = built;
    }

    async function useVopus() {
        let res;
        try {
            res = await fetch('/api/interface', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ interface: 'vopus' }),
            });
        } catch (err) {
            res = null;
        }
        if (!res || !res.ok) {
            let detail = res ? `HTTP ${res.status}` : t('settings.interfaceOffline', {}, 'the program did not answer');
            try {
                const body = res ? await res.json() : null;
                if (body && typeof body.detail === 'string') detail = body.detail;
            } catch (err) { /* keep the status text */ }
            window.App?.showToast?.(
                t('settings.interfaceFailed', { detail }, `Could not switch the interface: ${detail}`),
                'error',
            );
            if (res && res.status === 409) render({ vopus_built: false });
            return;
        }
        window.location.assign('/vopus/');
    }

    function wire() {
        const button = el('btn-settings-interface');
        if (button) button.addEventListener('click', () => { void useVopus(); });
        // Unread, the row keeps its markup default (button on, note hidden); a
        // click then reports the real failure.
        readChoice().then(render).catch((err) => {
            window.Logger?.warn?.('InterfaceSwitch: could not read the interface choice', err);
        });
    }

    window.InterfaceSwitch = { useVopus, refresh: () => readChoice().then(render) };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire, { once: true });
    } else {
        wire();
    }
})();
