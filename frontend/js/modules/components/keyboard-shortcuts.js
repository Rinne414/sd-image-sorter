/**
 * SD Image Sorter - Keyboard Shortcuts Panel
 */
const KeyboardShortcutsPanel = (function() {
    const PANEL_ID = 'keyboard-shortcuts-panel';
    const SHORTCUTS = {
        global: [
            { key: '?', description: 'Show this help panel' },
            { key: 'Esc', description: 'Close modal / Cancel action' },
            { key: '1-7', description: 'Switch views' }
        ],
        gallery: [
            { key: 'Arrow Left/Right', description: 'Navigate images' },
            { key: 'Space', description: 'Toggle selection mode' },
            { key: 'R', description: 'Show random image' }
        ],
        manual: [
            { key: 'W/A/S/D', description: 'Move to folder' },
            { key: 'Space', description: 'Skip image' },
            { key: 'Z', description: 'Undo last action' }
        ],
        censor: [
            { key: 'B', description: 'Brush tool' },
            { key: 'E', description: 'Eraser tool' },
            { key: 'C', description: 'Clone stamp' }
        ]
    };
    let isPanelOpen = false;
    let panelElement = null;

    function createPanel() {
        if (panelElement) return panelElement;
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'keyboard-shortcuts-panel';
        panel.setAttribute('role', 'dialog');

        // Build shortcuts HTML from data
        let bodyHtml = '';
        const sectionLabels = { global: '🌐 Global', gallery: '🖼️ Gallery', manual: '🎮 Manual Sort', censor: '🔳 Censor Edit' };
        for (const [section, items] of Object.entries(SHORTCUTS)) {
            bodyHtml += `<div class="shortcuts-group"><h4 class="shortcuts-group-title">${sectionLabels[section] || section}</h4><ul class="shortcuts-list">`;
            bodyHtml += items.map(s =>
                `<li class="shortcut-item"><span class="shortcut-key">${s.key}</span><span class="shortcut-description">${s.description}</span></li>`
            ).join('');
            bodyHtml += '</ul></div>';
        }

        panel.innerHTML = `
            <div class="shortcuts-panel-content">
                <div class="shortcuts-panel-header">
                    <h3>⌨️ Keyboard Shortcuts</h3>
                    <button class="shortcuts-panel-close">&times;</button>
                </div>
                <div class="shortcuts-panel-body">${bodyHtml}</div>
                <div class="shortcuts-panel-footer">
                    <p>Press <kbd>?</kbd> anytime to show this panel</p>
                </div>
            </div>`;
        panel.querySelector('.shortcuts-panel-close').addEventListener('click', hide);
        panel.addEventListener('click', function(e) { if (e.target === panel) hide(); });
        document.body.appendChild(panel);
        panelElement = panel;
        return panel;
    }

    function show() {
        if (isPanelOpen) return;
        createPanel();
        panelElement.classList.add('visible');
        isPanelOpen = true;
        document.addEventListener('keydown', handleKeydown);
    }

    function hide() {
        if (!isPanelOpen || !panelElement) return;
        panelElement.classList.remove('visible');
        isPanelOpen = false;
        document.removeEventListener('keydown', handleKeydown);
    }

    function handleKeydown(e) {
        if (e.key === 'Escape') hide();
    }

    function init() {
        document.addEventListener('keydown', function(e) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key === '?' && !isPanelOpen) { e.preventDefault(); show(); }
        });
        const helpBtn = document.getElementById('btn-help');
        if (helpBtn) helpBtn.addEventListener('click', show);
    }

    return { init: init, show: show, hide: hide, SHORTCUTS: SHORTCUTS };
})();
document.addEventListener('DOMContentLoaded', KeyboardShortcutsPanel.init);
window.KeyboardShortcutsPanel = KeyboardShortcutsPanel;
