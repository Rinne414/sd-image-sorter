/**
 * autosep/preview.js — autosep.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/autosep.js, pre-split
 * lines 1038-1458 + 1467: getAutoSepFilterSignature, _formatAutoSepI18n,
 * the preview cap/item/overflow/query/reset helpers,
 * loadMoreAutoSepOverflow, openAutoSepOverflowModal,
 * renderAutoSepPreviewList (incl. the 'no-filters' guidance branch),
 * updateAutoSepPreview (forwards the 'no-filters' reason — the DEAD-1 fix
 * and its comment moved verbatim) and invalidateAutoSepPreview with its
 * window publish (each publish stays in the file that declares its
 * function). Classic script: loads after autosep/state-constants.js (base).
 */
function getAutoSepFilterSignature(filters) {
    const appSignature = window.App?.getAdvancedFilterContractSignature;
    if (typeof appSignature === 'function') {
        return appSignature(buildAutoSepFilterContract(filters));
    }
    const contract = buildAutoSepFilterContract(filters);
    return JSON.stringify({
        generators: contract.generators || [],
        tags: contract.tags || [],
        tagMode: contract.tagMode || 'and',
        ratings: contract.ratings || [],
        checkpoints: contract.checkpoints || [],
        loras: contract.loras || [],
        prompts: contract.prompts || [],
        promptMatchMode: contract.promptMatchMode || 'exact',
        artist: contract.artist || null,
        search: contract.search || '',
        minWidth: contract.minWidth ?? null,
        maxWidth: contract.maxWidth ?? null,
        minHeight: contract.minHeight ?? null,
        maxHeight: contract.maxHeight ?? null,
        aspectRatio: contract.aspectRatio || null,
        minAesthetic: contract.minAesthetic ?? null,
        maxAesthetic: contract.maxAesthetic ?? null,
        excludeTags: contract.excludeTags || [],
        excludeGenerators: contract.excludeGenerators || [],
        excludeRatings: contract.excludeRatings || [],
        excludeCheckpoints: contract.excludeCheckpoints || [],
        excludeLoras: contract.excludeLoras || [],
        // v3.3.x scope fields — without them this fallback signature reported
        // "matches gallery" even when collection/folder/rating/exclude differed.
        excludePrompts: contract.excludePrompts || [],
        excludeColors: contract.excludeColors || [],
        minUserRating: contract.minUserRating ?? null,
        brightnessMin: contract.brightnessMin ?? null,
        brightnessMax: contract.brightnessMax ?? null,
        colorTemperature: contract.colorTemperature || '',
        brightnessDistribution: contract.brightnessDistribution || '',
        collectionId: contract.collectionId ?? null,
        folder: contract.folder || null,
        hasMetadata: contract.hasMetadata ?? null,
    });
}

function _formatAutoSepI18n(key, fallback, replacements = {}) {
    const raw = window.I18n?.t?.(key);
    const resolved = (raw && raw !== key) ? raw : fallback;
    return Object.entries(replacements).reduce(
        (out, [token, value]) => out.replaceAll(`{${token}}`, String(value)),
        resolved,
    );
}

