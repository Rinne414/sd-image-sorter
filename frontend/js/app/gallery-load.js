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

// Generate skeleton items for loading state
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
    } = options;

    if (AppState.isLoading && coalesce) {
        _pendingImageReload = { appendMode, options: { ...options } };
        return;
    }

    // Cancel any pending user-facing image load request
    if (!coalesce) {
        RequestManager.cancel(IMAGE_LOAD_KEY);
    }

    const loadSequence = ++_imageLoadSequence;
    _activeImageLoadSequence = loadSequence;
    const galleryGrid = $('#gallery-grid');

    if (!appendMode && !preserveExisting) {
        AppState.pagination.cursor = null;
        AppState.pagination.offset = 0;
        AppState.pagination.hasMore = true;
        AppState.images = [];

        if (galleryGrid) {
            galleryGrid.innerHTML = '';
            galleryGrid.appendChild(generateSkeletonItems(20));
        }
    }

    AppState.isLoading = true;
    const galleryLoading = $('#gallery-loading');
    if (galleryLoading && !silent) galleryLoading.style.display = 'flex';
    const imageCount = $('#image-count');
    if (imageCount && !appendMode && !silent) imageCount.textContent = appT('gallery.loading', 'Loading images...');
    let controller = null;

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
        const result = await API.getImages(filters, { signal: controller.signal });
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
        }
        resetSelectionDataCache();

        AppState.pagination.offset = Number.isFinite(result.next_offset)
            ? result.next_offset
            : AppState.images.length;

        if (imageCount) {
            imageCount.textContent = appT('gallery.imageCount', '{count} images')
                .replace('{count}', _galleryCountText());
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
            if (galleryLoading && !silent) {
                galleryLoading.style.display = 'none';
            }
        }

        if (!isLatestLoad) {
            return;
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

