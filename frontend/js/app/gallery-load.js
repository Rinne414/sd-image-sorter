/**
 * app/gallery-load.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 6084-6411 (of 10,152): gallery image loading + pagination listeners.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
// ============== Image Loading ==============

const IMAGE_LOAD_KEY = 'images-load';
let _pendingImageReload = null;
let _imageLoadSequence = 0;
let _activeImageLoadSequence = 0;
// Which results the grid shows (library, filters, sort). A load of other results
// opens them at their top: the old scroll offset means nothing in them.
let _shownGalleryResultsKey = null;

function getGalleryResultsKey() {
    const libraryId = window.LibraryWorkspace?.getCurrentLibraryId?.() || '';
    return `${libraryId}|${getSelectionFilterCacheKey(AppState.filters)}`;
}

function cancelGalleryImageLoad() {
    const hadPendingGalleryLoad = AppState.isLoading
        || _pendingImageReload !== null
        || RequestManager.pendingRequests.has(IMAGE_LOAD_KEY);
    _imageLoadSequence += 1;
    _activeImageLoadSequence = 0;
    _pendingImageReload = null;
    RequestManager.cancel(IMAGE_LOAD_KEY);
    AppState.isLoading = false;
    if (hadPendingGalleryLoad) {
        AppState.galleryNeedsRefresh = true;
    }
    const galleryLoading = $('#gallery-loading');
    if (galleryLoading) galleryLoading.style.display = 'none';
}

// Generate skeleton items for loading state. Every placeholder carries the class
// skeleton-item: loadImages reads it to tell a pending replace from a grid it can
// refresh in place.
function generateSkeletonItems(count = 20) {
    const fragment = document.createDocumentFragment();

    // Use SkeletonGallery if available for better integration
    if (window.Skeleton && window.SkeletonGallery) {
        for (let i = 0; i < count; i++) {
            fragment.appendChild(window.Skeleton.galleryItem());
        }
        return fragment;
    }

    // Fallback implementation
    for (let i = 0; i < count; i++) {
        const item = document.createElement('div');
        item.className = 'gallery-item skeleton-item';
        item.innerHTML = `
            <div class="skeleton-image"></div>
            <div class="skeleton-overlay">
                <div class="skeleton-badge skeleton"></div>
            </div>
        `;
        fragment.appendChild(item);
    }
    return fragment;
}

// The listing endpoint returns at most this many images per request.
const GALLERY_LISTING_MAX_LIMIT = 1000;

/**
 * Fetch the current results from their start until `targetCount` images are in
 * (or the results end), one listing page at a time. A refresh in place needs
 * every page the reader had scrolled through, or their image drops out.
 */
async function fetchGalleryFromStart(filters, targetCount, pageLimit, signal) {
    const useCursorPagination = supportsCursorPagination(filters.sortBy);
    const images = [];
    let first = null;
    let page = null;
    do {
        const limit = Math.min(GALLERY_LISTING_MAX_LIMIT, Math.max(pageLimit, targetCount - images.length));
        const nextOffset = page && Number.isFinite(page.next_offset) ? page.next_offset : images.length;
        page = await API.getImages({
            ...filters,
            limit,
            cursor: useCursorPagination && page ? page.next_cursor : null,
            offset: !useCursorPagination && page ? nextOffset : undefined,
        }, { signal });
        if (page === null) return null;
        first = first || page;
        images.push(...page.images);
        // Without a cursor to go on, the next request would start over and repeat images.
        if (useCursorPagination && !page.next_cursor) break;
    } while (images.length < targetCount && page.has_more && page.images.length > 0);
    // Later cursor pages skip the COUNT (total -1); the first page has the real one.
    return { ...page, images, total: first.total };
}

// A refresh in place (keepPosition) keeps the grid and holds Load More while
// every loaded page is fetched again. When that takes a moment, the Load More
// row says so instead of sitting idle where the reader waits for more.
const GALLERY_REFRESH_NOTICE_DELAY_MS = 600;
const GALLERY_REFRESH_NOTICE_KEY = 'gallery.refreshingInPlace';
let _galleryRefreshNoticeTimer = null;

function _setLoadMoreButtonKey(button, key, ariaKey, fallback, ariaFallback) {
    // The keys move with the text, so a language switch meanwhile reads right.
    button.dataset.i18n = key;
    button.dataset.i18nAria = ariaKey;
    button.textContent = appT(key, fallback);
    button.setAttribute('aria-label', appT(ariaKey, ariaFallback));
}