function _computeAutoSepPreviewCap(container) {
    // Fill the preview pane: derive columns from the container width AND rows
    // from its available height, so the grid uses the space instead of showing
    // a fixed two rows under a tall, mostly-empty pane (the "too much spacing,
    // could fit more images" complaint). Falls back to two rows when the
    // container has not been laid out yet. The grid uses auto-fill
    // minmax(128px, 1fr); each row is a square thumbnail + a one-line name.
    if (!container) return 8;
    const style = window.getComputedStyle(container);
    const gap = parseFloat(style.columnGap || style.gap || '12') || 12;
    const rowGap = parseFloat(style.rowGap || style.gap || '12') || gap;
    const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const minColumn = 128;
    const width = Math.max(0, (container.clientWidth || 0) - paddingX);
    if (width <= 0) return 8;
    const cols = Math.max(1, Math.floor((width + gap) / (minColumn + gap)));

    // Estimated natural row height: square thumb (aspect-ratio:1, fills the
    // column width) + the single-line name label + row gap. The name never
    // wraps (white-space:nowrap + ellipsis); measured at ~28px (8px*2 padding +
    // ~12px line at font-size 11). The item's 1px top/bottom border offsets the
    // thumb's border-inset, so 30px (name + ~2px sub-pixel margin) keeps the
    // estimate at or above the real natural height. This MUST NOT under-count:
    // the grid stretches rows to fill the pane height, but the square thumb
    // can't shrink, so one row too many overflows the pane into a scrollbar.
    const colWidth = (width - (cols - 1) * gap) / cols;
    const NAME_LABEL_HEIGHT = 30;
    const rowHeight = colWidth + NAME_LABEL_HEIGHT + rowGap;
    const height = Math.max(0, (container.clientHeight || 0) - paddingY);
    const rowsThatFit = (height > 0 && rowHeight > 0)
        ? Math.floor((height + rowGap) / rowHeight)
        : 0;
    const rows = Math.max(2, rowsThatFit); // always show at least two rows
    return cols * rows;
}

function _buildAutoSepPreviewItem(image) {
    const { API, openGalleryPreview } = window.App;
    const button = document.createElement('button');
    button.className = 'autosep-preview-item';
    button.type = 'button';
    button.dataset.imageId = String(image.id);
    button.title = `Open ${image.filename}`;

    const img = document.createElement('img');
    img.className = 'autosep-preview-thumb';
    img.src = API.getThumbnailUrl(image.id, 256);
    img.alt = image.filename;
    img.loading = 'lazy';

    const name = document.createElement('span');
    name.className = 'autosep-preview-name';
    name.textContent = image.filename;

    button.append(img, name);
    button.addEventListener('click', () => {
        const imageId = parseInt(button.dataset.imageId, 10);
        if (typeof openGalleryPreview === 'function') {
            openGalleryPreview(imageId);
        }
    });
    return button;
}

function _renderAutoSepOverflowModal(images) {
    const list = document.getElementById('autosep-overflow-list');
    const description = document.getElementById('autosep-overflow-description');
    if (!list) return;

    list.innerHTML = '';
    images.forEach((image) => list.appendChild(_buildAutoSepPreviewItem(image)));

    if (AutoSepState.overflowHasMore) {
        const remaining = Math.max(0, AutoSepState.matchCount - AutoSepState.overflowImages.length);
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.type = 'button';
        loadMoreBtn.id = 'autosep-overflow-load-more';
        loadMoreBtn.className = 'btn btn-secondary';
        loadMoreBtn.textContent = _formatAutoSepI18n('autosep.overflowLoadMore', 'Load {count} more', {
            count: Math.min(AUTOSEP_OVERFLOW_PAGE_SIZE, remaining || AUTOSEP_OVERFLOW_PAGE_SIZE),
        });
        loadMoreBtn.disabled = AutoSepState.overflowLoading;
        loadMoreBtn.addEventListener('click', loadMoreAutoSepOverflow);
        list.appendChild(loadMoreBtn);
    }

    if (description) {
        description.textContent = _formatAutoSepI18n(
            'autosep.overflowDescriptionPaged',
            'Showing {shown} of {total} matching images. Load more only if you need the full list.',
            {
                shown: AutoSepState.overflowImages.length,
                total: AutoSepState.matchCount,
            },
        );
    }
}

