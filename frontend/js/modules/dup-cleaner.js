/**
 * Duplicate Cleanup workflow (v3.5.0 Tier 1).
 *
 * Whole-library near-duplicate review: start a background group scan
 * (POST /api/duplicates/scan → poll /api/bulk-jobs/{id}), then page through
 * the persisted groups (GET /api/duplicates/groups). Each group shows its
 * members side by side, best-first, with the suggested keeper highlighted
 * and everything else pre-checked for removal. Deletion reuses the existing
 * trash-backed pipeline (POST /api/images/delete-selected) — large batches
 * opt into the durable background job automatically.
 */
(function () {
    'use strict';

    const PAGE_SIZE = 40;
    const POLL_MS = 1000;
    const BACKGROUND_DELETE_THRESHOLD = 500;

    const STATE = {
        offset: 0,
        totalGroups: 0,
        summary: null,
        pollTimer: null,
        activeJobId: null,
        deleting: false,
    };

    function t(key, fallback, params) {
        const value = window.I18n.t(key, params);
        return value && value !== key ? value : window.I18n.format(fallback, params);
    }

    function $(id) { return document.getElementById(id); }

    function showToast(message, kind) {
        window.App?.showToast?.(message, kind || 'info');
    }

    function formatBytes(bytes) {
        const num = Number(bytes) || 0;
        if (num >= 1024 * 1024 * 1024) return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
        if (num >= 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
        if (num >= 1024) return `${Math.round(num / 1024)} KB`;
        return `${num} B`;
    }

    function thumbnailUrl(imageId) {
        return window.App?.API?.getThumbnailUrl?.(imageId, 256)
            ?? `/api/image-thumbnail/${imageId}?size=256`;
    }

    // ------------------------------------------------------------------
    // Modal lifecycle
    // ------------------------------------------------------------------

    // `scan: true` starts a background scan unless one is already running
    // (the Similar page hands over here when its quick check is too big).
    async function open({ scan = false } = {}) {
        window.App?.showModal?.('dup-cleaner-modal');
        await reattachRunningScan();
        await loadGroups(true);
        if (scan && !STATE.activeJobId) await startScan();
    }

    function close() {
        window.App?.hideModal?.('dup-cleaner-modal');
        stopPolling();
    }

    // ------------------------------------------------------------------
    // Scan control
    // ------------------------------------------------------------------

    async function startScan() {
        const threshold = parseFloat($('dup-threshold')?.value) || 0.95;
        try {
            const r = await fetch('/api/duplicates/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threshold }),
            });
            if (r.status === 409) {
                showToast(t('dup.alreadyRunning', 'A duplicate scan is already running'), 'warning');
                await reattachRunningScan();
                return;
            }
            if (!r.ok) throw new Error(`scan start ${r.status}`);
            const data = await r.json();
            beginPolling(data.job_id);
        } catch (err) {
            showToast(t('dup.scanStartFailed', 'Could not start the duplicate scan'), 'error');
        }
    }

    async function reattachRunningScan() {
        try {
            const r = await fetch('/api/duplicates/scan-status');
            if (!r.ok) return;
            const data = await r.json();
            if (data.active && data.job_id) beginPolling(data.job_id);
        } catch { /* status probe is best-effort */ }
    }

    function beginPolling(jobId) {
        STATE.activeJobId = jobId;
        setScanUiRunning(true);
        stopPolling();
        STATE.pollTimer = setInterval(() => pollJob(jobId), POLL_MS);
        pollJob(jobId);
    }

    function stopPolling() {
        if (STATE.pollTimer) {
            clearInterval(STATE.pollTimer);
            STATE.pollTimer = null;
        }
    }

    async function pollJob(jobId) {
        try {
            const r = await fetch(`/api/bulk-jobs/${jobId}`);
            if (!r.ok) throw new Error(`poll ${r.status}`);
            const job = await r.json();
            updateProgress(job);
            if (['done', 'cancelled', 'error'].includes(job.status)) {
                stopPolling();
                STATE.activeJobId = null;
                setScanUiRunning(false);
                if (job.status === 'done') {
                    await loadGroups(true);
                    if (scanCoverageIncomplete(STATE.summary)) {
                        showToast(formatIncompleteScanToast(STATE.summary), 'warning');
                    } else {
                        showToast(t('dup.scanDone', 'Duplicate scan finished'), 'success');
                    }
                } else if (job.status === 'error') {
                    showToast(t('dup.scanFailed', 'Duplicate scan failed'), 'error');
                }
            }
        } catch {
            stopPolling();
            STATE.activeJobId = null;
            setScanUiRunning(false);
        }
    }

    async function cancelScan() {
        if (!STATE.activeJobId) return;
        try {
            await fetch(`/api/bulk-jobs/${STATE.activeJobId}/cancel`, { method: 'POST' });
        } catch { /* poll settles the UI */ }
    }

    function setScanUiRunning(running) {
        const scanBtn = $('btn-dup-scan');
        const cancelBtn = $('btn-dup-cancel-scan');
        const progress = $('dup-scan-progress');
        if (scanBtn) scanBtn.disabled = running;
        if (cancelBtn) cancelBtn.hidden = !running;
        if (progress) progress.hidden = !running;
    }

    function updateProgress(job) {
        const fill = $('dup-scan-progress-fill');
        const text = $('dup-scan-progress-text');
        const total = Number(job.total) || 100;
        const processed = Math.min(Number(job.processed) || 0, total);
        if (fill) fill.style.width = `${Math.round((processed / total) * 100)}%`;
        if (text) text.textContent = job.message || '';
    }

    // ------------------------------------------------------------------
    // Groups rendering
    // ------------------------------------------------------------------

    async function loadGroups(reset) {
        if (reset) {
            STATE.offset = 0;
            const container = $('dup-groups');
            if (container) container.replaceChildren();
        }
        try {
            const r = await fetch(`/api/duplicates/groups?offset=${STATE.offset}&limit=${PAGE_SIZE}`);
            if (!r.ok) throw new Error(`groups ${r.status}`);
            const data = await r.json();
            renderSummary(data);
            if (data.available) renderGroups(data.groups || []);
            STATE.totalGroups = data.total_groups || 0;
            STATE.offset += (data.groups || []).length;
            const more = $('btn-dup-load-more');
            if (more) more.hidden = !data.has_more;
        } catch {
            showToast(t('dup.loadFailed', 'Could not load duplicate groups'), 'error');
        }
    }

    function renderSummary(data) {
        const summaryBox = $('dup-summary');
        const emptyBox = $('dup-empty');
        if (!summaryBox || !emptyBox) return;
        if (!data.available) {
            summaryBox.hidden = true;
            emptyBox.hidden = false;
            return;
        }
        STATE.summary = data.summary || null;
        const s = data.summary || {};
        emptyBox.hidden = true;
        summaryBox.hidden = false;
        writeSummaryText(s);
        const applyAll = $('btn-dup-apply-all');
        if (applyAll) applyAll.hidden = !(s.group_count > 0);
    }

    function renderGroups(groups) {
        const container = $('dup-groups');
        if (!container) return;
        groups.forEach((group) => container.appendChild(buildGroupCard(group)));
    }

    function buildGroupCard(group) {
        const card = document.createElement('section');
        card.className = 'dup-group';
        card.dataset.groupId = String(group.group_id);

        const header = document.createElement('div');
        header.className = 'dup-group-header';
        const title = document.createElement('span');
        title.className = 'dup-group-title';
        title.textContent = t('dup.groupTitle', '{count} images · similarity ≥ {sim}%', {
            count: group.members.length,
            sim: Math.round((group.similarity || 0) * 100),
        });
        header.appendChild(title);

        const actions = document.createElement('div');
        actions.className = 'dup-group-actions';
        const keepBest = document.createElement('button');
        keepBest.type = 'button';
        keepBest.className = 'btn btn-ghost btn-small';
        keepBest.dataset.testid = 'dup-keep-best';
        keepBest.textContent = t('dup.keepBest', 'Keep best, trash rest');
        keepBest.addEventListener('click', () => {
            card.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
                const box = cb;
                box.checked = box.dataset.suggestedKeep !== '1';
            });
            deleteChecked(card, group);
        });
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn btn-ghost btn-small danger';
        deleteBtn.textContent = t('dup.deleteChecked', 'Trash checked…');
        deleteBtn.addEventListener('click', () => deleteChecked(card, group));
        actions.append(keepBest, deleteBtn);
        header.appendChild(actions);
        card.appendChild(header);

        const strip = document.createElement('div');
        strip.className = 'dup-member-strip';
        group.members.forEach((member) => strip.appendChild(buildMemberCard(member)));
        card.appendChild(strip);
        return card;
    }

    function buildMemberCard(member) {
        const box = document.createElement('label');
        box.className = 'dup-member' + (member.suggested_keep ? ' is-keeper' : '');

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'dup-member-check';
        checkbox.dataset.imageId = String(member.id);
        checkbox.dataset.suggestedKeep = member.suggested_keep ? '1' : '0';
        checkbox.checked = !member.suggested_keep;
        box.appendChild(checkbox);

        const link = document.createElement('a');
        link.href = `/api/image-file/${member.id}`;
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'dup-member-thumb-link';
        link.title = t('dup.openFull', 'Open full image in a new tab');
        const img = document.createElement('img');
        img.className = 'dup-member-thumb';
        img.loading = 'lazy';
        img.src = thumbnailUrl(member.id);
        img.alt = member.filename || String(member.id);
        link.appendChild(img);
        box.appendChild(link);

        if (member.suggested_keep) {
            const badge = document.createElement('span');
            badge.className = 'dup-keeper-badge';
            badge.textContent = t('dup.keeperBadge','Keep');
            box.appendChild(badge);
        }

        const meta = document.createElement('div');
        meta.className = 'dup-member-meta';
        const name = document.createElement('div');
        name.className = 'dup-member-name';
        name.textContent = member.filename || '';
        name.title = member.path || '';
        const facts = document.createElement('div');
        facts.className = 'dup-member-facts';
        const parts = [];
        if (member.width && member.height) parts.push(`${member.width}×${member.height}`);
        if (member.file_size) parts.push(formatBytes(member.file_size));
        if (member.aesthetic_score != null) parts.push(`A ${Number(member.aesthetic_score).toFixed(1)}`);
        if (member.user_rating) parts.push(`${'★'.repeat(Math.min(5, member.user_rating))}`);
        facts.textContent = parts.join(' · ');
        meta.append(name, facts);
        box.appendChild(meta);
        return box;
    }

    // ------------------------------------------------------------------
    // Deletion (reuses the trash-backed pipeline)
    // ------------------------------------------------------------------

    function collectChecked(root) {
        return Array.from(
            root.querySelectorAll('input.dup-member-check:checked'),
            (cb) => Number(cb.dataset.imageId),
        ).filter((id) => Number.isFinite(id) && id > 0);
    }

    async function deleteChecked(card, group) {
        const ids = collectChecked(card);
        if (ids.length === 0) {
            showToast(t('dup.nothingChecked', 'Nothing is checked in this group'), 'info');
            return;
        }
        if (ids.length >= group.members.length) {
            const confirmAll = window.confirm(t(
                'dup.confirmWholeGroup',
                'Every image in this group is checked, so the whole group goes to the trash, keeper included. Continue?',
            ));
            if (!confirmAll) return;
        } else if (!window.confirm(t('dup.confirmDelete', 'Move {count} images to the trash?', { count: ids.length }))) {
            return;
        }
        const outcome = await runDelete(ids);
        if (!reportTrashOutcome(outcome)) return;
        window.App?.markGalleryNeedsRefresh?.();
        if (outcome.moved === ids.length) {
            card.remove();
            adjustSummaryAfterDelete(ids.length);
        } else {
            // Some pictures are still there: show the groups as they are now.
            await loadGroups(true);
        }
    }

    async function applyAllSuggestions() {
        if (!STATE.summary || STATE.deleting) return;
        const redundant = STATE.summary.redundant_count || 0;
        if (redundant === 0) return;
        const confirmed = window.confirm(t(
            'dup.confirmApplyAll',
            'Keep the suggested best image of EVERY group and move the other {count} images to the trash?',
            { count: redundant },
        ));
        if (!confirmed) return;

        // Collect losers across ALL groups from the persisted scan (not just
        // the rendered page).
        const ids = [];
        try {
            let offset = 0;
            for (;;) {
                const r = await fetch(`/api/duplicates/groups?offset=${offset}&limit=200`);
                if (!r.ok) throw new Error(`groups ${r.status}`);
                const data = await r.json();
                (data.groups || []).forEach((g) => g.members.forEach((m) => {
                    if (!m.suggested_keep) ids.push(m.id);
                }));
                if (!data.has_more) break;
                offset += (data.groups || []).length;
            }
        } catch {
            showToast(t('dup.loadFailed', 'Could not load duplicate groups'), 'error');
            return;
        }
        if (ids.length === 0) return;
        const outcome = await runDelete(ids);
        if (reportTrashOutcome(outcome)) {
            window.App?.markGalleryNeedsRefresh?.();
            await loadGroups(true);
        }
    }

    // Say what a trash run did: how many pictures moved, how many could not
    // and the first reason. Returns false when nothing ran.
    function reportTrashOutcome(outcome) {
        if (!outcome) return false;
        if (outcome.moved === null) {
            showToast(t('dup.deleteUnknown', 'Could not find out how the move to the trash ended. The list below shows what is left.'), 'warning');
            return true;
        }
        if (outcome.failed > 0) {
            const line = t('dup.deletedPartial', 'Moved {count} images to trash; {failed} could not be moved.', {
                count: outcome.moved,
                failed: outcome.failed,
            });
            showToast(outcome.reason ? `${line} ${outcome.reason}` : line, 'warning');
            return true;
        }
        showToast(t('dup.deleted', 'Moved {count} images to trash', { count: outcome.moved }), 'success');
        return true;
    }

    // What the trash run did: { moved, failed, reason }, moved = null when the
    // run was lost track of, or null when it did not run.
    async function runDelete(ids) {
        if (STATE.deleting) return null;
        STATE.deleting = true;
        try {
            const useBackground = ids.length >= BACKGROUND_DELETE_THRESHOLD;
            const r = await fetch('/api/images/delete-selected', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_ids: ids,
                    confirm_delete_files: true,
                    background: useBackground,
                }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || data.detail || `HTTP ${r.status}`);
            if (useBackground && data.job_id) {
                const job = await waitForJob(data.job_id);
                if (!job) return { moved: null, failed: null, reason: '' };
                const moved = Number(job.result?.deleted) || 0;
                const sample = Array.isArray(job.error_samples) ? job.error_samples[0] : '';
                // A finished job's message is its success line, not a reason.
                const stopped = job.status === 'done' ? '' : job.message;
                return { moved, failed: ids.length - moved, reason: sample || stopped || '' };
            }
            const failedList = Array.isArray(data.failed) ? data.failed : [];
            const moved = Number(data.deleted) || 0;
            return { moved, failed: ids.length - moved, reason: failedList[0]?.error || '' };
        } catch (err) {
            const context = t('dup.deleteFailed', 'Trash operation failed');
            showToast(typeof window.formatUserError === 'function'
                ? window.formatUserError(err, context)
                : `${context}: ${err.message}`, 'error');
            return null;
        } finally {
            STATE.deleting = false;
        }
    }

    async function waitForJob(jobId) {
        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            try {
                const r = await fetch(`/api/bulk-jobs/${jobId}`);
                if (!r.ok) return null;
                const job = await r.json();
                updateProgress(job);
                if (['done', 'cancelled', 'error'].includes(job.status)) return job;
            } catch {
                return null;
            }
        }
    }

    function scanCoverageIncomplete(summary) {
        const s = summary || {};
        if (s.exact === false) return true;
        const embedded = Number(s.embedded_count);
        if (Number.isFinite(embedded) && embedded < 2) return true;
        const pending = Number(s.pending_count);
        return Number.isFinite(pending) && pending > 0;
    }

    function summaryParams(summary) {
        const s = summary || {};
        return {
            groups: s.group_count ?? 0,
            redundant: s.redundant_count ?? 0,
            bytes: formatBytes(s.reclaimable_bytes),
            embedded: s.embedded_count ?? 0,
            total: s.total_images ?? 0,
            pending: s.pending_count ?? 0,
            coverage: s.coverage ?? 0,
        };
    }

    function formatIncompleteScanToast(summary) {
        return t(
            'dup.scanDoneIncomplete',
            'Duplicate scan finished, but only {embedded}/{total} images are indexed, so 0 groups does not mean the whole library is clean. Build the index in Similar first.',
            summaryParams(summary),
        );
    }

    function writeSummaryText(summary) {
        const text = $('dup-summary-text');
        if (!text) return;
        const s = summary || {};
        if (scanCoverageIncomplete(s)) {
            text.textContent = t(
                'dup.summaryIncomplete',
                '{groups} groups from the {embedded}/{total} indexed images ({coverage}%). {pending} images are not indexed yet, so 0 groups does not mean the whole library is clean.',
                summaryParams(s),
            );
            return;
        }
        text.textContent = t(
            'dup.summary',
            '{groups} groups · {redundant} redundant images · ~{bytes} reclaimable',
            summaryParams(s),
        );
    }

    function adjustSummaryAfterDelete(removedCount) {
        if (!STATE.summary) return;
        STATE.summary.group_count = Math.max(0, (STATE.summary.group_count || 0) - 1);
        STATE.summary.redundant_count = Math.max(0, (STATE.summary.redundant_count || 0) - removedCount);
        writeSummaryText(STATE.summary);
    }

    // ------------------------------------------------------------------
    // Boot
    // ------------------------------------------------------------------

    function bind() {
        $('nav-tools-dup-cleaner')?.addEventListener('click', () => {
            const menu = $('nav-tools-menu');
            if (menu) menu.hidden = true;
            open();
        });
        $('btn-close-dup-cleaner')?.addEventListener('click', close);
        $('btn-dup-scan')?.addEventListener('click', startScan);
        $('btn-dup-cancel-scan')?.addEventListener('click', cancelScan);
        $('btn-dup-load-more')?.addEventListener('click', () => loadGroups(false));
        $('btn-dup-apply-all')?.addEventListener('click', applyAllSuggestions);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }

    window.DupCleaner = { open };
})();