function _showGalleryRefreshNotice() {
    _galleryRefreshNoticeTimer = null;
    const row = $('#gallery-load-more');
    const button = $('#load-more-btn');
    if (!row || !button) return;
    row.style.display = 'flex';
    row.setAttribute('aria-busy', 'true');
    button.disabled = true;
    _setLoadMoreButtonKey(button, GALLERY_REFRESH_NOTICE_KEY, GALLERY_REFRESH_NOTICE_KEY,
        'Updating the gallery…', 'Updating the gallery…');
}

function _clearGalleryRefreshNotice() {
    clearTimeout(_galleryRefreshNoticeTimer);
    _galleryRefreshNoticeTimer = null;
    const button = $('#load-more-btn');
    if (!button || button.dataset.i18n !== GALLERY_REFRESH_NOTICE_KEY) return;
    button.disabled = false;
    _setLoadMoreButtonKey(button, 'gallery.loadMore', 'a11y.loadMoreImages', 'Load More Images', 'Load more images');
    $('#gallery-load-more')?.removeAttribute('aria-busy');
}

async function loadImages(appendMode = false, options = {}) {
    if (typeof appendMode === 'object') {
        options = appendMode;
        appendMode = false;
    }

    const {
        silent = false,
        preserveExisting = false,
        coalesce = false,
        pageSizeOverride = null,
        suppressAutoLoadMore = false,
        // A refresh of the results the reader is in (a job finished, images
        // left them): keep the grid on screen, refetch every loaded page and put
        // the reader back on their image instead of starting over at the top.
        keepPosition = false,
    } = options;

    if (AppState.isLoading && coalesce) {
        _pendingImageReload = { appendMode, options: { ...options } };
        return;
    }

    // Off the Gallery, every loaded page refetched now would be thrown away:
    // the Gallery reloads when the user comes back to it.
    if (keepPosition && AppState.currentView !== 'gallery') {
        AppState.galleryNeedsRefresh = true;
        return;
    }

    // Cancel any pending user-facing image load request
    if (!coalesce) {
        RequestManager.cancel(IMAGE_LOAD_KEY);
    }

    const loadSequence = ++_imageLoadSequence;
    _activeImageLoadSequence = loadSequence;
    const galleryGrid = $('#gallery-grid');
    const loadedCount = AppState.images.length;
    // A replacing load (new filter or sort) cancelled above leaves placeholders
    // in the grid; a refresh in place would keep them up if it failed, so start
    // over instead. Another refresh in place leaves the grid intact.
    const showsPlaceholders = Boolean(galleryGrid && galleryGrid.querySelector('.skeleton-item'));
    const keepsPosition = keepPosition && !appendMode && loadedCount > 0 && !showsPlaceholders;
    const replacesGallery = !appendMode && !preserveExisting && !keepsPosition;
    const resultsKey = getGalleryResultsKey();
    // Another view keeps its own offset. A "continue where you left off" restore
    // checks the results itself and lands after this, once the grid is filled.
    const opensNewResults = replacesGallery
        && resultsKey !== _shownGalleryResultsKey
        && AppState.currentView === 'gallery';
    const settledGalleryState = replacesGallery
        ? {
            images: AppState.images,
            pagination: { ...AppState.pagination },
        }
        : null;

    if (replacesGallery) {
        const emptyState = $('#gallery-empty-state');
        if (emptyState) emptyState.style.display = 'none';

        if (galleryGrid) {
            galleryGrid.innerHTML = '';
            galleryGrid.appendChild(generateSkeletonItems(20));
        }
        // The placeholders keep the grid's height, so without this the new
        // results would open at the offset the old ones were read at. A restore
        // of the old results still landing or holding gives way, or its next
        // step carries the page back down into the new ones.
        if (opensNewResults) {
            window.GalleryComfort?.cancelRestore?.();
            resetViewScrollPosition();
        }
    }

    AppState.isLoading = true;
    // A newer load takes over whatever an earlier refresh showed.
    _clearGalleryRefreshNotice();
    if (keepsPosition) {
        _galleryRefreshNoticeTimer = setTimeout(_showGalleryRefreshNotice, GALLERY_REFRESH_NOTICE_DELAY_MS);
    }
    const galleryLoading = $('#gallery-loading');
    const showsLoading = !silent && !keepsPosition;
    if (galleryLoading && showsLoading) galleryLoading.style.display = 'flex';
    const imageCount = $('#image-count');
    if (imageCount && !appendMode && showsLoading) imageCount.textContent = appT('gallery.loading', 'Loading images...');
    let controller = null;
    let loadSucceeded = false;

    try {
        controller = RequestManager.createAbortController(IMAGE_LOAD_KEY);
        const useCursorPagination = supportsCursorPagination(AppState.filters.sortBy);
        const overrideLimit = Number(pageSizeOverride);
        const pageLimit = Number.isFinite(overrideLimit) && overrideLimit > 0
            ? Math.floor(overrideLimit)
            : AppState.pagination.pageSize;
        const filters = {
            ...AppState.filters,
            limit: pageLimit,
            cursor: appendMode && useCursorPagination ? AppState.pagination.cursor : null,
            offset: appendMode && !useCursorPagination ? AppState.pagination.offset : undefined
        };
        const result = keepsPosition
            ? await fetchGalleryFromStart(filters, loadedCount, pageLimit, controller.signal)
            : await API.getImages(filters, { signal: controller.signal });
        RequestManager.complete(IMAGE_LOAD_KEY, controller);

        if (result === null) return;
        if (loadSequence !== _imageLoadSequence || AppState.currentView !== 'gallery') {
            AppState.galleryNeedsRefresh = true;
            return;
        }

        // Update pagination
        AppState.pagination.cursor = result.next_cursor;
        AppState.pagination.hasMore = result.has_more;
        // The backend returns total = -1 when it skips the expensive COUNT
        // (cursor pagination / skip_count). Don't clobber a previously-known
        // total with that sentinel while appending more pages — only update on
        // a fresh load or when a real, non-negative count comes back.
        if (!appendMode || (typeof result.total === 'number' && result.total >= 0)) {
            AppState.pagination.total = result.total;
        }

        if (appendMode) {
            AppState.images = [...AppState.images, ...result.images];
        } else {
            AppState.images = result.images;
            _shownGalleryResultsKey = resultsKey;
        }
        resetSelectionDataCache();

        AppState.pagination.offset = Number.isFinite(result.next_offset)
            ? result.next_offset
            : AppState.images.length;

        if (imageCount) {
            applyGalleryCountLabel();
        }
        if (!appendMode && typeof refreshGeneratorTabCounts === 'function') {
            refreshGeneratorTabCounts();
        }

        // Clean stale selections on fresh load, but do not corrupt true filtered-result selection.
        if (AppState.selectedIds && AppState.selectedIds.size > 0 && !appendMode) {
            if (AppState.selectionScope === 'filtered') {
                const currentFilterKey = getSelectionFilterCacheKey(AppState.filters);
                if (AppState.selectionFilterKey && AppState.selectionFilterKey !== currentFilterKey) {
                    updateSelectionState((selection) => {
                        selection.selectedIds = new Set();
                        selection.scope = 'visible';
                        selection.filterKey = null;
                        selection.selectionToken = null;
                        selection.selectionTotal = 0;
                    });
                    if (typeof updateSelectionUI === 'function') updateSelectionUI();
                    emitSelectionStateChanged();
                }
            } else {
                const validIds = new Set(AppState.images.map(img => img.id));
                const staleIds = [...AppState.selectedIds].filter(id => !validIds.has(id));
                if (staleIds.length > 0) {
                    mutateSelectedIds((selectedIds) => {
                        staleIds.forEach((id) => selectedIds.delete(id));
                    });
                    if (typeof updateSelectionUI === 'function') updateSelectionUI();
                    emitSelectionStateChanged();
                }
            }
        }
        if (window.Gallery) {
            if (appendMode) {
                Gallery.appendImages(result.images);
            } else if (keepsPosition) {
                // Read the reader's image now, not before the request: they may
                // have scrolled while it was in flight.
                const readerAnchor = Gallery._captureViewAnchor();
                Gallery.setImages(AppState.images, { renderAll: true });
                if (readerAnchor && !Gallery._restoreViewAnchor(readerAnchor)) {
                    Gallery._scheduleAnchorRestore(readerAnchor);
                }
            } else {
                Gallery.setImages(AppState.images);
            }
        }

        // Smart Folders v1: additive hook so sidebar facets (pinned preset
        // counts) can recount when the gallery reloads. append pages don't
        // change library data, so listeners can skip them via the detail.
        window.dispatchEvent(new CustomEvent('gallery-images-loaded', {
            detail: { appendMode: Boolean(appendMode) },
        }));

        const emptyState = $('#gallery-empty-state');
        if (emptyState) {
            const shouldShow = AppState.images.length === 0;
            emptyState.style.display = shouldShow ? 'flex' : 'none';
            if (shouldShow) {
                // v3.2.2: differentiate "library is empty" from "filter
                // returned 0 results". The original empty state was the
                // onboarding card ("No images yet, import a folder") which
                // was misleading when the user had a 71k-image library and
                // had just tried a tag filter that returned nothing - they
                // would think their entire library disappeared.
                _applyGalleryEmptyStateVariant(emptyState);
            }
        }
        loadSucceeded = true;
    } catch (error) {
        if (error.name === 'AbortError' || error.cancelled) {
            return;
        }
        showToast(formatUserError(error, appT('gallery.loadImagesFailed', 'Failed to load images')), 'error');
    } finally {
        if (controller) {
            RequestManager.complete(IMAGE_LOAD_KEY, controller);
        }
        const isLatestLoad = loadSequence === _imageLoadSequence;
        const isActiveLoad = _activeImageLoadSequence === loadSequence;

        if (isActiveLoad) {
            _activeImageLoadSequence = 0;
            AppState.isLoading = false;
            _clearGalleryRefreshNotice();
            if (galleryLoading && !silent) {
                galleryLoading.style.display = 'none';
            }
        }

        if (!isLatestLoad) {
            return;
        }

        if (!loadSucceeded && settledGalleryState && AppState.currentView === 'gallery') {
            AppState.images = settledGalleryState.images;
            Object.assign(AppState.pagination, settledGalleryState.pagination);
            if (window.Gallery) {
                Gallery.setImages(AppState.images);
            }
            if (imageCount) {
                applyGalleryCountLabel();
            }
            const emptyState = $('#gallery-empty-state');
            if (emptyState) {
                const shouldShow = AppState.images.length === 0;
                emptyState.style.display = shouldShow ? 'flex' : 'none';
                if (shouldShow) {
                    _applyGalleryEmptyStateVariant(emptyState);
                }
            }
        }

        // Show/hide "Load More" button based on pagination state
        const loadMoreContainer = $('#gallery-load-more');
        if (loadMoreContainer) {
            loadMoreContainer.style.display = AppState.pagination.hasMore ? 'flex' : 'none';
        }

        requestAnimationFrame(() => {
            attachGalleryPaginationListener();
            if (!suppressAutoLoadMore) {
                _onGalleryScroll();
            }
        });

        const pendingReload = _pendingImageReload;
        _pendingImageReload = null;
        if (pendingReload) {
            queueMicrotask(() => {
                loadImages(pendingReload.appendMode, pendingReload.options);
            });
        }
    }
}