function _buildAutoSepImageQuery(filters, cursor = null, limit = 500) {
    const contract = buildAutoSepFilterContract(filters);
    return {
        generators: contract.generators?.length > 0 ? contract.generators : null,
        tags: contract.tags?.length > 0 ? contract.tags : null,
        tagMode: contract.tagMode || 'and',
        ratings: contract.ratings?.length < 4 ? contract.ratings : null,
        checkpoints: contract.checkpoints?.length > 0 ? contract.checkpoints : null,
        loras: contract.loras?.length > 0 ? contract.loras : null,
        prompts: contract.prompts?.length > 0 ? contract.prompts : null,
        promptMatchMode: contract.promptMatchMode || 'exact',
        artist: contract.artist || null,
        search: contract.search?.trim() || null,
        minWidth: contract.minWidth,
        maxWidth: contract.maxWidth,
        minHeight: contract.minHeight,
        maxHeight: contract.maxHeight,
        aspectRatio: contract.aspectRatio,
        minAesthetic: contract.minAesthetic,
        maxAesthetic: contract.maxAesthetic,
        excludeTags: contract.excludeTags?.length > 0 ? contract.excludeTags : null,
        excludeGenerators: contract.excludeGenerators?.length > 0 ? contract.excludeGenerators : null,
        excludeRatings: contract.excludeRatings?.length > 0 ? contract.excludeRatings : null,
        excludeCheckpoints: contract.excludeCheckpoints?.length > 0 ? contract.excludeCheckpoints : null,
        excludeLoras: contract.excludeLoras?.length > 0 ? contract.excludeLoras : null,
        // v3.3.x gallery-scope parity: preview/overflow must count the same
        // set the batch move/copy will actually touch.
        excludePrompts: contract.excludePrompts?.length > 0 ? contract.excludePrompts : null,
        excludeColors: contract.excludeColors?.length > 0 ? contract.excludeColors : null,
        minUserRating: contract.minUserRating || null,
        brightnessMin: contract.brightnessMin ?? null,
        brightnessMax: contract.brightnessMax ?? null,
        colorTemperature: contract.colorTemperature || null,
        brightnessDistribution: contract.brightnessDistribution || null,
        collectionId: contract.collectionId || null,
        folder: contract.folder || null,
        hasMetadata: typeof contract.hasMetadata === 'boolean' ? contract.hasMetadata : null,
        limit,
        cursor,
    };
}

function _resetAutoSepOverflowState(signature = null) {
    AutoSepState.overflowImages = [];
    AutoSepState.overflowSignature = signature;
    AutoSepState.overflowNextCursor = null;
    AutoSepState.overflowHasMore = false;
    AutoSepState.overflowLoading = false;
}

async function loadMoreAutoSepOverflow() {
    if (AutoSepState.overflowLoading) return;

    const filters = getAutoSepFilters();
    const signature = getAutoSepFilterSignature(filters);
    if (AutoSepState.overflowSignature !== signature) {
        _resetAutoSepOverflowState(signature);
    }

    AutoSepState.overflowLoading = true;
    const list = document.getElementById('autosep-overflow-list');
    if (list && !AutoSepState.overflowImages.length) {
        list.innerHTML = `<div class="autosep-preview-empty">${escapeHtml(_formatAutoSepI18n('autosep.overflowLoading', 'Loading matching images...'))}</div>`;
    }

    try {
        const result = await window.App.API.getImages(
            _buildAutoSepImageQuery(filters, AutoSepState.overflowNextCursor, AUTOSEP_OVERFLOW_PAGE_SIZE)
        );
        const rows = Array.isArray(result?.images) ? result.images : [];
        AutoSepState.overflowImages.push(...rows);
        AutoSepState.matchCount = Number.isFinite(result?.total) && result.total >= 0
            ? result.total
            : Math.max(AutoSepState.matchCount, AutoSepState.overflowImages.length);
        AutoSepState.overflowNextCursor = result?.next_cursor || null;
        AutoSepState.overflowHasMore = Boolean(result?.has_more && AutoSepState.overflowNextCursor);
        AutoSepState.overflowLoading = false;
        _renderAutoSepOverflowModal(AutoSepState.overflowImages);
    } catch (error) {
        Logger.error('Failed to load Auto-Separate overflow preview:', error);
        if (list) {
            list.innerHTML = `<div class="autosep-preview-empty">${escapeHtml(_formatAutoSepI18n('autosep.overflowLoadFailed', 'Failed to load more matching images.'))}</div>`;
        }
    } finally {
        AutoSepState.overflowLoading = false;
    }
}

