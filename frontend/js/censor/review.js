/**
 * Censor Editor - review conveyor (split VERBATIM from censor-edit.js; god-file decomposition).
 * 3-tab shell (brush/adjust/review), review-detect checklist overlay, approve/skip conveyor; exports window.initCensorEdit / window.cleanupCensorView.
 * Shared top-level bindings (CensorState, ...) are declared in censor/state.js;
 * classic-script global lexical scoping keeps them single instances across parts.
 * Load order is pinned in index.html - see censor/state.js for the full note.
 */
// ============== 3-tab shell + 审核 review conveyor (Aurora Phase 3 Slice 2) ==============
//
// The review conveyor is an ADDITIVE guided mode: detect an image, review the
// detected regions as a purple overlay + keep/exclude checklist, then Approve
// (bakes the kept regions via applyDetectedRegionsToItem — the same path the
// free-form auto-detect uses) and auto-advance. The free-form brush/detect flow
// on the Brush tab is untouched.

const CensorReviewState = {
    regions: [],          // regions from the last review-detect for the active item
    data: null,           // raw detect response (holds combined_mask for approve-all)
    excluded: new Set(),  // region indices the user unchecked (keep uncensored)
    detectedForId: null,  // which item id the current regions belong to
    busy: false,
};

function initCensorTabs() {
    document.querySelectorAll('.censor-tab[data-censor-tab]').forEach((tab) => {
        tab.addEventListener('click', () => setCensorTab(tab.dataset.censorTab));
    });
}

function setCensorTab(name) {
    const target = ['brush', 'adjust', 'review'].includes(name) ? name : 'brush';
    document.querySelectorAll('.censor-tab[data-censor-tab]').forEach((tab) => {
        const on = tab.dataset.censorTab === target;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.censor-tab-pane[data-censor-pane]').forEach((pane) => {
        pane.classList.toggle('is-active', pane.dataset.censorPane === target);
    });
    if (target === 'review') {
        updateCensorReviewPanel();
    } else {
        // The annotation overlay is a review-only affordance — never let it linger
        // over the brush/adjust workflows.
        clearCensorReviewOverlay();
    }
}

function isCensorReviewActive() {
    return Boolean(document.querySelector('.censor-tab[data-censor-tab="review"]')?.classList.contains('is-active'));
}

function getCensorReviewOrderedIds() {
    return (CensorState.queue || []).map((i) => i.id);
}

function getCensorReviewOverlayCanvas() {
    return document.getElementById('censor-review-overlay');
}

function clearCensorReviewOverlay() {
    const overlay = getCensorReviewOverlayCanvas();
    if (!overlay) return;
    overlay.style.opacity = '0';
    const ctx = overlay.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
}

