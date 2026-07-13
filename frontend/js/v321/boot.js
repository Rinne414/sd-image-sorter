/**
 * v321/boot.js - v321-ui.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/v321-ui.js pre-cut lines 36-44 + 3160-3161
 * (of 3,164): init() + the DOMContentLoaded boot (registers LAST in the family).
 * Classic script: joins the ONE unsealed window.V321Integration object
 * declared in v321/base.js (loads FIRST); v321/boot.js registers the
 * DOMContentLoaded init LAST; index.html lists the family in original
 * line order.
 */
Object.assign(window.V321Integration, {
    init() {
        this.bindTaggerBackendSwitch();
        this.bindExportPresetUI();
        this.bindLivePreview();
        this.interceptCombinedExportClick();
        this.interceptTagSubmit();
        this.bindHardRefreshButton();
        this.bindCaptionEditorUnloadGuard();
    },
});

document.addEventListener('DOMContentLoaded', () => V321Integration.init());