async function openAutoSepOverflowModal() {
    const { showModal } = window.App;
    const filters = getAutoSepFilters();
    const signature = getAutoSepFilterSignature(filters);
    _resetAutoSepOverflowState(signature);
    if (typeof showModal === 'function') showModal('autosep-overflow-modal');
    await loadMoreAutoSepOverflow();
}

function renderAutoSepPreviewList(images = [], totalCount = 0, reason = null) {
    const { $ } = window.App;
    const container = $('#autosep-preview-list');
    if (!container) return;

    container.innerHTML = '';

    if (!images.length) {
        const empty = document.createElement('div');
        empty.className = 'autosep-preview-empty';
        if (reason === 'no-filters') {
            // Helpful explanation when nothing is filtered yet (was: silent "0 match")
            empty.classList.add('autosep-preview-empty--no-filters');
            const title = document.createElement('div');
            title.className = 'autosep-preview-empty-title';
            title.textContent = window.I18n?.t?.('autosep.noFiltersTitle')
                || (window.I18n?.getLang?.() === 'zh-CN'
                    ? '尚未设置任何筛选'
                    : 'No filters set yet');
            const hint = document.createElement('div');
            hint.className = 'autosep-preview-empty-hint';
            hint.textContent = window.I18n?.t?.('autosep.noFiltersHint')
                || (window.I18n?.getLang?.() === 'zh-CN'
                    ? '请先设置筛选规则（如生成器、标签、提示词），或点击「从图库复制筛选」把图库当前的筛选条件带过来。'
                    : 'Set filters above (e.g. generators, tags, prompts), or click "Copy from Gallery" to import the current gallery filters.');
            empty.appendChild(title);
            empty.appendChild(hint);
        } else {
            empty.textContent = window.I18n?.t?.('autosep.previewEmptyInitial')
                || 'No preview yet. Click "Preview Results" to inspect matching images.';
        }
        container.appendChild(empty);
        return;
    }

    const cap = _computeAutoSepPreviewCap(container);
    // Reserve the last visible slot for the +N button when the match set is
    // bigger than the cap — this keeps the visible item count consistent with
    // the height-derived budget computed above, instead of spilling past the
    // visible rows.
    const willOverflow = totalCount > cap;
    const visibleCount = willOverflow ? Math.max(0, Math.min(images.length, cap - 1)) : images.length;
    const visibleImages = images.slice(0, visibleCount);

    visibleImages.forEach((image) => container.appendChild(_buildAutoSepPreviewItem(image)));

    const remaining = Math.max(totalCount - visibleCount, 0);
    if (willOverflow && remaining > 0) {
        const more = document.createElement('button');
        more.type = 'button';
        more.id = 'autosep-preview-more';
        more.className = 'autosep-preview-more autosep-preview-more-btn';
        more.textContent = _formatAutoSepI18n('autosep.previewMore', '+{count} more', { count: remaining });
        more.setAttribute(
            'aria-label',
            _formatAutoSepI18n('autosep.previewMoreAria', 'Show the remaining {count} matching images', { count: remaining }),
        );
        more.addEventListener('click', openAutoSepOverflowModal);
        container.appendChild(more);
    }
}


// ============== Preview ==============