// Load next page of images
function loadMoreImages() {
    if (AppState.isLoading || !AppState.pagination.hasMore) return;
    loadImages(true);
}

// Scroll-based infinite scroll — uses gallery grid bottom position for reliable detection
let _scrollLoadTimer = null;
let _galleryScrollContainer = null;
let _galleryScrollTarget = null;

function _isViewportScrollContainer(scrollContainer) {
    return Boolean(
        scrollContainer &&
        (
            scrollContainer === document.documentElement ||
            scrollContainer === document.body ||
            scrollContainer === document.scrollingElement
        )
    );
}

function _getGalleryScrollContainer() {
    if (window.Gallery && typeof window.Gallery._getScrollContainer === 'function') {
        return window.Gallery._getScrollContainer();
    }

    return document.scrollingElement || document.documentElement;
}

function _resolveGalleryScrollTarget(scrollContainer) {
    return _isViewportScrollContainer(scrollContainer) ? window : scrollContainer;
}

function detachGalleryPaginationListener() {
    if (_galleryScrollTarget) {
        _galleryScrollTarget.removeEventListener('scroll', _onGalleryScroll);
    }
    _galleryScrollTarget = null;
    _galleryScrollContainer = null;
}

function attachGalleryPaginationListener() {
    const scrollContainer = _getGalleryScrollContainer();
    if (!scrollContainer) return;

    const scrollTarget = _resolveGalleryScrollTarget(scrollContainer);
    if (_galleryScrollTarget === scrollTarget && _galleryScrollContainer === scrollContainer) {
        return;
    }

    detachGalleryPaginationListener();
    _galleryScrollContainer = scrollContainer;
    _galleryScrollTarget = scrollTarget;
    _galleryScrollTarget.addEventListener('scroll', _onGalleryScroll, { passive: true });
}

function _onGalleryScroll() {
    if (_scrollLoadTimer) return;
    _scrollLoadTimer = requestAnimationFrame(() => {
        _scrollLoadTimer = null;
        if (AppState.currentView !== 'gallery') return;
        if (AppState.isLoading || !AppState.pagination.hasMore) return;

        // Use the gallery grid's actual bottom position for reliable detection
        // getBoundingClientRect is always correct regardless of flex/grid layout
        const grid = document.getElementById('gallery-grid');
        if (!grid) return;
        const scrollContainer = _galleryScrollContainer || _getGalleryScrollContainer();
        const viewportBottom = _isViewportScrollContainer(scrollContainer)
            ? window.innerHeight
            : scrollContainer.getBoundingClientRect().bottom;
        const gridBottom = grid.getBoundingClientRect().bottom;
        if (gridBottom <= viewportBottom + 800) {
            loadMoreImages();
        }
    });
}

