/**
 * Censor Editor - queue composition (split VERBATIM from censor-edit.js; god-file decomposition).
 * Queue CRUD/order/selection helpers, P3-11 localStorage persistence, token-backed queue windows, batch iteration (processCensorBatchItems).
 * Shared top-level bindings (CensorState, ...) are declared in censor/state.js;
 * classic-script global lexical scoping keeps them single instances across parts.
 * Load order is pinned in index.html - see censor/state.js for the full note.
 */
function normalizeCensorImageIds(rawIds) {
    return Array.from(new Set((Array.isArray(rawIds) ? rawIds : [rawIds])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)));
}

function normalizeTokenQueueSourcePayload(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return null;
    }

    const selectionToken = String(source.selectionToken || source.selection_token || '').trim();
    if (!selectionToken) return null;

    return {
        selectionToken,
        total: Math.max(0, Number(source.total ?? source.selectionTotal ?? source.selection_total ?? 0) || 0),
        exactTotal: source.exactTotal !== false && source.exact_total !== false,
        filterKey: typeof source.filterKey === 'string' ? source.filterKey : null,
        visibleImageIds: normalizeCensorImageIds(source.visibleImageIds || source.visible_image_ids || []),
        nextOffset: 0,
        hasMore: true,
        loadedCount: 0,
        loadedIds: new Set(),
        loading: false,
    };
}

function hasTokenQueueSource() {
    return Boolean(CensorState.tokenQueueSource?.selectionToken);
}

function getTokenQueueTotal() {
    const source = CensorState.tokenQueueSource;
    if (!source?.selectionToken) return 0;
    return Math.max(0, Number(source.total || source.loadedCount || 0) || 0);
}

function getCensorQueueWorkCount() {
    return Math.max(CensorState.queue.length, getTokenQueueTotal());
}

function hasCensorQueueWork() {
    return getCensorQueueWorkCount() > 0;
}

