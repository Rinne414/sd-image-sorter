/**
 * manual-sort/boot-touch.js — manual-sort.js decomposition (the boot).
 * Extracted VERBATIM (byte-identical) from frontend/js/manual-sort.js,
 * pre-split lines 3576-3731: the DOMContentLoaded → initManualSort boot, the
 * window.* exports, TOUCH_BUTTONS / createTouchControls / handleTouchControl
 * (mobile touch controls — consumer-less today, kept verbatim per the
 * desktop-only rule) and redoLastAction. Classic script: this tag loads LAST
 * in the family so every export referent (hoisted functions from the earlier
 * files + the base consts) is defined when the exports run.
 */
// ============== Initialize ==============

document.addEventListener('DOMContentLoaded', () => {
    initManualSort();
});

// Export for use by app.js and filter modal
window.ManualSortState = ManualSortState;
window.updateManualSortFilterSummary = updateManualSortFilterSummary;
window.maybeAdoptManualSortFiltersFromGallery = maybeAdoptManualSortFiltersFromGallery;
// Exposed so the sorting sub-tab switch (inline in index.html) can refresh the
// live scoped count the moment the Manual Sort setup becomes visible.
window.refreshManualSortScopeCount = refreshManualSortScopeCount;

// ============== Touch Controls for Mobile ==============

// Touch control button mapping
const TOUCH_BUTTONS = [
    { key: 'w', label: 'W', icon: '↑', action: 'move', folderKey: 'w' },
    { key: 'a', label: 'A', icon: '←', action: 'move', folderKey: 'a' },
    { key: 's', label: 'S', icon: '↓', action: 'move', folderKey: 's' },
    { key: 'd', label: 'D', icon: '→', action: 'move', folderKey: 'd' }
];

function createTouchControls() {
    const container = document.querySelector('.sort-interface');
    if (!container) return;
    
    // Check if already created
    if (document.getElementById('touch-sort-controls')) return;
    
    const touchControls = document.createElement('div');
    touchControls.id = 'touch-sort-controls';
    touchControls.className = 'touch-sort-controls';
    
    touchControls.innerHTML = `
        <button class="touch-sort-btn" data-key="w" aria-label="Move to W folder">
            <span class="key-label">W</span>
            <span>↑</span>
        </button>
        <button class="touch-sort-btn" data-key="a" aria-label="Move to A folder">
            <span class="key-label">A</span>
            <span>←</span>
        </button>
        <button class="touch-sort-btn btn-undo" data-action="undo" aria-label="Undo last action">
            <span class="key-label">Z</span>
            <span>Undo</span>
        </button>
        <button class="touch-sort-btn btn-redo" data-action="redo" aria-label="Redo last undone action">
            <span class="key-label">Y</span>
            <span>Redo</span>
        </button>
        <button class="touch-sort-btn" data-key="s" aria-label="Move to S folder">
            <span class="key-label">S</span>
            <span>↓</span>
        </button>
        <button class="touch-sort-btn" data-key="d" aria-label="Move to D folder">
            <span class="key-label">D</span>
            <span>→</span>
        </button>
        <button class="touch-sort-btn btn-skip" data-action="skip" aria-label="Skip current image">
            <span class="key-label">Space</span>
            <span>Skip</span>
        </button>
        <button class="touch-sort-btn btn-undo" data-action="exit" aria-label="Exit sorting">
            <span class="key-label">Esc</span>
            <span>Exit</span>
        </button>
    `;
    
    container.appendChild(touchControls);
    
    // Add event listeners
    touchControls.querySelectorAll('.touch-sort-btn').forEach(btn => {
        btn.addEventListener('click', handleTouchControl);
    });

    updateHistoryControlState();
}

function handleTouchControl(e) {
    if (!ManualSortState.active) return;
    
    const btn = e.currentTarget;
    const key = btn.dataset.key;
    const action = btn.dataset.action;
    
    if (key) {
        performMove(key);
    } else if (action) {
        switch (action) {
            case 'undo':
                undoLastAction();
                break;
            case 'redo':
                redoLastAction();
                break;
            case 'skip':
                performSkip();
                break;
            case 'exit':
                exitSorting();
                break;
        }
    }
}

// Redo functionality
async function redoLastAction() {
    const { API, showToast } = window.App;

    try {
        const result = await API.sortAction('redo');

        if (result.status === 'no_redo') {
            updateHistoryControlState(result);
            showToast(manualSortText('manual.redoEmpty', 'Nothing to redo', '没有可重做的操作'), 'info');
            return;
        }

        if (result.error) {
            updateHistoryControlState(result);
            showToast(result.error, 'error');
            return;
        }

        window.AudioManager?.play('move');
        ManualSortState.actionTimestamps.push(Date.now());
        const cutoff = Date.now() - 30000;
        ManualSortState.actionTimestamps = ManualSortState.actionTimestamps.filter(t => t > cutoff);

        await loadCurrentImage(result);

        if (result.redone_action === 'move' && result.folder_key) {
            showToast(
                formatManualSortI18n(
                    getManualSortOperationMode() === 'copy' ? 'manual.redoCopy' : 'manual.redoMove',
                    getManualSortOperationMode() === 'copy' ? 'Redid copy to {key}' : 'Redid move to {key}',
                    {
                    key: result.folder_key.toUpperCase(),
                    }
                ),
                'info'
            );
        } else {
            showToast(manualSortText('manual.redoSkip', 'Redid skip', '已重做跳过'), 'info');
        }
    } catch (error) {
        Logger.error('Failed to redo:', error);
        showToast(manualSortText('manual.redoFailed', 'Failed to redo', '重做失败'), 'error');
    }
}

// Export touch control functions
window.createTouchControls = createTouchControls;
window.redoLastAction = redoLastAction;
