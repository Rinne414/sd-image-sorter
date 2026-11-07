/**
 * prompt-lab/boot.js - prompt-lab.js decomposition (verbatim; LOADS LAST).
 * Moved BYTE-IDENTICAL from frontend/js/prompt-lab.js pre-cut lines 2474-2483 +
 * 2485 (of 2,485): the promptLabInitialized guard + function initPromptLab +
 * the window.initPromptLab publish. PromptLab resolves to the script-global
 * const declared in prompt-lab/base.js (v321/boot.js precedent).
 */

// Initialize when Prompt Lab tab is first activated
let promptLabInitialized = false;

function initPromptLab() {
    if (promptLabInitialized) return;
    promptLabInitialized = true;
    PromptLab.init();
    // Cards, hints and empty states are written by script: write them again in the new language.
    document.addEventListener('languageChanged', () => PromptLab.loadStats());
}

window.initPromptLab = initPromptLab;