function switchToCensorView() {
    const censorTab = document.querySelector('.nav-tab[data-view="censor"]');
    if (censorTab) {
        censorTab.click();
    } else if (typeof window.App?.switchView === 'function') {
        window.App.switchView('censor');
    }

    const censorView = document.getElementById('view-censor');
    if (censorView) {
        censorView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function buildCensorQueueItemFromImage(image) {
    const id = Number(image?.id);
    if (!Number.isFinite(id) || id <= 0 || !image?.filename) {
        return null;
    }

    const api = window.App?.API;
    return {
        id,
        originalFilename: image.filename,
        outputFilename: image.filename,
        originalUrl: typeof api?.getImageUrl === 'function' ? api.getImageUrl(id) : `/api/image-file/${id}`,
        currentDataUrl: null,
        previewDataUrl: null,
        width: Number(image.width || 0),
        height: Number(image.height || 0),
        editOperations: [],
        regions: [],
        isProcessed: false,
        isModified: false,
    };
}

function appendCensorQueueImages(images = [], { tokenSource = null } = {}) {
    const queueIds = new Set(CensorState.queue.map((item) => item.id));
    const nextItems = [];

    (Array.isArray(images) ? images : []).forEach((image) => {
        const item = buildCensorQueueItemFromImage(image);
        if (!item || queueIds.has(item.id) || CensorState.pendingQueueIds.has(item.id)) {
            if (item && tokenSource?.loadedIds) tokenSource.loadedIds.add(item.id);
            return;
        }

        queueIds.add(item.id);
        nextItems.push(item);
        if (tokenSource?.loadedIds) tokenSource.loadedIds.add(item.id);
    });

    if (nextItems.length > 0) {
        CensorState.queue.push(...nextItems);
    }

    if (tokenSource?.loadedIds) {
        tokenSource.loadedCount = tokenSource.loadedIds.size;
    }

    return nextItems;
}

// ---------------------------------------------------------------------------
// Queue persistence (QA P3-11): the sort session survives a reload, but the
// censor queue used to vanish on F5. Persist the queue COMPOSITION (ids,
// order, output names) in localStorage and restore it on init. Canvas edits
// and processing state deliberately do NOT survive: an item must never LOOK
// censored without its pixels (never-fallback-to-uncensored invariant), so
// restored items always come back as unprocessed.
// ---------------------------------------------------------------------------

const CENSOR_QUEUE_STORE_KEY = 'censor-queue-v1';
const CENSOR_QUEUE_STORE_LIMIT = 500;

function persistCensorQueue() {
    try {
        const items = CensorState.queue
            .filter((item) => Number.isFinite(Number(item?.id)) && Number(item.id) > 0 && item.originalFilename)
            .slice(0, CENSOR_QUEUE_STORE_LIMIT)
            .map((item) => ({
                id: Number(item.id),
                originalFilename: String(item.originalFilename),
                outputFilename: String(item.outputFilename || item.originalFilename),
                width: Number(item.width || 0),
                height: Number(item.height || 0),
            }));
        if (!items.length) {
            localStorage.removeItem(CENSOR_QUEUE_STORE_KEY);
            return;
        }
        localStorage.setItem(CENSOR_QUEUE_STORE_KEY, JSON.stringify({ version: 1, items }));
    } catch (_) {
        // Persistence is best-effort; a full/blocked localStorage must never
        // break the censor workspace itself.
    }
}

function restoreCensorQueueFromStorage() {
    // One attempt per page load: a queue the user emptied later in the session
    // must not resurrect on the next view switch.
    if (CensorState._queueRestoreDone) return 0;
    CensorState._queueRestoreDone = true;
    if (CensorState.queue.length > 0 || hasTokenQueueSource()) return 0;

    let payload = null;
    try {
        payload = JSON.parse(localStorage.getItem(CENSOR_QUEUE_STORE_KEY) || 'null');
    } catch (_) {
        return 0;
    }
    const saved = Array.isArray(payload?.items) ? payload.items : [];
    if (!saved.length) return 0;

    const restored = appendCensorQueueImages(saved.map((item) => ({
        id: item.id,
        filename: item.originalFilename,
        width: item.width,
        height: item.height,
    })));
    const savedById = new Map(saved.map((item) => [Number(item.id), item]));
    restored.forEach((item) => {
        const stored = savedById.get(Number(item.id));
        if (stored?.outputFilename) item.outputFilename = String(stored.outputFilename);
    });
    return restored.length;
}

async function fetchTokenQueueDataPage(offset = 0, limit = CENSOR_TOKEN_QUEUE_WINDOW_SIZE) {
    const source = CensorState.tokenQueueSource;
    const loader = window.App?.loadSelectionDataByToken;
    if (!source?.selectionToken || typeof loader !== 'function') {
        throw new Error('Token-backed Censor queue is not available');
    }

    return loader(source.selectionToken, {
        offset: Math.max(0, Number(offset) || 0),
        limit: Math.max(1, Math.min(Number(limit) || CENSOR_TOKEN_QUEUE_WINDOW_SIZE, CENSOR_TOKEN_QUEUE_WINDOW_SIZE)),
    });
}

function updateTokenQueueSourceFromPage(source, page, fallbackOffset = 0) {
    if (!source || !page) return;

    const images = Array.isArray(page.images) ? page.images : [];
    const pageTotal = Number(page.total || 0);
    if (Number.isFinite(pageTotal) && pageTotal > 0) {
        source.total = Math.max(source.total || 0, pageTotal);
    } else {
        source.total = Math.max(source.total || 0, Number(fallbackOffset || 0) + images.length);
    }

    source.exactTotal = page.exact_total !== false;

    const nextOffset = Number(page.next_offset);
    source.nextOffset = page.has_more && Number.isFinite(nextOffset) && nextOffset >= 0
        ? nextOffset
        : null;
    source.hasMore = Boolean(page.has_more && source.nextOffset !== null);
}

async function loadTokenQueueWindow({ offset = 0, limit = CENSOR_TOKEN_QUEUE_WINDOW_SIZE, activateFirst = false } = {}) {
    const source = CensorState.tokenQueueSource;
    if (!source?.selectionToken || source.loading) {
        return { images: [], items: [] };
    }

    source.loading = true;
    renderTokenQueueLoadMoreControl(document.getElementById('censor-queue-list'));

    try {
        const page = await fetchTokenQueueDataPage(offset, limit);
        updateTokenQueueSourceFromPage(source, page, offset);
        const items = appendCensorQueueImages(page.images || [], { tokenSource: source });
        renderQueue();

        if (activateFirst && !CensorState.activeId && CensorState.queue.length > 0) {
            setTimeout(() => loadCanvasImage(CensorState.queue[0].id), 100);
        }

        return {
            ...page,
            images: Array.isArray(page.images) ? page.images : [],
            items,
        };
    } finally {
        source.loading = false;
        renderTokenQueueLoadMoreControl(document.getElementById('censor-queue-list'));
    }
}

async function loadNextTokenQueueWindow() {
    const source = CensorState.tokenQueueSource;
    if (!source?.selectionToken || source.loading || !source.hasMore || source.nextOffset === null) {
        return { images: [], items: [] };
    }

    return loadTokenQueueWindow({
        offset: source.nextOffset,
        limit: CENSOR_TOKEN_QUEUE_WINDOW_SIZE,
    });
}

async function addTokenBackedQueue(sourcePayload) {
    const source = normalizeTokenQueueSourcePayload(sourcePayload);
    if (!source) return false;

    switchToCensorView();
    CensorState.tokenQueueSource = source;

    try {
        let loadedItems = [];
        const visibleIds = source.visibleImageIds.slice(0, CENSOR_TOKEN_QUEUE_WINDOW_SIZE);
        const selectionLoader = window.App?.loadSelectionData;
        if (visibleIds.length > 0 && typeof selectionLoader === 'function') {
            try {
                const payload = await selectionLoader(visibleIds);
                loadedItems = appendCensorQueueImages(payload?.images || [], { tokenSource: source });
                renderQueue();
                if (!CensorState.activeId && CensorState.queue.length > 0) {
                    setTimeout(() => loadCanvasImage(CensorState.queue[0].id), 100);
                }
            } catch (error) {
                Logger.warn('Failed to load visible Censor queue window, falling back to token page', error);
            }
        }

        if (loadedItems.length === 0) {
            const page = await loadTokenQueueWindow({
                offset: 0,
                limit: CENSOR_TOKEN_QUEUE_WINDOW_SIZE,
                activateFirst: true,
            });
            loadedItems = page.items || [];
        } else {
            renderTokenQueueLoadMoreControl(document.getElementById('censor-queue-list'));
        }

        if (!loadedItems.length && source.total === 0) {
            window.App?.showToast?.(
                censorT('censor.queueEmpty', null, 'Queue is empty'),
                'info'
            );
        }
        return true;
    } catch (error) {
        CensorState.tokenQueueSource = null;
        renderQueue();
        window.App?.showToast?.(
            formatUserError(error, censorT('censor.queueAddFailed', { count: source.total || 1 }, 'Failed to queue {count} image(s) for Censor.')),
            'error'
        );
        return false;
    }
}

function renderTokenQueueLoadMoreControl(list) {
    if (!list) return;

    const existing = list.querySelector('.queue-token-window-control');
    const source = CensorState.tokenQueueSource;
    if (!source?.selectionToken) {
        existing?.remove();
        return;
    }

    let control = existing;
    if (!control) {
        control = document.createElement('div');
        control.className = 'queue-token-window-control';
        control.innerHTML = `
            <div class="queue-token-window-summary"></div>
            <button class="btn btn-secondary btn-small" type="button"></button>
        `;
        control.querySelector('button')?.addEventListener('click', () => {
            loadNextTokenQueueWindow();
        });
    }

    const loaded = Math.max(0, Number(source.loadedCount || 0) || 0);
    const total = source.total || loaded;
    const summary = control.querySelector('.queue-token-window-summary');
    const button = control.querySelector('button');
    if (summary) {
        summary.textContent = total > loaded
            ? `Loaded ${loaded.toLocaleString()} of ${total.toLocaleString()} filtered images`
            : `Loaded ${loaded.toLocaleString()} filtered images`;
    }
    if (button) {
        button.textContent = source.loading
            ? censorT('common.loading', null, 'Loading...')
            : censorT('common.loadMore', null, 'Load more');
        button.disabled = Boolean(source.loading || !source.hasMore);
        button.style.display = source.hasMore ? '' : 'none';
    }

    list.appendChild(control);
}

// ============== Queue Logic ==============

const CENSOR_BATCH_OUTCOME_LABELS = Object.freeze({
    saved: Object.freeze({ key: 'censor.batchOutcomeSaved', fallback: 'Saved' }),
    skipped: Object.freeze({ key: 'censor.batchOutcomeSkipped', fallback: 'Skipped' }),
    failed: Object.freeze({ key: 'censor.batchOutcomeFailed', fallback: 'Failed' }),
    refined: Object.freeze({ key: 'censor.batchOutcomeRefined', fallback: 'Refined' }),
    censored: Object.freeze({ key: 'censor.batchOutcomeCensored', fallback: 'Censored' }),
    'no-match': Object.freeze({ key: 'censor.batchOutcomeNoMatch', fallback: 'No match' }),
});

function getCensorBatchOutcome(item) {
    const status = typeof item?.batchStatus === 'string' ? item.batchStatus : '';
    if (status === 'saved' || status === 'skipped' || status === 'failed' || status === 'refined') {
        return status;
    }
    if (status === 'done' || status === 'detected') {
        return Number(item.batchRegionCount) > 0 ? 'censored' : 'no-match';
    }
    return null;
}

function getCensorBatchOutcomePresentation(item) {
    const code = getCensorBatchOutcome(item);
    if (!code) return null;

    const definition = CENSOR_BATCH_OUTCOME_LABELS[code];
    const label = censorT(definition.key, null, definition.fallback);
    if (code !== 'failed') {
        return Object.freeze({
            code,
            label,
            isFailure: false,
            failureReason: '',
            failureAriaLabel: '',
            failureTooltip: '',
        });
    }

    const filename = String(item?.outputFilename || item?.originalFilename || item?.id || '').trim();
    const failureReason = String(item?.batchError || '').trim();
    return Object.freeze({
        code,
        label,
        isFailure: true,
        failureReason,
        failureAriaLabel: censorT(
            'censor.batchOutcomeFailureAria',
            { filename },
            'Show failure reason for {filename}'
        ),
        failureTooltip: censorT(
            'censor.batchOutcomeFailureTooltip',
            { reason: failureReason },
            'Failure reason: {reason}'
        ),
    });
}

function showCensorBatchFailureReason(item) {
    if (getCensorBatchOutcome(item) !== 'failed') {
        throw new TypeError('A censor batch failure reason can only be shown for an item with failed status.');
    }

    const failureReason = String(item?.batchError || '').trim();
    if (!failureReason) {
        throw new Error(`Censor queue item ${item?.id || 'unknown'} has failed status without a batchError.`);
    }
    if (typeof window.App?.showToast !== 'function') {
        throw new Error('Cannot show the censor batch failure reason because App.showToast is unavailable.');
    }

    window.App.showToast(failureReason, 'error');
}

function _resetBatchStatus(items = CensorState.queue) {
    items.forEach((item) => {
        delete item.batchStatus;
        delete item.batchError;
        delete item.batchRegionCount;
    });
}

function _summarizeBatchFailures(items = CensorState.queue) {
    const failed = items.filter((it) => it.batchStatus === 'failed');
    return {
        failedCount: failed.length,
        firstFailedName: failed[0]?.outputFilename || failed[0]?.originalFilename || '',
    };
}

// How many items ran a detection that actually matched ≥1 region. A detector
// that ran cleanly but found nothing (e.g. NudeNet on anime at a high
// threshold) is NOT a failure, but it also is not a "processed" success —
// runAutoCensorBatch reports it separately so the toast never claims work it
// did not do.
function _summarizeBatchDetections(items = CensorState.queue) {
    let appliedCount = 0;
    let emptyCount = 0;
    items.forEach((item) => {
        if (item.batchStatus === 'done') {
            if (Number(item.batchRegionCount) > 0) appliedCount += 1;
            else emptyCount += 1;
        }
    });
    return { appliedCount, emptyCount };
}

async function processCensorBatchItems(handler, { pageSize = CENSOR_TOKEN_QUEUE_WINDOW_SIZE } = {}) {
    const seenIds = new Set();
    let completed = 0;
    let total = getCensorQueueWorkCount();

    for (const item of CensorState.queue) {
        if (!item?.id || seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        await handler(item, {
            index: completed,
            total: Math.max(total, completed + 1),
            transient: false,
        });
        completed += 1;
    }

    const source = CensorState.tokenQueueSource;
    if (source?.selectionToken) {
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const page = await fetchTokenQueueDataPage(offset, pageSize);
            updateTokenQueueSourceFromPage(source, page, offset);
            total = Math.max(total, getTokenQueueTotal());

            const images = Array.isArray(page.images) ? page.images : [];
            for (const image of images) {
                const id = Number(image?.id);
                if (!Number.isFinite(id) || id <= 0 || seenIds.has(id)) continue;

                const existingItem = CensorState.queue.find((entry) => entry.id === id);
                const item = existingItem || buildCensorQueueItemFromImage(image);
                if (!item) continue;

                seenIds.add(id);
                await handler(item, {
                    index: completed,
                    total: Math.max(total, completed + 1),
                    transient: !existingItem,
                });
                completed += 1;
            }

            const nextOffset = Number(page.next_offset);
            hasMore = Boolean(page.has_more && Number.isFinite(nextOffset) && nextOffset >= 0);
            if (!hasMore) break;
            offset = nextOffset;
        }
    }

    return {
        completed,
        total: Math.max(total, completed),
    };
}

function moveQueueSelectionToPosition(targetPosition) {
    const selectedIds = getOrderedSelectedQueueIds();
    if (!selectedIds.length) {
        window.App.showToast(
            censorT('censor.queueMoveSelectionRequired', null, 'Select at least one queue item first'),
            'warning'
        );
        return;
    }

    const selectedSet = new Set(selectedIds);
    const selectedItems = CensorState.queue.filter((item) => selectedSet.has(item.id));
    const remainingItems = CensorState.queue.filter((item) => !selectedSet.has(item.id));
    const normalizedPosition = Math.min(
        Math.max((Number.isFinite(targetPosition) ? targetPosition : 1) - 1, 0),
        remainingItems.length
    );

    const nextQueue = [
        ...remainingItems.slice(0, normalizedPosition),
        ...selectedItems,
        ...remainingItems.slice(normalizedPosition),
    ];

    const changed = nextQueue.some((item, index) => item.id !== CensorState.queue[index]?.id);
    if (!changed) return;

    CensorState.queue = nextQueue;
    CensorState.lastSelectedIndex = CensorState.queue.findIndex((item) => item.id === selectedIds[0]);
    renderQueue();
    scrollQueueItemIntoView(selectedIds[0]);
}

function reorderQueueByDraggedTarget(draggedId, targetId) {
    if (!draggedId || !targetId || draggedId === targetId) return false;

    const moveAsGroup = CensorState.selectedItems.size > 1 && CensorState.selectedItems.has(draggedId);
    const movingIds = moveAsGroup ? getOrderedSelectedQueueIds() : [draggedId];
    const movingSet = new Set(movingIds);
    const originalDraggedIndex = CensorState.queue.findIndex((item) => item.id === draggedId);
    const originalTargetIndex = CensorState.queue.findIndex((item) => item.id === targetId);
    const movingItems = CensorState.queue.filter((item) => movingSet.has(item.id));
    const remainingItems = CensorState.queue.filter((item) => !movingSet.has(item.id));
    let insertIndex = remainingItems.findIndex((item) => item.id === targetId);
    if (insertIndex < 0) insertIndex = remainingItems.length;

    const movingForward = originalDraggedIndex >= 0 && originalTargetIndex >= 0 && originalDraggedIndex < originalTargetIndex;
    if (movingForward) {
        insertIndex += 1;
    }

    const nextQueue = [
        ...remainingItems.slice(0, insertIndex),
        ...movingItems,
        ...remainingItems.slice(insertIndex),
    ];

    const changed = nextQueue.some((item, index) => item.id !== CensorState.queue[index]?.id);
    if (!changed) return false;

    CensorState.queue = nextQueue;
    CensorState.lastSelectedIndex = CensorState.queue.findIndex((item) => item.id === movingIds[0]);
    renderQueue();
    scrollQueueItemIntoView(movingIds[0]);
    return true;
}

function getOrderedSelectedQueueIds() {
    return CensorState.queue
        .filter(item => CensorState.selectedItems.has(item.id))
        .map(item => item.id);
}

function scrollQueueItemIntoView(itemId) {
    const thumb = document.querySelector(`.queue-thumb-v2[data-id="${itemId}"]`);
    thumb?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}

function moveQueueSelection(direction) {
    const disabledButton = document.getElementById(`btn-queue-move-${direction}`);
    if (disabledButton?.disabled) {
        return;
    }

    const selectedIds = getOrderedSelectedQueueIds();
    if (!selectedIds.length) {
        window.App.showToast(
            censorT('censor.queueMoveSelectionRequired', null, 'Select at least one queue item first'),
            'warning'
        );
        return;
    }

    const selectedSet = new Set(selectedIds);
    let changed = false;

    switch (direction) {
        case 'top': {
            const selectedItems = CensorState.queue.filter(item => selectedSet.has(item.id));
            const remainingItems = CensorState.queue.filter(item => !selectedSet.has(item.id));
            changed = CensorState.queue.length > 1 && selectedItems.length > 0;
            CensorState.queue = [...selectedItems, ...remainingItems];
            break;
        }
        case 'bottom': {
            const selectedItems = CensorState.queue.filter(item => selectedSet.has(item.id));
            const remainingItems = CensorState.queue.filter(item => !selectedSet.has(item.id));
            changed = CensorState.queue.length > 1 && selectedItems.length > 0;
            CensorState.queue = [...remainingItems, ...selectedItems];
            break;
        }
        case 'up': {
            for (let i = 1; i < CensorState.queue.length; i++) {
                if (selectedSet.has(CensorState.queue[i].id) && !selectedSet.has(CensorState.queue[i - 1].id)) {
                    [CensorState.queue[i - 1], CensorState.queue[i]] = [CensorState.queue[i], CensorState.queue[i - 1]];
                    changed = true;
                }
            }
            break;
        }
        case 'down': {
            for (let i = CensorState.queue.length - 2; i >= 0; i--) {
                if (selectedSet.has(CensorState.queue[i].id) && !selectedSet.has(CensorState.queue[i + 1].id)) {
                    [CensorState.queue[i], CensorState.queue[i + 1]] = [CensorState.queue[i + 1], CensorState.queue[i]];
                    changed = true;
                }
            }
            break;
        }
        default:
            return;
    }

    if (!changed) {
        return;
    }

    CensorState.lastSelectedIndex = CensorState.queue.findIndex(item => item.id === selectedIds[0]);
    renderQueue();
    scrollQueueItemIntoView(selectedIds[0]);
}

