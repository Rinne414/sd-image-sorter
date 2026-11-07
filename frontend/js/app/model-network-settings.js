/**
 * Model Center: the download source, the model-source folders and the network
 * proxy sit in one folded section under the cards' toolbar. Its one-line
 * summary says their state in plain words (download source: auto - model
 * sources: 2 folders - proxy: not set); it opens by itself when one of them
 * needs attention (a missing folder, the "found ComfyUI" question, a proxy
 * that could not be read) and otherwise remembers whether the person left it
 * open or closed.
 *
 * Each block reports its state here with set(); nothing here reads the
 * backend. Classic script; globals used: appT.
 */
(function () {
    'use strict';

    const OPEN_KEY = 'sd-image-sorter-model-network-open';
    const parts = { mirror: null, sources: null, proxy: null };
    const state = { bound: false, hadAttention: false, expected: null };

    function host() {
        return document.getElementById('model-network-settings');
    }

    function readOpen() {
        try {
            return localStorage.getItem(OPEN_KEY) === '1';
        } catch (_error) {
            return false;
        }
    }

    function writeOpen(open) {
        try {
            localStorage.setItem(OPEN_KEY, open ? '1' : '0');
        } catch (_error) {
            // Private mode: it starts folded next time.
        }
    }

    function mirrorText() {
        if (!parts.mirror) return '';
        const names = {
            auto: ['models.net.mirrorAuto', 'Auto'],
            'hf-mirror': ['models.net.mirrorHf', 'hf-mirror'],
            modelscope: ['models.net.mirrorMs', 'ModelScope'],
        };
        const [key, fallback] = names[parts.mirror.value] || [null, String(parts.mirror.value || '')];
        const value = key ? appT(key, fallback) : fallback;
        return appT('models.net.mirror', 'Download source: {value}', { value });
    }

    function sourcesText() {
        if (!parts.sources) return '';
        const count = Number(parts.sources.count) || 0;
        if (count === 0) return appT('models.net.sourcesNone', 'Model sources: none added');
        if (count === 1) return appT('models.net.sourcesOne', 'Model sources: 1 folder');
        return appT('models.net.sourcesMany', 'Model sources: {count} folders', { count });
    }

    function proxyText() {
        if (!parts.proxy) return '';
        return parts.proxy.address
            ? appT('models.net.proxySet', 'Proxy: {address}', { address: parts.proxy.address })
            : appT('models.net.proxyNone', 'Proxy: not set');
    }

    function needsAttention() {
        return Object.values(parts).some((part) => Boolean(part && part.attention));
    }

    function setOpen(open) {
        const details = host();
        if (!details || details.open === open) return;
        // The toggle event for this change must not be remembered as the person's choice.
        state.expected = open;
        details.open = open;
    }

    function renderSummary() {
        const stateEl = document.getElementById('model-network-state');
        if (!stateEl) return;
        stateEl.textContent = [mirrorText(), sourcesText(), proxyText()].filter(Boolean).join(' · ');
        stateEl.title = stateEl.textContent;
        const flagged = needsAttention();
        let flag = stateEl.parentElement.querySelector('.model-network-flag');
        if (flagged && !flag) {
            flag = document.createElement('span');
            flag.className = 'model-network-flag';
            stateEl.insertAdjacentElement('afterend', flag);
        }
        if (flag) {
            if (flagged) flag.textContent = appT('models.net.attention', 'Needs a look');
            else flag.remove();
        }
    }

    function bind() {
        const details = host();
        if (!details || state.bound) return;
        state.bound = true;
        details.open = readOpen();
        details.addEventListener('toggle', () => {
            if (state.expected === details.open) {
                state.expected = null;
                return;
            }
            writeOpen(details.open);
        });
        document.addEventListener('languageChanged', renderSummary);
    }

    /** One block reports its state: { value } for the mirror, { count, attention }, { address, attention }. */
    function set(part, data) {
        bind();
        parts[part] = data;
        renderSummary();
        const flagged = needsAttention();
        // Open once when something starts needing attention; the person may close it again.
        if (flagged && !state.hadAttention) setOpen(true);
        state.hadAttention = flagged;
    }

    /** Opens the section (without changing what it remembers); the Ctrl K entries call this. */
    function reveal() {
        bind();
        setOpen(true);
        return host();
    }

    /** Each time the Model Center opens, a block that still needs attention may open the section again. */
    function arm() {
        state.hadAttention = false;
    }

    window.ModelNetworkSettings = { set, reveal, arm };
})();
