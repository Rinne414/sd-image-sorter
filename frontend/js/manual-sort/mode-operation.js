/**
 * manual-sort/mode-operation.js — manual-sort.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/manual-sort.js,
 * pre-split lines 95-171 + 211-267: the workbench-mode helpers (selected-mode
 * get/set, start/mode labels, bindManualSortModeSwitch) and the operation-mode
 * helpers (normalize/get/set + labels/verbs; the copy-first safety default is
 * locked by Principle #11 and release-build contract pins). Classic script:
 * loads after manual-sort/state-constants.js (base).
 */
// ============== Workbench Mode (v3.3.2 WB-S3) ==============

// The mode selected on the setup screen for the NEXT session. Persisted so the
// choice survives reloads. ManualSortState.mode tracks the ACTIVE session's mode.
function getManualSortSelectedMode() {
    try {
        const stored = localStorage.getItem(MANUAL_SORT_MODE_KEY);
        if (stored && MANUAL_SORT_MODES.has(stored)) return stored;
    } catch (_) { /* ignore storage errors */ }
    return 'slot';
}

// The start-button label depends on the chosen mode. Shares its shape with
// ui-refresh.js (whose MutationObserver re-applies the label after rebuilding
// the button), so both must agree on the per-mode text.
function getManualSortStartLabel(mode) {
    if (mode === 'bracket') return manualSortText('manual.startShowdown', 'Start Showdown', '开始擂台');
    if (mode === 'cull') return manualSortText('manual.startCulling', 'Start Culling', '开始留汰');
    return manualSortText('manual.startSorting', 'Start Sorting', '开始排序');
}

// Human name for a sort mode, used when a start action collides with a saved
// session from a DIFFERENT mode (the cross-mode confirm below).
function getManualSortModeLabel(mode) {
    if (mode === 'bracket') return manualSortText('manual.modeBracket', 'A/B Showdown', 'A/B 擂台');
    if (mode === 'cull') return manualSortText('manual.modeCull', 'Keep / Reject', '留 / 汰');
    return manualSortText('manual.modeSlot', 'Slot Sorting (WASD)', '槽位整理（WASD）');
}

// Reflect the chosen mode in the setup UI: highlight the button, toggle the
// slot-only vs bracket-only vs cull-only blocks, and relabel the start button.
// Never touches an active session (mode is locked once sorting starts).
function setManualSortSelectedMode(mode, { persist = true } = {}) {
    const normalized = MANUAL_SORT_MODES.has(mode) ? mode : 'slot';
    if (persist) {
        try { localStorage.setItem(MANUAL_SORT_MODE_KEY, normalized); } catch (_) { /* ignore */ }
    }

    document.querySelectorAll('.sort-mode-btn[data-sort-mode]').forEach((btn) => {
        const isActive = btn.dataset.sortMode === normalized;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
    });

    document.querySelectorAll('.sort-slot-only').forEach((el) => {
        el.style.display = normalized === 'slot' ? '' : 'none';
    });
    document.querySelectorAll('.sort-bracket-only').forEach((el) => {
        el.style.display = normalized === 'bracket' ? '' : 'none';
    });
    document.querySelectorAll('.sort-cull-only').forEach((el) => {
        el.style.display = normalized === 'cull' ? '' : 'none';
    });

    // ui-refresh.js may rebuild the start button into
    // <span>🎮</span><span class="ui-label">…</span>, stripping the original
    // id/data-i18n — so fall back to the normalized label span.
    const startBtn = document.getElementById('btn-start-sorting');
    const startLabel = document.getElementById('sort-start-label')
        || (startBtn && (startBtn.querySelector('.ui-label') || startBtn.querySelector('[data-i18n]')));
    if (startLabel) {
        startLabel.textContent = getManualSortStartLabel(normalized);
    }
}

function bindManualSortModeSwitch() {
    document.querySelectorAll('.sort-mode-btn[data-sort-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
            // Locking the mode mid-session would desync the UI from the server.
            if (ManualSortState.active) return;
            setManualSortSelectedMode(btn.dataset.sortMode);
        });
    });
    // Restore the persisted choice on load.
    setManualSortSelectedMode(getManualSortSelectedMode(), { persist: false });
}


function normalizeManualSortOperationMode(mode) {
    // Default to 'copy' when the stored value is unrecognized so a corrupt
    // localStorage entry can never flip a brand-new user into the
    // destructive 'move' path. Locked by Principle #11 in
    // docs/AI_PRINCIPLES.md.
    return mode === 'move' ? 'move' : 'copy';
}

function getManualSortOperationMode() {
    return normalizeManualSortOperationMode(ManualSortState.operationMode);
}

function getManualSortOperationLabel(mode = getManualSortOperationMode()) {
    return mode === 'copy'
        ? manualSortText('manual.actionModeCopy', 'Copy and keep originals', '复制并保留原图')
        : manualSortText('manual.actionModeMove', 'Move originals', '移动原图');
}

function getManualSortOperationVerb(mode = getManualSortOperationMode()) {
    return mode === 'copy'
        ? manualSortText('manual.actionVerbCopy', 'copy', '复制')
        : manualSortText('manual.actionVerbMove', 'move', '移动');
}

function setManualSortOperationMode(mode, { persist = true, updateUi = true } = {}) {
    ManualSortState.operationMode = normalizeManualSortOperationMode(mode);
    if (persist) {
        localStorage.setItem(MANUAL_SORT_OPERATION_MODE_KEY, ManualSortState.operationMode);
    }
    if (updateUi) {
        document.querySelectorAll('input[name="manual-sort-operation"]').forEach((input) => {
            input.checked = input.value === ManualSortState.operationMode;
        });
        const helper = document.getElementById('manual-sort-operation-help');
        if (helper) {
            helper.textContent = ManualSortState.operationMode === 'copy'
                ? manualSortText(
                    'manual.actionModeCopyHelp',
                    'Copies into the sort folders and keeps the originals in place. Safer when date-based library order matters.',
                    '复制到目标文件夹，同时保留原图不动。需要保住按日期整理的库时更安全。'
                )
                : manualSortText(
                    'manual.actionModeMoveHelp',
                    'Moves the original files into the sort folders.',
                    '把原文件直接移动到目标文件夹。'
                );
        }
        const summary = document.getElementById('manual-sort-execution-mode');
        if (summary) {
            summary.textContent = formatManualSortI18n('manual.executionMode', 'Action mode: {mode}', {
                mode: getManualSortOperationLabel(),
            });
        }
    }
}

