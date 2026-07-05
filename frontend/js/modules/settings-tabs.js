/**
 * Settings & Models modal — section tabs (v3.5.0 audit, design rule 6).
 *
 * The modal used to stack settings + model grid + disk usage + dataset
 * audit into one 3000-4700px scrolling column. Four tabs (#settings-modal-tabs)
 * now show one area at a time; panels are plain wrapper divs carrying
 * data-settings-panel, so every existing element id (model grid, disk body,
 * audit section, reparse button, ...) is untouched and all render code
 * keeps working.
 */
(function () {
    'use strict';

    function activate(tabName) {
        const bar = document.getElementById('settings-modal-tabs');
        if (!bar) return;
        bar.querySelectorAll('.settings-modal-tab').forEach((button) => {
            const isActive = button.dataset.settingsTab === tabName;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', String(isActive));
        });
        document.querySelectorAll('#model-manager-modal [data-settings-panel]').forEach((panel) => {
            panel.hidden = panel.dataset.settingsPanel !== tabName;
        });
        const modalContent = document.querySelector('#model-manager-modal .modal-content');
        if (modalContent) modalContent.scrollTop = 0;

        if (tabName === 'audit') {
            // The audit <details> stays for its summary copy, but inside a
            // dedicated tab it should just be open; its lazy-init listens
            // for this toggle (bindDatasetAuditLazyInit in app.js).
            const details = document.getElementById('audit-section');
            if (details && !details.open) details.open = true;
            else if (window.LibraryHealth && typeof window.LibraryHealth.init === 'function') {
                window.LibraryHealth.init();
            }
        }
    }

    function wire() {
        const bar = document.getElementById('settings-modal-tabs');
        if (!bar || bar.dataset.tabsBound === '1') return;
        bar.dataset.tabsBound = '1';
        bar.addEventListener('click', (event) => {
            const button = event.target.closest('[data-settings-tab]');
            if (!button) return;
            activate(button.dataset.settingsTab);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }

    window.SettingsTabs = { activate };
})();
