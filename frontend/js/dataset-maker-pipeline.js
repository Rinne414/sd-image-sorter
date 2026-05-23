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

    // ============== 5-step stepper ==============

    function bindStepper() {
        const pills = document.querySelectorAll('.dataset-stepper .dataset-step-pill');
        for (const pill of pills) {
            pill.addEventListener('click', () => {
                const target = pill.getAttribute('data-step-target');
                if (!target) return;
                const anchor = document.getElementById(target);
                if (anchor) {
                    anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        }
    }

    // ============== Audit panel ==============

    const AUDIT_STATE = {
        lastReport: null,
        activeFilter: null,    // one of "low_quality", "untagged", "small", "duplicate"
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

    function toggleFilter(flag) {
        AUDIT_STATE.activeFilter = (AUDIT_STATE.activeFilter === flag) ? null : flag;
        applyFilterToQueue();
        // Reflect active state in the badges
        for (const b of document.querySelectorAll('.dataset-audit-badge')) {
            b.classList.toggle('active', b.dataset.flag === AUDIT_STATE.activeFilter);
        }
    }

    function applyFilterToQueue() {
        const flag = AUDIT_STATE.activeFilter;
        const items = document.querySelectorAll('#dataset-queue-list .dataset-queue-item');
        if (!flag || !AUDIT_STATE.lastReport) {
            for (const it of items) it.classList.remove('audit-flagged');
            return;
        }
        const flaggedIds = new Set();
        const flaggedPaths = new Set();

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
        }

        wrap.hidden = false;
        const dlBtn = $('btn-dataset-audit-download');
        if (dlBtn) dlBtn.hidden = false;
    }

    async function runAudit() {
        if (!DM.imageIds || DM.imageIds.length === 0) {
            setStatus(DM._t('dataset.auditNoImages', 'Add some images first.'));
            return;
        }

        const aMax = ($('dataset-audit-aesthetic-max')?.value || '').trim();
        const pMax = ($('dataset-audit-phash-max')?.value || '').trim();
        const dMin = ($('dataset-audit-dim-min')?.value || '').trim();

        const aestheticMax = aMax === '' ? null : Number(aMax);
        const phashMax = pMax === '' ? null : parseInt(pMax, 10);
        const dimMin = dMin === '' ? null : parseInt(dMin, 10);

        // Split into image_ids (positive) and image_paths (resolved
        // from negative ds_id-derived ids).
        const imageIds = [];
        const imagePaths = [];
        for (const id of DM.imageIds) {
            if (DM.isLocalId && DM.isLocalId(id)) {
                const p = DM.localItemPaths?.get?.(id);
                if (p) imagePaths.push(p);
            } else {
                imageIds.push(Number(id));
            }
        }

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
        const btn = $('btn-dataset-audit-run');
        if (btn) btn.disabled = true;

        try {
            const r = await fetch('/api/dataset/audit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_ids: imageIds,
                    image_paths: imagePaths,
                    aesthetic_max: aestheticMax,
                    phash_max: phashMax,
                    dim_min: dimMin,
                    enable_aesthetic: aestheticMax !== null,
                    enable_phash: phashMax !== null,
                    extra_tag_counts: extraTagCounts,
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
                'Audit complete: {low} low-quality, {dupes} duplicate groups, {untagged} untagged, {small} small.',
                {
                    low: counts.low_quality_count || 0,
                    dupes: (data.duplicate_groups || []).length,
                    untagged: counts.untagged_count || 0,
                    small: counts.small_count || 0,
                }));
        } catch (e) {
            setStatus(e.message || String(e));
        } finally {
            if (btn) btn.disabled = false;
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
    }

    // ---- public hooks ----
    DM._runAudit = runAudit;
    DM._auditState = AUDIT_STATE;

    function init() {
        bindStepper();
        bindAudit();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
