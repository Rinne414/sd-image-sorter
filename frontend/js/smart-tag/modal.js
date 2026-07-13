/**
 * smart-tag/modal.js — smart-tag.js decomposition.
 * Extracted VERBATIM from frontend/js/smart-tag.js pre-split lines
 * 307-360 + 625-640: openModal (count/suffix summary, run-disable,
 * loadSmartTaggerModels + syncSmartTagVoteUi + refreshOllamaWarning +
 * resumeActiveSmartTagJob, showModal) and closeSmartTagModal (renamed
 * from closeModal for global uniqueness — gallery modules read
 * window.closeModal as an App fallback and must not resolve to this
 * function). Classic script; family renames applied.
 */
'use strict';
    async function openModal() {
        const modal = smartTag$('#smart-tag-modal');
        if (!modal) return;

        // Refresh image-count summary every time we open.
        const sources = getDatasetSources();
        const total = sources.total || 0;
        const countEl = smartTag$('#smart-tag-image-count');
        if (countEl) countEl.textContent = String(total);

        // Aurora Phase 3 (#25b): word the summary suffix for the actual scope —
        // a Gallery selection reads "selected images", not "in Dataset Maker".
        const suffixEl = smartTag$('#smart-tag-image-count-suffix');
        if (suffixEl) {
            const gallery = typeof sources.source === 'string' && sources.source.indexOf('gallery') === 0;
            const key = gallery ? 'smartTag.imageCountSuffixSelected' : 'smartTag.imageCountSuffix';
            suffixEl.setAttribute('data-i18n', key);
            suffixEl.textContent = smartTagT(key, gallery ? 'selected images.' : 'images currently in Dataset Maker.');
        }

        // Disable run button if there are no images to process.
        const runBtn = smartTag$('#btn-smart-tag-run');
        if (runBtn) runBtn.disabled = total === 0 && !sources.selectionToken && !sources.datasetScanToken;

        loadSmartTaggerModels();
        syncSmartTagVoteUi();
        // Fire-and-forget; banner appears/disappears on its own once
        // /api/vlm/local-models/recommended responds. Re-checking on
        // every openModal lets a user who fixes Ollama mid-session
        // see the cleared state without reloading the app.
        refreshOllamaWarning();

        // Reload-resume: after an F5 (or close/reopen of this modal) a job
        // started earlier may still be running on the backend. Re-attach the
        // progress bar + cancel button instead of leaving the run invisible
        // and a re-start to bounce off the backend's 409.
        resumeActiveSmartTagJob();

        // Use the project-wide showModal helper so Escape, focus-trap,
        // focus-restore, and aria semantics all work the same way as
        // every other modal in the app. The helper applies the
        // ``visible`` class (the canonical project convention) which
        // matches the modal stylesheet — the older ``show`` class this
        // file used to write was a no-op CSS selector.
        if (typeof window.showModal === 'function') {
            window.showModal('smart-tag-modal');
        } else {
            // Fallback for very early bootstrapping where app.js
            // hasn't registered the helper yet.
            modal.classList.add('visible');
            modal.setAttribute('aria-hidden', 'false');
        }
    }

    function closeSmartTagModal() {
        const modal = smartTag$('#smart-tag-modal');
        if (!modal) return;
        if (typeof window.hideModal === 'function') {
            window.hideModal('smart-tag-modal');
        } else {
            modal.classList.remove('visible');
            modal.setAttribute('aria-hidden', 'true');
        }
        stopProgressPolling();
        showProgress(false);
        setProgressUI({ percent: 0, text: '', preview: '' });
        // One-shot: the Gallery-armed scope does not survive a close.
        pendingExplicitScope = null;
    }