async function updateAutoSepPreview() {
    const requestId = ++_previewRequestId;
    const { $, API } = window.App;
    const filters = getAutoSepFilters();

    // Update summary display
    updateAutoSepSummary();

    const currentSignature = getAutoSepFilterSignature(filters);

    // Check if any meaningful filters are set
    const hasFilters =
        (filters.generators?.length > 0 && filters.generators.length < 5) ||
        (filters.tags?.length > 0) ||
        (filters.ratings?.length > 0 && filters.ratings.length < 4) ||
        (filters.checkpoints?.length > 0) ||
        (filters.loras?.length > 0) ||
        (filters.prompts?.length > 0) ||
        Boolean(filters.artist?.trim?.()) ||
        Boolean(filters.search?.trim()) ||
        filters.minWidth || filters.maxWidth || filters.minHeight || filters.maxHeight ||
        filters.aspectRatio || filters.minAesthetic != null || filters.maxAesthetic != null ||
        // v3.3.x scope fields (collection/folder/rating/exclude/brightness)
        (filters.excludeTags?.length > 0) ||
        (filters.excludeGenerators?.length > 0) ||
        (filters.excludeRatings?.length > 0) ||
        (filters.excludeCheckpoints?.length > 0) ||
        (filters.excludeLoras?.length > 0) ||
        (filters.excludePrompts?.length > 0) ||
        (filters.excludeColors?.length > 0) ||
        Boolean(filters.minUserRating) ||
        filters.brightnessMin != null || filters.brightnessMax != null ||
        Boolean(filters.colorTemperature) || Boolean(filters.brightnessDistribution) ||
        Boolean(filters.collectionId) || Boolean(filters.folder) ||
        typeof filters.hasMetadata === 'boolean';

    // When no filters are set, still allow preview (matches ALL images)
    // but mark the state so the UI can show a warning
    AutoSepState.allImagesMode = !hasFilters;

    try {
        const previewImages = [];
        let cursor = null;
        let hasMore = true;
        let totalCount = 0;

        while (hasMore && previewImages.length < AUTOSEP_PREVIEW_FETCH_LIMIT) {
            const remaining = AUTOSEP_PREVIEW_FETCH_LIMIT - previewImages.length;
            const result = await API.getImages(
                _buildAutoSepImageQuery(filters, cursor, Math.min(AUTOSEP_OVERFLOW_PAGE_SIZE, remaining))
            );

            const rows = Array.isArray(result?.images) ? result.images : [];
            previewImages.push(...rows.slice(0, remaining));
            if (Number.isFinite(result?.total) && result.total >= 0) {
                totalCount = result.total;
            } else {
                totalCount = Math.max(totalCount, previewImages.length + (result?.has_more ? 1 : 0));
            }
            cursor = result?.next_cursor || null;
            hasMore = Boolean(result?.has_more && cursor);
            if (requestId !== _previewRequestId) return;
        }

        if (requestId !== _previewRequestId) return; // Stale request, discard
        AutoSepState.matchCount = Math.max(totalCount, previewImages.length);
        AutoSepState.previewImages = previewImages;
        AutoSepState.previewSignature = currentSignature;
        _resetAutoSepOverflowState(currentSignature);
        // Clamp defensively: the count must never render as the backend's -1
        // "count skipped" sentinel (the user-reported "-1 张图").
        $('#autosep-preview .stat-number').textContent = Math.max(0, AutoSepState.matchCount);
        // Pass the no-filters reason so the guidance empty-state (pin-sweep
        // DEAD-1: it could never render — no caller ever sent the reason)
        // replaces the silent generic text when nothing is filtered yet.
        renderAutoSepPreviewList(AutoSepState.previewImages, AutoSepState.matchCount,
            AutoSepState.allImagesMode ? 'no-filters' : null);

    } catch (error) {
        Logger.error('Failed to preview:', error);
        // A failed preview must not leave a stale/garbage count on screen.
        AutoSepState.matchCount = 0;
        const statEl = document.querySelector('#autosep-preview .stat-number');
        if (statEl) statEl.textContent = '0';
    }
}

function invalidateAutoSepPreview() {
    const statNumber = document.querySelector('#autosep-preview .stat-number');
    AutoSepState.matchCount = 0;
    AutoSepState.previewImages = [];
    AutoSepState.previewSignature = null;
    _resetAutoSepOverflowState(null);
    if (statNumber) statNumber.textContent = '0';
    renderAutoSepPreviewList([], 0);

    if (AutoSepState.settings.autoPreview) {
        clearTimeout(_autosepPreviewTimer);
        _autosepPreviewTimer = setTimeout(() => {
            const autosepView = document.getElementById('view-autosep');
            if (autosepView && autosepView.style.display !== 'none') {
                updateAutoSepPreview();
            }
        }, 250);
    }
}

window.invalidateAutoSepPreview = invalidateAutoSepPreview;