// Draw the detected regions onto the review overlay canvas (kept = purple = AI
// output; excluded = dimmed dashed). The overlay shares the content canvas's
// buffer + fitted size and lives inside the same transformed container, so the
// boxes track the image under pan/zoom without extra math.
function drawCensorReviewOverlay() {
    const overlay = getCensorReviewOverlayCanvas();
    const content = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!overlay || !content || !content.width || !content.height) {
        clearCensorReviewOverlay();
        return;
    }
    overlay.width = content.width;
    overlay.height = content.height;
    fitCanvasToContainer(overlay, content.width, content.height);

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const lineW = Math.max(2, Math.round(Math.min(overlay.width, overlay.height) / 300));
    const purple = getComputedStyle(document.documentElement).getPropertyValue('--purple').trim() || '#A78BFF';
    // Region coords are in ORIGINAL image space; in proxy mode the content canvas
    // is a downscaled proxy, so scale to it.
    const scale = (CensorState.proxyEditMode && CensorState.originalLogicalWidth > 0)
        ? overlay.width / CensorState.originalLogicalWidth
        : 1;

    CensorReviewState.regions.forEach((region, index) => {
        const excluded = CensorReviewState.excluded.has(index);
        ctx.lineWidth = lineW;
        ctx.strokeStyle = excluded ? 'rgba(255,255,255,0.35)' : purple;
        ctx.setLineDash(excluded ? [lineW * 3, lineW * 2] : []);
        const poly = Array.isArray(region.polygon)
            ? region.polygon.filter((p) => Array.isArray(p) && p.length >= 2)
            : [];
        if (poly.length >= 3) {
            ctx.beginPath();
            poly.forEach(([px, py], i) => {
                const x = px * scale;
                const y = py * scale;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
            ctx.closePath();
            ctx.stroke();
        } else if (Array.isArray(region.box) && region.box.length === 4) {
            const [x1, y1, x2, y2] = region.box.map((v) => v * scale);
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        }
    });
    ctx.setLineDash([]);
    overlay.style.opacity = '1';
}

function getCensorReviewRegionLabel(region) {
    const raw = region?.label || region?.class || region?.class_name || region?.name || 'region';
    return String(raw).replace(/_/g, ' ');
}

function renderCensorReviewRegions() {
    const host = document.getElementById('censor-review-regions');
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    const fresh = CensorReviewState.detectedForId === CensorState.activeId;
    if (!fresh || CensorReviewState.regions.length === 0) return;

    CensorReviewState.regions.forEach((region, index) => {
        const row = document.createElement('label');
        row.className = 'censor-review-region';
        if (CensorReviewState.excluded.has(index)) row.classList.add('is-excluded');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !CensorReviewState.excluded.has(index);
        cb.addEventListener('change', () => {
            if (cb.checked) CensorReviewState.excluded.delete(index);
            else CensorReviewState.excluded.add(index);
            row.classList.toggle('is-excluded', !cb.checked);
            drawCensorReviewOverlay();
        });

        const label = document.createElement('span');
        label.className = 'censor-review-region-label';
        label.textContent = getCensorReviewRegionLabel(region);

        const conf = document.createElement('span');
        conf.className = 'censor-review-region-conf';
        conf.textContent = Math.round((Number(region.confidence) || 0) * 100) + '%';

        row.append(cb, label, conf);
        host.append(row);
    });
}

function updateCensorReviewPanel() {
    const ids = getCensorReviewOrderedIds();
    const total = ids.length;
    const idx = CensorState.activeId != null ? ids.indexOf(CensorState.activeId) : -1;
    const hasActive = idx >= 0;

    // Regions belong to a single item; drop them if the active item changed.
    const fresh = CensorReviewState.detectedForId != null && CensorReviewState.detectedForId === CensorState.activeId;
    if (!fresh && CensorReviewState.detectedForId != null && CensorReviewState.detectedForId !== CensorState.activeId) {
        CensorReviewState.regions = [];
        CensorReviewState.excluded = new Set();
        CensorReviewState.data = null;
        CensorReviewState.detectedForId = null;
    }
    const hasRegions = CensorReviewState.detectedForId === CensorState.activeId && CensorReviewState.regions.length > 0;

    const progressEl = document.getElementById('censor-review-progress');
    if (progressEl) {
        progressEl.textContent = (total > 0 && hasActive)
            ? censorT('censor.reviewProgress', { current: idx + 1, total }, 'Reviewing {current} / {total}')
            : '— / —';
    }

    const prevBtn = document.getElementById('btn-review-prev');
    const nextBtn = document.getElementById('btn-review-next');
    const detectBtn = document.getElementById('btn-review-detect');
    const approveBtn = document.getElementById('btn-review-approve');
    const skipBtn = document.getElementById('btn-review-skip');
    if (prevBtn) prevBtn.disabled = idx <= 0;
    if (nextBtn) nextBtn.disabled = !hasActive || idx >= total - 1;
    if (detectBtn) detectBtn.disabled = !hasActive || CensorReviewState.busy;
    if (skipBtn) skipBtn.disabled = !hasActive || idx >= total - 1;
    if (approveBtn) approveBtn.disabled = !hasActive || !hasRegions || CensorReviewState.busy;

    const detectLabel = document.getElementById('censor-review-detect-label');
    if (detectLabel) {
        detectLabel.textContent = hasRegions
            ? censorT('censor.reviewRedetect', null, 'Re-detect')
            : censorT('censor.reviewDetect', null, 'Detect this image');
    }

    renderCensorReviewRegions();
    if (isCensorReviewActive() && hasRegions) {
        drawCensorReviewOverlay();
    } else {
        clearCensorReviewOverlay();
    }

    // Status line: only own the empty / detect-first cases; a fresh detect owns
    // its own "N regions" / "none" message set in censorReviewDetect.
    const statusEl = document.getElementById('censor-review-status');
    if (statusEl && !CensorReviewState.busy) {
        if (!hasActive) {
            statusEl.textContent = total === 0
                ? censorT('censor.reviewEmptyQueue', null, 'Queue is empty. Send images from the Gallery first.')
                : '';
        } else if (CensorReviewState.detectedForId !== CensorState.activeId) {
            statusEl.textContent = censorT('censor.reviewDetectFirst', null, 'Detect first to review regions on this image.');
        }
    }
}

async function censorReviewDetect() {
    const item = CensorState.queue.find((i) => i.id === CensorState.activeId);
    if (!item || CensorReviewState.busy) return;
    CensorReviewState.busy = true;
    updateCensorReviewPanel();
    const statusEl = document.getElementById('censor-review-status');
    const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
    let failureMessage = '';
    setStatus(censorT('censor.processing', null, 'Processing...'));

    try {
        const plan = await resolveQuickAutoCensorExecutionPlan({ silent: false });
        if (!plan?.ok) {
            CensorReviewState.regions = [];
            CensorReviewState.detectedForId = null;
            failureMessage = plan?.message || censorT('censor.detectFailed', null, 'Detection failed');
            setStatus(failureMessage);
            return;
        }
        const detectBody = {
            image_id: item.id,
            model_path: plan.modelPath,
            model_type: plan.modelType,
            confidence_threshold: CensorState.confidence,
            target_classes: plan.targetClasses,
        };
        if (plan.modelType === 'sam3') {
            const customInput = document.getElementById('sam3-custom-prompt')?.value?.trim();
            if (customInput) detectBody.text_prompts = customInput.split(',').map((s) => s.trim()).filter(Boolean);
        }
        const data = await window.App.API.post('/api/censor/detect', detectBody);
        const detectionWarnings = readCensorDetectionWarnings(data);
        const useBoxShape = CensorState.maskShape === 'box';
        const raw = [...(data.detections || [])].sort((a, b) => b.confidence - a.confidence);
        const regions = useBoxShape ? raw.map(({ polygon, mask, ...rest }) => rest) : raw;

        CensorReviewState.regions = regions;
        CensorReviewState.data = data;
        CensorReviewState.excluded = new Set();
        CensorReviewState.detectedForId = item.id;

        setStatus(regions.length === 0
            ? censorT('censor.reviewNoRegions', null, 'No regions detected. Try a lower confidence or another model.')
            : censorT('censor.reviewRegionsFound', { count: regions.length }, '{count} region(s) found — uncheck any to leave it uncensored'));
        if (detectionWarnings.length > 0) {
            window.App.showToast(detectionWarnings.join(' '), 'warning');
        }
    } catch (e) {
        Logger.error(e);
        CensorReviewState.regions = [];
        CensorReviewState.detectedForId = null;
        failureMessage = formatUserError(e, censorT('censor.detectFailed', null, 'Detection failed'));
        setStatus(failureMessage);
    } finally {
        CensorReviewState.busy = false;
        updateCensorReviewPanel();
        if (failureMessage) setStatus(failureMessage);
    }
}

async function censorReviewApprove() {
    const item = CensorState.queue.find((i) => i.id === CensorState.activeId);
    if (!item || CensorReviewState.busy) return;
    if (CensorReviewState.detectedForId !== item.id || CensorReviewState.regions.length === 0) return;
    CensorReviewState.busy = true;
    updateCensorReviewPanel();

    try {
        const keptRaw = CensorReviewState.regions.filter((_, i) => !CensorReviewState.excluded.has(i));
        const excludedAny = keptRaw.length !== CensorReviewState.regions.length;
        let didCensor = false;
        if (keptRaw.length > 0) {
            // The precise combined mask covers ALL detected regions, so it can't
            // stand in for a subset. When the user excluded any region, censor the
            // kept ones by their BOXES: strip polygon/mask so splitDetectionGeometry
            // routes them to boxRegions (every detection carries a box). This
            // GUARANTEES the kept regions are covered — leaving the polygons on with
            // the combined mask nulled would drop them into maskRegions with no mask
            // and censor nothing (the bug the review caught). Box is looser than the
            // precise outline but always safe; approve-all still uses the mask.
            const kept = excludedAny
                ? keptRaw.map(({ polygon, mask, ...rest }) => rest)
                : keptRaw;
            const data = excludedAny
                ? { ...CensorReviewState.data, combined_mask: null, combined_mask_ref: null, combined_mask_bounds: null }
                : (CensorReviewState.data || {});
            await applyDetectedRegionsToItem(item, kept, data);
            didCensor = Boolean(item.isProcessed);
            if (didCensor) {
                item.isModified = true;
                renderQueue();
            }
        }

        // Never pass an uncensored image off as "approved". If regions were kept
        // but nothing baked (e.g. a detection lacked a usable box), fail loud and
        // stay on this image so the user can retry with Box shape or the Brush tab.
        if (keptRaw.length > 0 && !didCensor) {
            window.App.showToast(
                censorT('censor.reviewApproveNothingBaked', null, 'Could not censor the kept regions — nothing was changed. Try switching Shape to Box, or the Brush tab.'),
                'error'
            );
            return;
        }

        const count = keptRaw.length;
        window.App.showToast(
            count > 0
                ? censorT('censor.reviewApproved', { count }, 'Approved {count} region(s) — moved to the next image')
                : censorT('censor.reviewApprovedNone', null, 'Approved with nothing censored — moved on'),
            'success'
        );

        CensorReviewState.regions = [];
        CensorReviewState.excluded = new Set();
        CensorReviewState.data = null;
        CensorReviewState.detectedForId = null;
        clearCensorReviewOverlay();
        censorReviewGoTo(1, { atEndMessage: true });
    } catch (e) {
        Logger.error(e);
        window.App.showToast(formatUserError(e, censorT('censor.detectFailed', null, 'Detection failed')), 'error');
    } finally {
        CensorReviewState.busy = false;
        updateCensorReviewPanel();
    }
}

// Advance/retreat through the queue. loadCanvasImage refreshes the review panel
// from its RAF finalize hook once the new active id is committed.
function censorReviewGoTo(delta, { atEndMessage = false } = {}) {
    const ids = getCensorReviewOrderedIds();
    if (ids.length === 0) return;
    const idx = CensorState.activeId != null ? ids.indexOf(CensorState.activeId) : -1;
    if (idx < 0) {
        loadCanvasImage(ids[0]);
        return;
    }
    const next = idx + delta;
    if (next >= 0 && next < ids.length) {
        loadCanvasImage(ids[next]);
    } else if (atEndMessage && next >= ids.length) {
        const statusEl = document.getElementById('censor-review-status');
        if (statusEl) statusEl.textContent = censorT('censor.reviewAllDone', null, 'Queue fully reviewed — nothing left');
    }
}

// Export
window.initCensorEdit = initCensorEdit;
window.cleanupCensorView = cleanupCensorViewFull;

