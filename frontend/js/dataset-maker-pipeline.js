/**
 * Dataset Maker — pipeline stepper + audit panel (v3.2.2 T8 + T9 frontend).
 *
 * Two pieces of UI in one file:
 *   1. ``.dataset-stepper`` — the 5-step header. Each pill scrolls to a
 *      labelled anchor inside the Dataset Maker view.
 *   2. ``#dataset-step-audit`` — the LoRA-readiness audit panel. Default
 *      collapsed. User opens it, fills the thresholds they care about
 *      (all optional), runs the audit, sees badge counts they can click
 *      to filter the queue.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // ============== 4-tab nav ==============

    function bindTabs() {
        const tabs = document.querySelectorAll('.dataset-tabs [role="tab"]');
        const datasetMaker = document.querySelector('.dataset-maker');
        if (!datasetMaker || tabs.length === 0) return;

        for (const tab of tabs) {
            tab.addEventListener('click', () => {
                const target = tab.getAttribute('data-tab-target');
                if (!target) return;
                datasetMaker.setAttribute('data-active-tab', target);
                for (const t of tabs) {
                    t.setAttribute('aria-selected',
                        t.getAttribute('data-tab-target') === target ? 'true' : 'false');
                }
                if (target === 'audit') {
                    const det = document.getElementById('dataset-step-audit');
                    if (det && 'open' in det) det.open = true;
                }
            });
        }
    }

    // ============== Audit panel ==============

    const AUDIT_STATE = {
        lastReport: null,
        activeFilter: null,    // one of "missing", "low_quality", "untagged", "small", "duplicate"
        running: false,
    };

    function $(id) { return document.getElementById(id); }

    function setStatus(text) {
        const el = $('dataset-audit-status');
        if (el) el.textContent = text || '';
    }

    function makeBadge(flag, label, count) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dataset-audit-badge';
        btn.dataset.flag = flag;
        const lbl = document.createElement('span');
        lbl.textContent = label;
        const countEl = document.createElement('span');
        countEl.className = 'dataset-audit-badge-count';
        countEl.textContent = String(count);
        btn.append(lbl, countEl);
        btn.addEventListener('click', () => toggleFilter(flag));
        return btn;
    }

    function updateBadgeState() {
        for (const b of document.querySelectorAll('.dataset-audit-badge')) {
            b.classList.toggle('active', b.dataset.flag === AUDIT_STATE.activeFilter);
        }
    }

    function toggleFilter(flag) {
        AUDIT_STATE.activeFilter = (AUDIT_STATE.activeFilter === flag) ? null : flag;
        applyFilterToQueue();
        if (AUDIT_STATE.activeFilter) focusFirstAuditMatch(AUDIT_STATE.activeFilter);
        updateBadgeState();
        renderAuditNextSteps();
    }

    function getAuditMatches(flag) {
        const flaggedIds = new Set();
        const flaggedPaths = new Set();
        if (!flag || !AUDIT_STATE.lastReport) return { flaggedIds, flaggedPaths };
        if (flag === 'duplicate') {
            for (const grp of (AUDIT_STATE.lastReport.duplicate_groups || [])) {
                for (const id of grp.image_ids || []) {
                    if (id > 0) flaggedIds.add(Number(id));
                }
                for (const p of grp.abs_paths || []) {
                    if (p) flaggedPaths.add(p);
                }
            }
        } else {
            for (const it of (AUDIT_STATE.lastReport.items || [])) {
                if (!(it.flags || []).includes(flag)) continue;
                if (it.image_id && it.image_id > 0) flaggedIds.add(Number(it.image_id));
                if (it.abs_path) flaggedPaths.add(String(it.abs_path));
            }
        }
        return { flaggedIds, flaggedPaths };
    }

    function auditSummaryCount(flag, report = AUDIT_STATE.lastReport) {
        const summary = report?.summary || {};
        if (flag === 'duplicate') return (report?.duplicate_groups || []).length;
        const key = {
            missing: 'missing_count',
            low_quality: 'low_quality_count',
            untagged: 'untagged_count',
            small: 'small_count',
        }[flag];
        return Number(key ? summary[key] : 0) || 0;
    }

    function knownAuditMatchCount(flag, report = AUDIT_STATE.lastReport) {
        if (!flag || !report) return 0;
        const matches = getAuditMatches(flag);
        return matches.flaggedIds.size + matches.flaggedPaths.size;
    }

    function auditIssueIsTruncated(flag, report = AUDIT_STATE.lastReport) {
        if (!report?.items_truncated || flag === 'duplicate') return false;
        return knownAuditMatchCount(flag, report) < auditSummaryCount(flag, report);
    }

    function auditIssueOptions(report = AUDIT_STATE.lastReport) {
        const t = (key, fb) => DM._t(key, fb);
        const summary = report?.summary || {};
        const dupes = (report?.duplicate_groups || []).length;
        return [
            {
                flag: 'missing',
                label: t('dataset.auditBadgeMissing', 'Missing / unreadable'),
                count: summary.missing_count || 0,
                removable: true,
                truncated: auditIssueIsTruncated('missing', report),
                nextCopy: t('dataset.auditNextMissing',
                    'These files are missing or unreadable. Reconnect the source files, replace them, or remove them from the dataset before export.'),
            },
            {
                flag: 'untagged',
                label: t('dataset.auditBadgeUntagged', 'Untagged'),
                count: summary.untagged_count || 0,
                removable: true,
                truncated: auditIssueIsTruncated('untagged', report),
                nextCopy: t('dataset.auditNextUntagged',
                    'These images will export blank .txt files. Go to Workbench and write captions, or select them and remove the ones you do not want in the dataset.'),
            },
            {
                flag: 'small',
                label: t('dataset.auditBadgeSmall', 'Small'),
                count: summary.small_count || 0,
                removable: true,
                truncated: auditIssueIsTruncated('small', report),
                nextCopy: t('dataset.auditNextSmall',
                    'Review these low-resolution images. Replace them with larger sources or remove them from the dataset before export.'),
            },
            {
                flag: 'low_quality',
                label: t('dataset.auditBadgeLowQuality', 'Low quality'),
                count: summary.low_quality_count || 0,
                removable: true,
                truncated: auditIssueIsTruncated('low_quality', report),
                nextCopy: t('dataset.auditNextLowQuality',
                    'Review the low-score images and remove the ones that would weaken the training set.'),
            },
            {
                flag: 'duplicate',
                label: t('dataset.auditBadgeDuplicate', 'Duplicates'),
                count: dupes,
                removable: false,
                nextCopy: t('dataset.auditNextDuplicate',
                    'Duplicate groups are selected for review. Keep the best image in each group, then manually remove the extras.'),
            },
        ].filter((it) => Number(it.count || 0) > 0);
    }

    function preferredAuditFlag() {
        const issues = auditIssueOptions();
        if (AUDIT_STATE.activeFilter && issues.some((it) => it.flag === AUDIT_STATE.activeFilter)) {
            return AUDIT_STATE.activeFilter;
        }
        return issues[0]?.flag || null;
    }

    function loadedAuditMatchIds(flag) {
        const { flaggedIds, flaggedPaths } = getAuditMatches(flag);
        const matches = [];
        for (const id of DM.imageIds || []) {
            const numericId = Number(id);
            const meta = DM.meta?.get?.(numericId) || {};
            const absPath = String(meta.abs_path || '');
            const match = (numericId > 0 && flaggedIds.has(numericId))
                || (absPath && flaggedPaths.has(absPath));
            if (match) matches.push(numericId);
        }
        return matches;
    }

    function auditMatchStats(flag) {
        const { flaggedPaths } = getAuditMatches(flag);
        const loadedIds = loadedAuditMatchIds(flag);
        const loadedPaths = new Set();
        for (const id of loadedIds) {
            const meta = DM.meta?.get?.(Number(id)) || {};
            if (meta.abs_path) loadedPaths.add(String(meta.abs_path));
        }
        const unloadedPaths = Array.from(flaggedPaths).filter((p) => p && !loadedPaths.has(String(p)));
        return {
            loadedIds,
            unloadedPaths,
            total: loadedIds.length + unloadedPaths.length,
        };
    }

    function selectAuditMatches(flag = preferredAuditFlag(), options = {}) {
        if (!flag) {
            setStatus(DM._t('dataset.auditNeedIssue', 'Choose an audit issue first.'));
            return [];
        }
        AUDIT_STATE.activeFilter = flag;
        applyFilterToQueue();
        updateBadgeState();
        const ids = loadedAuditMatchIds(flag);
        DM._queueSelection = new Set(ids);
        DM._updateMultiSelectUI?.();
        if (options.focus !== false) focusFirstAuditMatch(flag);
        renderAuditNextSteps();
        setStatus(DM._t('dataset.auditSelectedStatus',
            'Selected {count} loaded matching images. Use Workbench to edit or remove them.',
            { count: ids.length }));
        return ids;
    }

    function clearAuditResultsAfterMutation() {
        AUDIT_STATE.lastReport = null;
        AUDIT_STATE.activeFilter = null;
        const wrap = $('dataset-audit-results');
        const badges = $('dataset-audit-badges');
        if (badges) badges.innerHTML = '';
        if (wrap) wrap.hidden = true;
        const dlBtn = $('btn-dataset-audit-download');
        if (dlBtn) dlBtn.hidden = true;
        applyFilterToQueue();
    }

    function removeAuditMatches(flag = preferredAuditFlag()) {
        if (!flag) {
            setStatus(DM._t('dataset.auditNeedIssue', 'Choose an audit issue first.'));
            return;
        }
        if (flag === 'duplicate') {
            selectAuditMatches(flag);
            setStatus(DM._t('dataset.auditDuplicateSelectOnly',
                'Duplicate groups are selected. Keep one image per group, then remove the extras manually.'));
            DM._setPipelineTab?.('workbench');
            return;
        }
        const { flaggedPaths } = getAuditMatches(flag);
        const stats = auditMatchStats(flag);
        const summaryCount = auditSummaryCount(flag);
        const wasTruncated = auditIssueIsTruncated(flag) && summaryCount > stats.total;
        if (stats.total === 0) {
            setStatus(DM._t('dataset.auditNoLoadedMatches',
                'No matching images are currently loaded in the queue. Load more previews or re-run audit.'));
            return;
        }
        const msg = DM._t('dataset.auditConfirmRemove',
            'Remove {count} matching images from this dataset? Original files will not be deleted.',
            { count: stats.total });
        if (!window.confirm(msg)) return;

        const removeIds = new Set(stats.loadedIds.map(Number));
        for (const path of flaggedPaths) {
            DM._excludeLocalPathFromManifests?.(path);
        }
        for (const id of removeIds) {
            if (DM.isLocalId?.(id)) DM._markLocalManifestExcluded?.(id);
            DM.captions?.delete?.(id);
            if (typeof DM._deleteCaptionEditForDatasetRemoval === 'function') {
                DM._deleteCaptionEditForDatasetRemoval(id);
            } else {
                DM.captionEdits?.delete?.(id);
            }
            DM._undoStacks?.delete?.(id);
            DM._queueSelection?.delete?.(id);
            if (DM.localItemPaths && DM.isLocalId?.(id)) {
                DM.localItemPaths.delete(id);
                DM.localItemDsIds?.delete?.(id);
            }
        }
        DM.imageIds = (DM.imageIds || []).filter((id) => !removeIds.has(Number(id)));
        if (DM.activeId != null && !DM.imageIds.includes(Number(DM.activeId))) {
            DM.activeId = DM.imageIds.length ? Number(DM.imageIds[0]) : null;
        }
        DM._queueSelection?.clear?.();
        DM._renderQueue?.();
        DM._renderImportGallery?.();
        DM._updateCount?.();
        DM._updateExportEnabled?.();
        DM._updateMultiSelectUI?.();
        if (DM.activeId != null) DM._setActive?.(DM.activeId);
        else DM._renderEmptyEditor?.();
        clearAuditResultsAfterMutation();
        if (wasTruncated) {
            setStatus(DM._t('dataset.auditRemovedPartialStatus',
                'Removed {count} returned matching images. Audit found {total}; run audit again to continue.',
                { count: stats.total, total: summaryCount }));
        } else {
            setStatus(DM._t('dataset.auditRemovedStatus',
                'Removed {count} matching images from the dataset. Run audit again to verify the remaining set.',
                { count: stats.total }));
        }
    }

    function goToAuditWorkbench(flag = preferredAuditFlag()) {
        if (flag) {
            AUDIT_STATE.activeFilter = flag;
            applyFilterToQueue();
            updateBadgeState();
            focusFirstAuditMatch(flag);
        }
        DM._setPipelineTab?.('workbench');
        renderAuditNextSteps();
    }

    function makeAuditAction(label, className, handler) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = className || 'btn btn-ghost btn-small';
        btn.textContent = label;
        btn.addEventListener('click', handler);
        return btn;
    }

    function renderAuditNextSteps() {
        const wrap = $('dataset-audit-results');
        if (!wrap || !AUDIT_STATE.lastReport) return;
        const existing = $('dataset-audit-next-steps');
        if (existing) existing.remove();
        const issues = auditIssueOptions();
        if (issues.length === 0) return;
        const flag = preferredAuditFlag();
        const issue = issues.find((it) => it.flag === flag) || issues[0];
        if (!issue) return;

        const panel = document.createElement('div');
        panel.className = 'dataset-audit-next-steps';
        panel.id = 'dataset-audit-next-steps';

        const title = document.createElement('div');
        title.className = 'dataset-audit-next-title';
        title.textContent = DM._t('dataset.auditNextTitle',
            'Next step: {label}', { label: issue.label });

        const copy = document.createElement('p');
        copy.className = 'dataset-audit-next-copy';
        copy.textContent = issue.nextCopy;

        const actions = document.createElement('div');
        actions.className = 'dataset-audit-next-actions';
        actions.append(
            makeAuditAction(DM._t('dataset.auditActionJump', 'Jump to first'), 'btn btn-ghost btn-small',
                () => focusFirstAuditMatch(issue.flag)),
            makeAuditAction(DM._t('dataset.auditActionWorkbench', 'Open Workbench'), 'btn btn-secondary btn-small',
                () => goToAuditWorkbench(issue.flag)),
            makeAuditAction(DM._t('dataset.auditActionSelect', 'Select matching'), 'btn btn-ghost btn-small',
                () => selectAuditMatches(issue.flag))
        );
        if (issue.removable) {
            actions.appendChild(makeAuditAction(
                issue.truncated
                    ? DM._t('dataset.auditActionRemoveReturned', 'Remove returned matches')
                    : DM._t('dataset.auditActionRemove', 'Remove matching from dataset'),
                'btn btn-danger btn-small',
                () => removeAuditMatches(issue.flag)
            ));
        }
        panel.append(title, copy);
        if (issue.truncated) {
            const warning = document.createElement('p');
            warning.className = 'dataset-audit-next-warning';
            warning.textContent = DM._t('dataset.auditNextTruncated',
                'Audit found {count} matching images, but only {known} were returned for browser actions. Download the report or run removal in passes; this button only affects returned matches.',
                {
                    count: issue.count,
                    known: knownAuditMatchCount(issue.flag),
                });
            panel.appendChild(warning);
        }
        panel.appendChild(actions);
        wrap.appendChild(panel);
    }

    function focusFirstAuditMatch(flag) {
        const { flaggedIds, flaggedPaths } = getAuditMatches(flag);
        for (const id of DM.imageIds || []) {
            const numericId = Number(id);
            const meta = DM.meta?.get?.(numericId) || {};
            const absPath = meta.abs_path || '';
            const match = (numericId > 0 && flaggedIds.has(numericId))
                || (absPath && flaggedPaths.has(absPath));
            if (match) {
                DM._setActive?.(numericId);
                break;
            }
        }
    }

    function applyFilterToQueue() {
        const flag = AUDIT_STATE.activeFilter;
        const items = document.querySelectorAll('#dataset-queue-list .dataset-queue-item');
        if (!flag || !AUDIT_STATE.lastReport) {
            for (const it of items) it.classList.remove('audit-flagged');
            return;
        }
        const { flaggedIds, flaggedPaths } = getAuditMatches(flag);

        for (const it of items) {
            const id = Number(it.dataset.imageId || 0);
            const meta = DM.meta?.get?.(id) || {};
            const absPath = meta.abs_path || '';
            const match = (id > 0 && flaggedIds.has(id))
                || (absPath && flaggedPaths.has(absPath));
            it.classList.toggle('audit-flagged', !!match);
        }
    }

    function renderResults(report) {
        AUDIT_STATE.lastReport = report;
        const wrap = $('dataset-audit-results');
        const badges = $('dataset-audit-badges');
        if (!wrap || !badges) return;
        badges.innerHTML = '';

        const t = (key, fb) => DM._t(key, fb);
        const summary = report.summary || {};
        const dupes = (report.duplicate_groups || []).length;

        if ((summary.low_quality_count || 0) > 0) {
            badges.appendChild(makeBadge('low_quality', t('dataset.auditBadgeLowQuality', 'Low quality'), summary.low_quality_count));
        }
        if ((summary.missing_count || 0) > 0) {
            badges.appendChild(makeBadge('missing', t('dataset.auditBadgeMissing', 'Missing / unreadable'), summary.missing_count));
        }
        if (dupes > 0) {
            badges.appendChild(makeBadge('duplicate', t('dataset.auditBadgeDuplicate', 'Duplicates'), dupes));
        }
        if ((summary.untagged_count || 0) > 0) {
            badges.appendChild(makeBadge('untagged', t('dataset.auditBadgeUntagged', 'Untagged'), summary.untagged_count));
        }
        if ((summary.small_count || 0) > 0) {
            badges.appendChild(makeBadge('small', t('dataset.auditBadgeSmall', 'Small'), summary.small_count));
        }
        if (badges.children.length === 0) {
            const ok = document.createElement('span');
            ok.className = 'dataset-audit-status';
            ok.textContent = t('dataset.auditAllClean', 'No issues found in the active checks.');
            badges.appendChild(ok);
            AUDIT_STATE.activeFilter = null;
        } else {
            AUDIT_STATE.activeFilter = preferredAuditFlag();
        }

        wrap.hidden = false;
        const dlBtn = $('btn-dataset-audit-download');
        if (dlBtn) dlBtn.hidden = false;
        updateBadgeState();
        applyFilterToQueue();
        renderAuditNextSteps();
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
            setStatus(DM._t('dataset.auditDoneStatus',
                'Audit complete: {low} low-quality, {dupes} duplicate groups, {untagged} untagged, {small} small, {missing} missing/unreadable.',
                {
                    low: counts.low_quality_count || 0,
                    dupes: (data.duplicate_groups || []).length,
                    untagged: counts.untagged_count || 0,
                    small: counts.small_count || 0,
                    missing: counts.missing_count || 0,
                }));
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
            const panel = $('dataset-audit-inline');
            if (panel) panel.open = true;
            runAudit();
        });
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
            const option = check?.closest?.('.dataset-audit-option');
            const enabled = check?.checked !== false;
            if (input) input.disabled = !enabled;
            if (option) option.classList.toggle('is-disabled', !enabled);
        }
    }

    // ============== Tag Vocabulary panel (T10) ==============

    const VOCAB_STATE = {
        items: [],            // [{tag, count, sample_image_id}, ...]
        filter: '',
        states: new Map(),    // tag -> 'common' | 'blacklist' | undefined
    };

    function readTextareaList(id) {
        return new Set(
            String(document.getElementById(id)?.value || '')
                .split(',').map((s) => s.trim()).filter(Boolean)
        );
    }

    function writeTextareaList(id, set) {
        const ta = document.getElementById(id);
        if (!ta) return;
        ta.value = Array.from(set).join(', ');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function syncVocabStateFromTextareas() {
        VOCAB_STATE.states.clear();
        const common = readTextareaList('dataset-common-tags');
        const blacklist = readTextareaList('dataset-blacklist');
        for (const t of common) VOCAB_STATE.states.set(t, 'common');
        for (const t of blacklist) VOCAB_STATE.states.set(t, 'blacklist');
    }

    function setTagState(tag, nextState) {
        const common = readTextareaList('dataset-common-tags');
        const blacklist = readTextareaList('dataset-blacklist');
        common.delete(tag);
        blacklist.delete(tag);
        if (nextState === 'common') {
            common.add(tag);
        } else if (nextState === 'blacklist') {
            blacklist.add(tag);
        }
        writeTextareaList('dataset-common-tags', common);
        writeTextareaList('dataset-blacklist', blacklist);
        syncVocabStateFromTextareas();
        renderVocab();
    }

    function renderVocab() {
        const list = $('dataset-vocab-list');
        const count = $('dataset-vocab-count');
        if (!list) return;
        list.innerHTML = '';
        const filter = (VOCAB_STATE.filter || '').toLowerCase();
        const items = VOCAB_STATE.items.filter((it) => !filter || String(it.tag).toLowerCase().includes(filter));
        for (const it of items) {
            const node = document.createElement('div');
            node.className = 'dataset-vocab-tag';
            const state = VOCAB_STATE.states.get(it.tag);
            if (state) node.classList.add(`state-${state}`);
            const lbl = document.createElement('span');
            lbl.className = 'dataset-vocab-tag-label';
            lbl.title = it.tag;
            lbl.textContent = it.tag;
            const c = document.createElement('span');
            c.className = 'dataset-vocab-tag-count';
            c.textContent = String(it.count);
            const actions = document.createElement('span');
            actions.className = 'dataset-vocab-tag-actions';
            const commonBtn = document.createElement('button');
            commonBtn.type = 'button';
            commonBtn.className = 'dataset-vocab-action';
            if (state === 'common') commonBtn.classList.add('active-common');
            commonBtn.textContent = '+';
            commonBtn.title = DM._t('dataset.vocabAddCommon', 'Add to Common tags');
            commonBtn.setAttribute('aria-label', `${commonBtn.title}: ${it.tag}`);
            commonBtn.addEventListener('click', () => setTagState(it.tag, state === 'common' ? null : 'common'));
            const blacklistBtn = document.createElement('button');
            blacklistBtn.type = 'button';
            blacklistBtn.className = 'dataset-vocab-action';
            if (state === 'blacklist') blacklistBtn.classList.add('active-blacklist');
            blacklistBtn.textContent = '-';
            blacklistBtn.title = DM._t('dataset.vocabAddBlacklist', 'Add to Blacklist');
            blacklistBtn.setAttribute('aria-label', `${blacklistBtn.title}: ${it.tag}`);
            blacklistBtn.addEventListener('click', () => setTagState(it.tag, state === 'blacklist' ? null : 'blacklist'));
            actions.append(commonBtn, blacklistBtn);
            node.append(lbl, c, actions);
            list.appendChild(node);
        }
        if (count) {
            count.textContent = `${items.length} / ${VOCAB_STATE.items.length}`;
        }
    }

    async function refreshVocab() {
        if (!DM.imageIds || DM.imageIds.length === 0) {
            VOCAB_STATE.items = [];
            renderVocab();
            DM._refreshCleanupButtons?.();
            return VOCAB_STATE.items;
        }
        const galleryIds = [];
        const localCaptions = {};
        for (const id of DM.imageIds) {
            if (DM.isLocalId && DM.isLocalId(id)) {
                const p = DM.localItemPaths?.get?.(id);
                const cap = DM.captionEdits?.get?.(id);
                if (p && cap) localCaptions[p] = cap;
            } else {
                galleryIds.push(Number(id));
            }
        }
        try {
            const r = await fetch('/api/dataset/vocab', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_ids: galleryIds,
                    path_caption_overrides: localCaptions,
                    top_n: 2000,
                }),
            });
            if (!r.ok) return VOCAB_STATE.items;
            const data = await r.json();
            VOCAB_STATE.items = data.vocab || [];
            syncVocabStateFromTextareas();
            renderVocab();
            DM._refreshCleanupButtons?.();
            return VOCAB_STATE.items;
        } catch { /* swallow */ }
        return VOCAB_STATE.items;
    }

    function bindVocab() {
        $('btn-dataset-vocab-refresh')?.addEventListener('click', refreshVocab);
        const search = $('dataset-vocab-search');
        if (search) {
            let timer = null;
            search.addEventListener('input', () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    VOCAB_STATE.filter = search.value || '';
                    renderVocab();
                }, 120);
            });
        }
        // Auto-refresh on first open
        const panel = $('dataset-vocab-panel');
        if (panel) {
            panel.addEventListener('toggle', () => {
                if (panel.open && VOCAB_STATE.items.length === 0) {
                    refreshVocab();
                }
            });
        }
        // When the user types in common/blacklist directly, keep the
        // visual state in sync.
        for (const id of ['dataset-common-tags', 'dataset-blacklist']) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.addEventListener('input', () => {
                syncVocabStateFromTextareas();
                renderVocab();
            });
        }
    }

    DM._refreshVocab = refreshVocab;
    DM._getDatasetVocabItems = function () {
        return VOCAB_STATE.items.slice();
    };
    DM._applyAuditFilterToQueue = applyFilterToQueue;

    // ============== LoRA starter defaults (T11) ==============

    const ANIME_DEFAULTS_FLAG = 'sd-image-sorter-dataset-customized';

    function applyAnimeDefaults({ silent = false } = {}) {
        // Common tags pre-fill (only if empty so we don't clobber user input).
        const ct = document.getElementById('dataset-common-tags');
        if (ct && !String(ct.value || '').trim()) {
            ct.value = 'masterpiece, best_quality';
            ct.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Underscore-to-space ON (preserve user choice if already changed).
        const us = document.getElementById('dataset-underscore-to-space');
        if (us && !us.dataset.userTouched) {
            us.checked = true;
        }
        // Naming preset = renumber (better LoRA workflow than 'keep' random filenames).
        const renumberRadio = document.querySelector('input[name="dataset-naming-preset"][value="renumber"]');
        const keepRadio = document.querySelector('input[name="dataset-naming-preset"][value="keep"]');
        const presetUserTouched = (keepRadio && keepRadio.dataset.userTouched)
            || (renumberRadio && renumberRadio.dataset.userTouched);
        if (renumberRadio && !presetUserTouched) {
            renumberRadio.checked = true;
            renumberRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Trigger placeholder hint if the user has typed nothing yet.
        const trigger = document.getElementById('dataset-trigger');
        if (trigger && !String(trigger.value || '').trim()) {
            trigger.placeholder = 'your_lora_trigger';
        }
        if (!silent && typeof DM._toast === 'function') {
            DM._toast(DM._t('dataset.animeDefaultsApplied',
                'Applied starter defaults.'), 'success');
        }
    }

    function bindAnimeDefaults() {
        const btn = document.getElementById('btn-dataset-anime-defaults');
        if (btn) {
            btn.addEventListener('click', () => {
                // Force reset by clearing user-touched flags first.
                document.querySelectorAll('[data-user-touched="1"]').forEach((el) => {
                    delete el.dataset.userTouched;
                });
                // Clear fields so applyAnimeDefaults will repopulate them.
                const ct = document.getElementById('dataset-common-tags');
                if (ct) ct.value = '';
                applyAnimeDefaults({ silent: false });
                try { localStorage.removeItem(ANIME_DEFAULTS_FLAG); } catch {}
            });
        }
        // Mark fields as user-touched once they edit them so the defaults
        // never override their choices on subsequent inits.
        const fields = [
            'dataset-common-tags', 'dataset-underscore-to-space',
            'dataset-blacklist', 'dataset-trigger',
        ];
        for (const id of fields) {
            const el = document.getElementById(id);
            if (!el) continue;
            const evt = (el.tagName === 'INPUT' && el.type === 'checkbox') ? 'change' : 'input';
            el.addEventListener(evt, () => {
                el.dataset.userTouched = '1';
                try { localStorage.setItem(ANIME_DEFAULTS_FLAG, '1'); } catch {}
            }, { once: true });
        }
        document.querySelectorAll('input[name="dataset-naming-preset"]').forEach((radio) => {
            radio.addEventListener('change', () => {
                radio.dataset.userTouched = '1';
                try { localStorage.setItem(ANIME_DEFAULTS_FLAG, '1'); } catch {}
            }, { once: true });
        });

        // Apply defaults on the first init (no localStorage flag yet).
        const customized = (() => {
            try { return localStorage.getItem(ANIME_DEFAULTS_FLAG) === '1'; }
            catch { return false; }
        })();
        if (!customized) {
            applyAnimeDefaults({ silent: true });
        }
    }

    DM._applyAnimeDefaults = applyAnimeDefaults;

    // ============== Renamed-pair preview chip (T12) ==============

    function extensionForDatasetId(id) {
        const filename = DM.meta?.get?.(id)?.filename || '';
        const match = String(filename).match(/\.([^.]+)$/);
        return match ? match[1].toLowerCase() : 'png';
    }

    function refreshPairChip() {
        const png = document.getElementById('dataset-pair-chip-png');
        const txt = document.getElementById('dataset-pair-chip-txt');
        if (!png || !txt) return;
        const trigger = (document.getElementById('dataset-trigger')?.value || '').trim();
        const preset = (document.querySelector('input[name="dataset-naming-preset"]:checked')?.value) || 'keep';
        const ext = extensionForDatasetId((DM.imageIds || [])[0]);
        let stem;
        if (preset === 'keep') {
            stem = 'your_image_name';
        } else if (preset === 'renumber') {
            stem = `${(trigger || 'your_lora_trigger')}_001`;
        } else {
            const pattern = (document.getElementById('dataset-naming-pattern')?.value || '{trigger}_{index:03d}');
            stem = pattern
                .replace(/\{trigger\}/g, trigger || 'your_lora_trigger')
                .replace(/\{index:0*(\d+)d\}/g, (_m, w) => '1'.padStart(parseInt(w, 10) || 1, '0'))
                .replace(/\{index\}/g, '1')
                .replace(/\{filename\}/g, 'your_image_name')
                .replace(/\{generator\}/g, 'webui')
                .replace(/\{ext\}/g, ext)
                .replace(/\{date\}/g, new Date().toISOString().slice(0, 10));
        }
        png.textContent = `${stem}.${ext}`;
        txt.textContent = `${stem}.txt`;
    }

    function bindPairChip() {
        for (const id of ['dataset-trigger', 'dataset-naming-pattern']) {
            document.getElementById(id)?.addEventListener('input', refreshPairChip);
        }
        document.querySelectorAll('input[name="dataset-naming-preset"]').forEach((r) => {
            r.addEventListener('change', refreshPairChip);
        });
        refreshPairChip();
    }

    DM._refreshPairChip = refreshPairChip;

    // ---- public hooks ----
    DM._runAudit = runAudit;
    DM._auditState = AUDIT_STATE;

    // ---- Export preview (Phase 4) ----
    function refreshExportPreview() {
        const list = document.getElementById('dataset-export-preview-list');
        if (!list) return;
        const trigger = (document.getElementById('dataset-trigger')?.value || '').trim();
        const preset = (document.querySelector('input[name="dataset-naming-preset"]:checked')?.value) || 'keep';
        const pattern = (document.getElementById('dataset-naming-pattern')?.value || '{trigger}_{index:03d}');
        const items = DM.imageIds || [];
        const logicalCount = DM._getLogicalDatasetCount?.() || items.length;
        if (logicalCount === 0) {
            list.innerHTML = `<span class="dataset-export-preview-empty">${DM._t?.('dataset.exportPreviewEmpty', 'Add images and set naming to see preview') || 'Add images and set naming to see preview'}</span>`;
            return;
        }
        if (items.length === 0) {
            list.innerHTML = `<span class="dataset-export-preview-empty">${DM._t?.(
                'dataset.exportPreviewNoLoadedItems',
                '{count} images are in the dataset manifest, but no previews are loaded in the browser yet.',
                { count: logicalCount }
            ) || `${logicalCount} images are in the dataset manifest, but no previews are loaded in the browser yet.`}</span>`;
            return;
        }

        const buildStem = (id, index) => {
            const meta = DM.meta?.get?.(id) || {};
            const sourceBase = meta.filename ? meta.filename.replace(/\.[^.]+$/, '') : `image_${index + 1}`;
            const ext = extensionForDatasetId(id);
            if (preset === 'keep') return { stem: sourceBase, ext, sourceBase };
            if (preset === 'renumber') {
                return { stem: `${trigger || 'subject'}_${String(index + 1).padStart(3, '0')}`, ext, sourceBase };
            }
            return {
                stem: pattern
                    .replace(/\{trigger\}/g, trigger || 'subject')
                    .replace(/\{index:0*(\d+)d\}/g, (_m, w) => String(index + 1).padStart(parseInt(w, 10) || 1, '0'))
                    .replace(/\{index\}/g, String(index + 1))
                    .replace(/\{filename\}/g, sourceBase)
                    .replace(/\{generator\}/g, 'webui')
                    .replace(/\{ext\}/g, ext)
                    .replace(/\{date\}/g, new Date().toISOString().slice(0, 10)),
                ext,
                sourceBase,
            };
        };

        const outputNameCounts = new Map();
        items.forEach((id, index) => {
            const { stem, ext } = buildStem(id, index);
            const key = `${stem}.${ext}`.toLowerCase();
            outputNameCounts.set(key, (outputNameCounts.get(key) || 0) + 1);
        });
        const duplicateOutputCount = Array.from(outputNameCounts.values()).reduce(
            (sum, count) => sum + (count > 1 ? count : 0),
            0
        );

        const sampleIndexes = [];
        const firstCount = Math.min(items.length, 36);
        for (let i = 0; i < firstCount; i += 1) sampleIndexes.push(i);
        if (items.length > 60) {
            const tailStart = Math.max(firstCount, items.length - 12);
            for (let i = tailStart; i < items.length; i += 1) sampleIndexes.push(i);
        } else {
            for (let i = firstCount; i < Math.min(items.length, 60); i += 1) sampleIndexes.push(i);
        }
        const skippedMiddle = items.length - sampleIndexes.length;

        list.innerHTML = '';

        const summary = document.createElement('div');
        summary.className = 'dataset-export-preview-summary';
        const modeLabel = preset === 'keep'
            ? (DM._t?.('dataset.namingKeepLabel', 'Keep original filenames') || 'Keep original filenames')
            : preset === 'renumber'
                ? (DM._t?.('dataset.namingRenumberShort', 'Renumber') || 'Renumber')
                : (DM._t?.('dataset.namingCustomShort', 'Custom template') || 'Custom template');
        summary.innerHTML = `
            <strong>${logicalCount.toLocaleString()} ${DM._t?.('dataset.exportPreviewPairs', 'image + caption pairs') || 'image + caption pairs'}</strong>
            <span>${modeLabel}</span>
            <span>${DM._t?.('dataset.exportPreviewShowing', 'Showing') || 'Showing'} ${sampleIndexes.length.toLocaleString()} ${DM._t?.('dataset.exportPreviewSamples', 'samples') || 'samples'}</span>
            ${logicalCount !== items.length
                ? `<span>${DM._t?.('dataset.exportPreviewLoadedOfTotal', '{loaded}/{total} previews loaded', { loaded: items.length, total: logicalCount }) || `${items.length}/${logicalCount} previews loaded`}</span>`
                : ''}
        `;
        list.appendChild(summary);

        if (logicalCount !== items.length) {
            const manifestNote = document.createElement('div');
            manifestNote.className = 'dataset-export-preview-summary';
            manifestNote.textContent = DM._t?.(
                'dataset.exportPreviewManifestNote',
                'Export will include every manifest image. File-name preview, duplicate checks, caption status, and thumbnail rows below cover loaded previews only.',
                { loaded: items.length, total: logicalCount }
            ) || 'Export will include every manifest image. Preview checks below cover loaded previews only.';
            list.appendChild(manifestNote);
        }

        if (duplicateOutputCount > 0) {
            const warning = document.createElement('div');
            warning.className = 'dataset-export-preview-warning';
            warning.textContent = DM._t?.(
                'dataset.exportPreviewDuplicateWarning',
                '{count} output image names would collide. Change naming before export.',
                { count: duplicateOutputCount }
            ) || `${duplicateOutputCount} output image names would collide. Change naming before export.`;
            list.appendChild(warning);
        }

        sampleIndexes.forEach((i, samplePosition) => {
            if (skippedMiddle > 0 && samplePosition === firstCount) {
                const divider = document.createElement('div');
                divider.className = 'dataset-export-preview-divider';
                divider.textContent = DM._t?.(
                    'dataset.exportPreviewSkippedMiddle',
                    '{count} middle pairs hidden from preview; export still includes all.',
                    { count: skippedMiddle }
                ) || `${skippedMiddle} middle pairs hidden from preview; export still includes all.`;
                list.appendChild(divider);
            }

            const id = items[i];
            const meta = DM.meta?.get?.(id) || {};
            const { stem, ext, sourceBase } = buildStem(id, i);
            const outputKey = `${stem}.${ext}`.toLowerCase();
            const hasCaptionEdit = DM.captionEdits?.has?.(id);
            const caption = hasCaptionEdit ? DM.captionEdits.get(id) : (DM.captions?.get?.(id) || '');
            const captionState = hasCaptionEdit
                ? (DM._t?.('dataset.statusEdited', 'edited') || 'edited')
                : String(caption || '').trim()
                    ? (DM._t?.('dataset.statusTagged', 'tagged') || 'tagged')
                    : (DM._t?.('dataset.statusUntagged', 'no caption') || 'no caption');

            const row = document.createElement('div');
            row.className = 'dataset-export-preview-pair';
            if ((outputNameCounts.get(outputKey) || 0) > 1) row.classList.add('has-name-collision');

            const thumb = document.createElement('img');
            thumb.className = 'dataset-export-preview-thumb';
            thumb.alt = '';
            thumb.loading = 'lazy';
            thumb.decoding = 'async';
            if (typeof DM._thumbSrc === 'function') thumb.src = DM._thumbSrc(id, 128);
            thumb.onerror = () => {
                thumb.removeAttribute('src');
                thumb.classList.add('is-missing');
            };

            const copy = document.createElement('div');
            copy.className = 'dataset-export-preview-copy';
            const index = document.createElement('span');
            index.className = 'dataset-export-preview-index';
            index.textContent = `#${String(i + 1).padStart(4, '0')}`;
            const sourceName = document.createElement('span');
            sourceName.className = 'file-source';
            sourceName.textContent = meta.filename || `${sourceBase}.${ext}`;
            const imgName = document.createElement('span');
            imgName.className = 'file-img';
            imgName.textContent = `${stem}.${ext}`;
            const txtName = document.createElement('span');
            txtName.className = 'file-txt';
            txtName.textContent = `${stem}.txt`;
            txtName.style.cursor = 'pointer';
            txtName.title = DM._t?.('dataset.exportPreviewClickTxt', 'Click to preview caption') || 'Click to preview caption';
            txtName.addEventListener('click', () => {
                let preview = copy.querySelector('.export-caption-preview');
                if (preview) {
                    preview.remove();
                    return;
                }
                preview = document.createElement('div');
                preview.className = 'export-caption-preview';
                const text = DM.captionEdits?.get?.(id) || DM.captions?.get?.(id) || '';
                preview.textContent = text || DM._t?.('dataset.exportPreviewNoCaption', '(empty)') || '(empty)';
                copy.appendChild(preview);
            });
            const status = document.createElement('span');
            status.className = 'file-caption-status';
            status.textContent = captionState;
            copy.append(index, sourceName, imgName, txtName, status);

            row.append(thumb, copy);
            list.appendChild(row);
        });
    }

    function bindExportPreview() {
        for (const id of ['dataset-trigger', 'dataset-naming-pattern']) {
            document.getElementById(id)?.addEventListener('input', refreshExportPreview);
        }
        document.querySelectorAll('input[name="dataset-naming-preset"]').forEach((r) => {
            r.addEventListener('change', refreshExportPreview);
        });
    }

    DM._refreshExportPreview = refreshExportPreview;

    function init() {
        bindTabs();
        bindAudit();
        bindVocab();
        bindAnimeDefaults();
        bindPairChip();
        bindExportPreview();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();

/* ============== Custom dark dropdown for native selects ============== */
(function () {
    'use strict';

    function wrapSelect(sel) {
        if (sel.dataset.customDropdown) return;
        sel.dataset.customDropdown = '1';
        sel.style.display = 'none';

        const wrapper = document.createElement('div');
        wrapper.className = 'dataset-custom-dropdown';

        const display = document.createElement('button');
        display.type = 'button';
        display.className = 'dataset-custom-dropdown-display';
        display.textContent = sel.options[sel.selectedIndex]?.textContent || '';

        const list = document.createElement('div');
        list.className = 'dataset-custom-dropdown-list';
        list.hidden = true;
        document.body.appendChild(list);

        function closeList() {
            list.hidden = true;
        }

        function positionList() {
            const rect = display.getBoundingClientRect();
            const gap = 4;
            const maxHeight = Math.min(220, Math.max(120, window.innerHeight - 24));
            const spaceBelow = window.innerHeight - rect.bottom - gap;
            const openUpward = spaceBelow < 140 && rect.top > spaceBelow;
            const height = Math.min(maxHeight, openUpward ? rect.top - 12 : spaceBelow);
            list.style.left = `${Math.max(8, rect.left)}px`;
            list.style.width = `${Math.max(160, rect.width)}px`;
            list.style.maxHeight = `${Math.max(120, height)}px`;
            list.style.top = openUpward
                ? `${Math.max(8, rect.top - Math.max(120, height) - gap)}px`
                : `${Math.min(window.innerHeight - 8, rect.bottom + gap)}px`;
        }

        function buildOptions() {
            list.innerHTML = '';
            for (const opt of sel.options) {
                const item = document.createElement('div');
                item.className = 'dataset-custom-dropdown-option';
                if (opt.selected) item.classList.add('selected');
                item.textContent = opt.textContent;
                item.dataset.value = opt.value;
                item.addEventListener('click', () => {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    display.textContent = opt.textContent;
                    closeList();
                    for (const o of list.children) o.classList.remove('selected');
                    item.classList.add('selected');
                });
                list.appendChild(item);
            }
        }
        buildOptions();

        display.addEventListener('click', (e) => {
            e.stopPropagation();
            const nextHidden = !list.hidden;
            for (const openList of document.querySelectorAll('.dataset-custom-dropdown-list:not([hidden])')) {
                if (openList !== list) openList.hidden = true;
            }
            list.hidden = nextHidden;
            if (!list.hidden) positionList();
        });

        document.addEventListener('click', closeList);
        window.addEventListener('resize', closeList);
        window.addEventListener('scroll', closeList, true);

        sel.addEventListener('change', () => {
            display.textContent = sel.options[sel.selectedIndex]?.textContent || '';
            buildOptions();
        });

        wrapper.append(display);
        sel.parentNode.insertBefore(wrapper, sel.nextSibling);
    }

    function initCustomDropdowns() {
        const container = document.getElementById('view-dataset');
        if (!container) return;
        const selects = container.querySelectorAll('.dataset-export-pane select, .dataset-card select');
        for (const sel of selects) wrapSelect(sel);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCustomDropdowns, { once: true });
    } else {
        initCustomDropdowns();
    }
})();
