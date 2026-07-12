/**
 * Dataset Maker — audit execution: runAudit (POST /api/dataset/audit), report download, bindAudit + threshold option controls.
 * Moved VERBATIM from dataset-maker-pipeline.js L544-665, L826-870,
 * L1218-1220 (+ documented non-verbatim bridges to dataset/audit.js
 * and the per-module init split).
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;
    // Split bridges (audit.js / audit-run.js, forced non-verbatim
    // ADDITIONS): AUDIT_STATE is the SAME object dataset/audit.js created —
    // published there as DM._auditState (original pipeline L1221; audit.js
    // loads first) — so reads/writes here hit the shared audit state
    // exactly as in the original single-scope IIFE. renderResults re-binds
    // audit.js's renderer (DM._renderAuditResults) so the verbatim call
    // inside runAudit keeps working.
    const AUDIT_STATE = DM._auditState;
    const renderResults = (report) => DM._renderAuditResults(report);

    // Duplicated VERBATIM from dataset/audit.js (module-scope helpers used
    // by both halves of the original pipeline IIFE; per-module duplication
    // is the split protocol for IIFE-local helpers).
    function $(id) { return document.getElementById(id); }

    function setStatus(text) {
        const el = $('dataset-audit-status');
        if (el) el.textContent = text || '';
    }

    async function runAudit() {
        if (AUDIT_STATE.running) return;
        const logicalCount = DM._getLogicalDatasetCount?.() || DM.imageIds?.length || 0;
        if (!logicalCount) {
            setStatus(DM._t('dataset.auditNoImages', 'Add some images first.'));
            return;
        }

        const aMax = ($('dataset-audit-aesthetic-max')?.value || '').trim();
        const pMax = ($('dataset-audit-phash-max')?.value || '').trim();
        const dMin = ($('dataset-audit-dim-min')?.value || '').trim();
        const checkCaptions = $('dataset-audit-check-captions')?.checked !== false;
        const checkDim = $('dataset-audit-check-dim')?.checked !== false;
        const checkPhash = $('dataset-audit-check-phash')?.checked === true;
        const checkAesthetic = $('dataset-audit-check-aesthetic')?.checked === true;

        const parsedAesthetic = Number(aMax || '4.5');
        const parsedPhash = parseInt(pMax || '5', 10);
        const parsedDim = parseInt(dMin || '512', 10);
        const aestheticMax = checkAesthetic && Number.isFinite(parsedAesthetic) ? parsedAesthetic : null;
        const phashMax = checkPhash && Number.isFinite(parsedPhash) ? parsedPhash : null;
        const dimMin = checkDim && Number.isFinite(parsedDim) ? parsedDim : null;

        // Split into image_ids (positive) and image_paths (resolved
        // from negative ds_id-derived ids).
        const imageIds = [];
        const imagePaths = [];
        for (const id of DM.imageIds) {
            if (DM.isLocalId && DM.isLocalId(id)) {
                if (DM._localIdUsesManifest?.(id)) continue;
                const p = DM.localItemPaths?.get?.(id);
                if (p) imagePaths.push(p);
            } else {
                imageIds.push(Number(id));
            }
        }
        const datasetScanTokens = DM._getDatasetScanTokenSources?.() || [];

        // Local items have no DB tags; supply a per-path tag count
        // proxy derived from whether captionEdits has a non-empty
        // string for them. The audit treats >0 as "tagged".
        const extraTagCounts = {};
        if (DM.localItemPaths) {
            for (const [id, absPath] of DM.localItemPaths.entries()) {
                const edit = DM.captionEdits?.get?.(id);
                if (edit && String(edit).trim()) {
                    // Use the comma count + 1 as a rough tag count.
                    extraTagCounts[absPath] = String(edit).split(',').filter(Boolean).length || 1;
                }
            }
        }

        setStatus(DM._t('dataset.auditRunning', 'Running audit...'));
        AUDIT_STATE.running = true;
        const btn = $('btn-dataset-audit-run');
        const importBtn = $('btn-dataset-import-audit');
        if (btn) btn.disabled = true;
        if (importBtn) importBtn.disabled = true;

        try {
            const r = await fetch('/api/dataset/audit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_ids: imageIds,
                    image_paths: imagePaths,
                    dataset_scan_tokens: datasetScanTokens,
                    aesthetic_max: aestheticMax,
                    phash_max: phashMax,
                    dim_min: dimMin,
                    enable_aesthetic: checkAesthetic && aestheticMax !== null,
                    enable_phash: checkPhash && phashMax !== null,
                    enable_untagged: checkCaptions,
                    extra_tag_counts: extraTagCounts,
                    item_limit: 50000,
                }),
            });
            if (!r.ok) {
                const body = await r.text();
                setStatus(`HTTP ${r.status}: ${body.slice(0, 200)}`);
                return;
            }
            const data = await r.json();
            renderResults(data);
            const counts = data.summary || {};
            const baseStatus = DM._t('dataset.auditDoneStatus',
                'Audit complete: {low} low-quality, {dupes} duplicate groups, {untagged} untagged, {small} small, {missing} missing/unreadable.',
                {
                    low: counts.low_quality_count || 0,
                    dupes: (data.duplicate_groups || []).length,
                    untagged: counts.untagged_count || 0,
                    small: counts.small_count || 0,
                    missing: counts.missing_count || 0,
                });
            const phashStatus = counts.near_duplicate_checked
                ? (counts.near_duplicate_error
                    ? ` ${DM._t('dataset.auditPhashUnavailableShort', 'Near-duplicate unavailable.')}`
                    : ` ${DM._t('dataset.auditPhashCheckedShort', 'Near-duplicate checked {count}.', { count: counts.near_duplicate_hashes || 0 })}`)
                : '';
            setStatus(baseStatus + phashStatus);
        } catch (e) {
            setStatus(e.message || String(e));
        } finally {
            AUDIT_STATE.running = false;
            if (btn) btn.disabled = false;
            if (importBtn) importBtn.disabled = false;
        }
    }

    function downloadReport() {
        if (!AUDIT_STATE.lastReport) return;
        const blob = new Blob([JSON.stringify(AUDIT_STATE.lastReport, null, 2)],
                              { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dataset-audit-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function bindAudit() {
        $('btn-dataset-audit-run')?.addEventListener('click', runAudit);
        $('btn-dataset-audit-download')?.addEventListener('click', downloadReport);
        $('btn-dataset-import-audit')?.addEventListener('click', () => {
            DM._showAuditModal?.();
            runAudit();
        });
        $('btn-dataset-audit-close')?.addEventListener('click', () => DM._hideAuditModal?.());
        $('dataset-audit-modal')?.querySelector?.('.dataset-modal-backdrop')?.addEventListener('click', () => DM._hideAuditModal?.());
        document.querySelectorAll('[data-audit-dim-preset]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const input = $('dataset-audit-dim-min');
                if (input) input.value = btn.getAttribute('data-audit-dim-preset') || '512';
                const check = $('dataset-audit-check-dim');
                if (check) check.checked = true;
                updateAuditOptionControls();
            });
        });
        for (const id of [
            'dataset-audit-check-captions',
            'dataset-audit-check-dim',
            'dataset-audit-check-phash',
            'dataset-audit-check-aesthetic',
        ]) {
            $(id)?.addEventListener('change', updateAuditOptionControls);
        }
        updateAuditOptionControls();
    }

    function updateAuditOptionControls() {
        const mapping = [
            ['dataset-audit-check-dim', 'dataset-audit-dim-min'],
            ['dataset-audit-check-phash', 'dataset-audit-phash-max'],
            ['dataset-audit-check-aesthetic', 'dataset-audit-aesthetic-max'],
        ];
        for (const [checkId, inputId] of mapping) {
            const check = $(checkId);
            const input = $(inputId);
            const option = check?.closest?.('.dataset-audit-option, .dataset-audit-threshold');
            const enabled = check?.checked !== false;
            if (input) input.disabled = !enabled;
            if (option) option.classList.toggle('is-disabled', !enabled);
        }
    }

    // ---- public hooks ----
    DM._runAudit = runAudit;

    // Split of dataset-maker-pipeline.js's single init() (forced
    // non-verbatim) — this module keeps only its own binder. See
    // dataset/audit.js for the full note.
    function init() {
        bindAudit();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
