/**
 * manual-sort/keys.js — manual-sort.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/manual-sort.js,
 * pre-split lines 3125-3191 + 3570-3575: handleSortKeypress (the master
 * keydown dispatcher: Ctrl+Z/Y, bracket/cull routing, KEY_MAP actions) and the
 * sleep utility. Classic script: loads after manual-sort/state-constants.js.
 */
// ============== Handle Keypress ==============

function handleSortKeypress(e) {
    if (!ManualSortState.active) return;

    const isBracket = ManualSortState.mode === 'bracket';
    const isCull = ManualSortState.mode === 'cull';

    // Handle Ctrl+Z (undo) and Ctrl+Y / Ctrl+Shift+Z (redo) explicitly
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || e.key === 'Z') {
            e.preventDefault();
            if (isBracket) {
                performBracketAction(e.shiftKey ? 'redo' : 'undo');
            } else if (isCull) {
                performCullAction(e.shiftKey ? 'redo' : 'undo');
            } else if (e.shiftKey) {
                redoLastAction();
            } else {
                undoLastAction();
            }
            return;
        }
        if (e.key === 'y' || e.key === 'Y') {
            e.preventDefault();
            if (isBracket) performBracketAction('redo');
            else if (isCull) performCullAction('redo');
            else redoLastAction();
            return;
        }
        return; // Ignore other Ctrl+key combos
    }

    // v3.3.2 WB-S3: A/B Showdown has its own key map (←/→ pick, ↑ skip).
    if (isBracket) {
        handleBracketKeypress(e);
        return;
    }
    // v3.3.2 FF-1: 留/汰 cull has its own key map (←reject / →keep / ↑skip).
    if (isCull) {
        handleCullKeypress(e);
        return;
    }

    const action = KEY_MAP[e.key];
    if (!action) return;

    e.preventDefault();

    // v3.2.1 task #36: when the OS auto-repeat fires (key held down) we skip
    // the 300 ms fly-away animation so long-press feels Ctrl+Z fast instead of
    // gated by animation duration.
    const fast = Boolean(e.repeat);

    if (action === 'undo') {
        undoLastAction();
    } else if (action === 'redo') {
        redoLastAction();
    } else if (action === 'skip') {
        performSkip(fast);
    } else if (action === 'exit') {
        exitSorting();
    } else {
        performMove(action, fast);
    }
}

// ============== Utilities ==============

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

