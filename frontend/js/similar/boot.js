/**
 * similar/boot.js — similar.js decomposition (verbatim; LOADS LAST).
 * Moved BYTE-IDENTICAL from frontend/js/similar.js pre-cut lines 1497-1508
 * + 1510-1517 (of 1,517): the module-private `let similarInitialized`
 * guard + `function initSimilar()` (its only reader/writer), the
 * `window.initSimilar = initSimilar;` publish and the languageChanged
 * re-localize listener. The `window.SimilarImages = SimilarImages;`
 * publish (pre-cut line 1509) stays in similar/core.js. `SimilarImages`
 * resolves to the script-global const declared in core.js
 * (image-reader/prompt-lab boot precedent). Must be the LAST family tag
 * in index.html — initSimilar() reaches methods from every other family
 * file. Classic non-strict script.
 */
// Initialize when Similar tab is first activated
let similarInitialized = false;

function initSimilar() {
    if (similarInitialized) {
        SimilarImages.resumeEmbeddingProgress();
        return;
    }
    similarInitialized = true;
    SimilarImages.init();
}

window.initSimilar = initSimilar;
document.addEventListener('languageChanged', () => {
    SimilarImages._applyLocalizedDefaults();
    if (!similarInitialized) return;
    SimilarImages.loadStats();
    SimilarImages.loadScopeOptions();
    SimilarImages.refreshWorkflowStatus();
});
