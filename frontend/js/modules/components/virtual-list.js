/**
 * SD Image Sorter - VirtualList Component
 * A reusable virtual scrolling component for efficiently rendering large lists.
 * Only renders items visible in the viewport plus a configurable buffer.
 *
 * Features:
 * - DOM element recycling for performance
 * - Support for both fixed-height and dynamic-height items
 * - Intersection Observer based scroll detection
 * - Grid and waterfall layout support
 * - Smooth scrolling with RAF throttling
 * - Backward compatible fallback
 */

class VirtualList {
    /**
     * Default configuration
     */
    static DEFAULT_CONFIG = {
        bufferSize: 10,           // Items to render outside viewport (above + below)
        threshold: 240,           // Minimum items to enable virtual scrolling
        forceVirtual: false,      // Always use virtual layout regardless of item count
        estimatedItemHeight: 200, // Estimated height for grid mode
        itemAspectRatio: 1,       // Width / height ratio for fixed-aspect layouts
        rowGap: 16,               // Gap between rows
        columnGap: 16,            // Gap between columns
        minColumnWidth: 200,      // Minimum column width for grid
        debounceMs: 100,          // Resize debounce interval
        scrollThrottle: 'raf',    // 'raf' or ms number
    };

    /**
     * Create a VirtualList instance
     * @param {Object} options - Configuration options
     * @param {HTMLElement} options.container - The container element for items
     * @param {HTMLElement} options.scrollContainer - The scrollable parent element
     * @param {Function} options.renderItem - Function to create a single item element (index, data) => HTMLElement
     * @param {Function} options.getItemKey - Function to get unique key for an item (index, data) => string|number
     * @param {Function} options.estimateItemHeight - Optional function to estimate height (index, data) => number
     * @param {Object} options.config - Configuration overrides
     */
    constructor(options) {
        this.validateOptions(options);

        const { container, scrollContainer, renderItem, getItemKey, estimateItemHeight, config, onItemsRendered } = options;

        this.container = container;
        this.scrollContainer = scrollContainer;
        this.renderItem = renderItem;
        this.getItemKey = getItemKey || ((index) => index);
        this.estimateItemHeight = estimateItemHeight || (() => this.config.estimatedItemHeight);
        this.onItemsRendered = typeof onItemsRendered === 'function' ? onItemsRendered : null;

        this.config = { ...VirtualList.DEFAULT_CONFIG, ...config };

        // State
        this.items = [];
        this.renderedElements = new Map(); // key -> { element, index, data }
        this.visibleRange = { start: -1, end: -1 };
        this.layoutCache = null;
        this.isVirtualEnabled = false;

        // Layout state
        this.columns = 1;
        this.itemWidth = 0;
        this.itemHeight = this.config.estimatedItemHeight;
        this.totalHeight = 0;

        // Observers & handlers
        this.resizeObserver = null;
        this.intersectionObserver = null;
        this.scrollHandler = null;
        this.resizeDebounceTimer = null;
        this.scrollRAF = null;
        this.scrollEventTarget = this._resolveScrollEventTarget(scrollContainer);

        // Bind methods
        this._onScroll = this._onScroll.bind(this);
        this._onResize = this._onResize.bind(this);
    }

    /**
     * Validate constructor options
     */
    validateOptions(options) {
        if (!options.container || !(options.container instanceof HTMLElement)) {
            throw new Error('VirtualList: container must be an HTMLElement');
        }
        if (!options.scrollContainer || !(options.scrollContainer instanceof HTMLElement)) {
            throw new Error('VirtualList: scrollContainer must be an HTMLElement');
        }
        if (typeof options.renderItem !== 'function') {
            throw new Error('VirtualList: renderItem must be a function');
        }
    }

    /**
     * Use `window` as the event target for document scrolling.
     * Browsers do not consistently dispatch `scroll` on `documentElement`.
     */
    _resolveScrollEventTarget(scrollContainer) {
        if (
            typeof window !== 'undefined' &&
            scrollContainer &&
            (
                scrollContainer === document.documentElement ||
                scrollContainer === document.body ||
                scrollContainer === document.scrollingElement
            )
        ) {
            return window;
        }

        return scrollContainer;
    }

    _isViewportScrollContainer() {
        return this.scrollEventTarget === window;
    }

    _getScrollTop() {
        if (this._isViewportScrollContainer()) {
            return window.pageYOffset || document.documentElement.scrollTop || this.scrollContainer.scrollTop || 0;
        }

        return this.scrollContainer.scrollTop;
    }

    _getViewportHeight() {
        return this._isViewportScrollContainer()
            ? window.innerHeight
            : this.scrollContainer.clientHeight;
    }

    _getRelativeScroll() {
        if (this._isViewportScrollContainer()) {
            return Math.max(0, -this.container.getBoundingClientRect().top);
        }

        const scrollTop = this._getScrollTop();
        const containerRect = this.container.getBoundingClientRect();
        const scrollRect = this.scrollContainer.getBoundingClientRect();
        const containerTop = containerRect.top - scrollRect.top;
        return Math.max(0, scrollTop - containerTop);
    }

    /**
     * Initialize the virtual list
     * @param {Array} items - Initial items array
     * @returns {VirtualList} this for chaining
     */
    init(items = []) {
        // Setup observers
        this._setupResizeObserver();
        this._setupIntersectionObserver();

        // Add scroll listener
        this.scrollHandler = this._onScroll;
        this.scrollEventTarget.addEventListener('scroll', this.scrollHandler, { passive: true });

        // Add virtual-scroll class
        this.container.classList.add('virtual-scroll');

        // Set initial items
        if (items.length > 0) {
            this.setItems(items);
        }

        return this;
    }

    /**
     * Setup ResizeObserver for container size changes
     */
    _setupResizeObserver() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }

        this.resizeObserver = new ResizeObserver(() => {
            clearTimeout(this.resizeDebounceTimer);
            this.resizeDebounceTimer = setTimeout(this._onResize, this.config.debounceMs);
        });

        this.resizeObserver.observe(this.container);
    }

    /**
     * Setup IntersectionObserver for scroll detection (alternative to scroll event)
     */
    _setupIntersectionObserver() {
        // Create sentinel elements for intersection detection
        this.topSentinel = document.createElement('div');
        this.topSentinel.className = 'virtual-scroll-sentinel top';
        this.topSentinel.style.cssText = 'position: absolute; top: 0; height: 1px; width: 1px; pointer-events: none;';

        this.bottomSentinel = document.createElement('div');
        this.bottomSentinel.className = 'virtual-scroll-sentinel bottom';
        this.bottomSentinel.style.cssText = 'position: absolute; bottom: 0; height: 1px; width: 1px; pointer-events: none;';

        this.intersectionObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    this._onScroll();
                }
            }
        }, {
            root: this.scrollContainer,
            rootMargin: `${this.config.bufferSize * this.config.estimatedItemHeight}px`,
        });
    }

    /**
     * Handle scroll events with throttling
     */
    _onScroll() {
        if (this.config.scrollThrottle === 'raf') {
            if (this.scrollRAF) return;
            this.scrollRAF = requestAnimationFrame(() => {
                this.scrollRAF = null;
                this._updateVisibleItems();
            });
        } else {
            this._updateVisibleItems();
        }
    }

    /**
     * Handle resize events
     */
    _onResize() {
        this._recalculateLayout();
        this._updateVisibleItems();
    }

    /**
     * Set items and decide whether to use virtual scrolling
     * @param {Array} items - Array of item data
     */
    setItems(items) {
        this.items = items || [];
        this.renderedElements.clear();
        this.visibleRange = { start: -1, end: -1 };

        // Decide whether to enable virtual scrolling based on threshold
        const shouldEnableVirtual = this.config.forceVirtual || this.items.length >= this.config.threshold;

        if (shouldEnableVirtual !== this.isVirtualEnabled) {
            this.isVirtualEnabled = shouldEnableVirtual;

            if (!shouldEnableVirtual) {
                // Fall back to standard rendering
                this._renderAllItems();
                return;
            }
        }

        if (!this.isVirtualEnabled) {
            this._renderAllItems();
            return;
        }

        // Clear container
        this.container.innerHTML = '';

        // Recalculate layout
        this._recalculateLayout();

        // Render visible items
        this._updateVisibleItems();
    }

    /**
     * Append items to existing list (for infinite scroll)
     * @param {Array} newItems - Additional items
     */
    appendItems(newItems) {
        if (!newItems || newItems.length === 0) return;

        const previousLength = this.items.length;
        this.items = [...this.items, ...newItems];

        if (!this.isVirtualEnabled) {
            // Just append to DOM
            const fragment = document.createDocumentFragment();
            newItems.forEach((item, i) => {
                const index = previousLength + i;
                const element = this._createItemElement(index, item);
                fragment.appendChild(element);
            });
            this.container.appendChild(fragment);
            return;
        }

        // Recalculate layout
        this._recalculateLayout();

        // Check if new items are in visible range
        this._updateVisibleItems();
    }

    /**
     * Recalculate layout dimensions
     */
    _recalculateLayout() {
        if (!this.container) return;

        const containerWidth = this.container.clientWidth;
        const itemAspectRatio = Number(this.config.itemAspectRatio) > 0 ? Number(this.config.itemAspectRatio) : 1;

        // Calculate columns based on minimum width
        this.columns = Math.max(1, Math.floor(
            (containerWidth + this.config.columnGap) /
            (this.config.minColumnWidth + this.config.columnGap)
        ));

        // Calculate item dimensions
        this.itemWidth = (containerWidth - (this.columns - 1) * this.config.columnGap) / this.columns;
        this.itemHeight = this.itemWidth / itemAspectRatio;

        // Calculate total height
        const totalRows = Math.ceil(this.items.length / this.columns);
        this.totalHeight = Math.max(0, totalRows * (this.itemHeight + this.config.rowGap) - this.config.rowGap);

        // Set container styles for virtual scrolling
        this.container.style.position = 'relative';
        this.container.style.display = 'block';
        this.container.style.minHeight = `${this.totalHeight}px`;
        this.container.style.gridTemplateColumns = '';

        // Build layout cache for item positions
        this._buildLayoutCache();
    }

    /**
     * Build cache of item positions for quick lookups
     */
    _buildLayoutCache() {
        this.layoutCache = [];

        for (let i = 0; i < this.items.length; i++) {
            const row = Math.floor(i / this.columns);
            const col = i % this.columns;

            const top = row * (this.itemHeight + this.config.rowGap);
            const left = col * (this.itemWidth + this.config.columnGap);

            this.layoutCache.push({
                index: i,
                row,
                col,
                top,
                left,
                width: this.itemWidth,
                height: this.itemHeight,
            });
        }
    }

    /**
     * Update visible items based on scroll position
     */
    _updateVisibleItems() {
        if (!this.isVirtualEnabled || !this.container || !this.scrollContainer) return;

        if (this.items.length === 0) {
            this._renderEmptyState();
            return;
        }

        const viewportHeight = this._getViewportHeight();
        const relativeScroll = this._getRelativeScroll();

        const rowHeight = this.itemHeight + this.config.rowGap;
        const bufferHeight = this.config.bufferSize * rowHeight;

        // Calculate visible range with buffer
        const visibleTop = relativeScroll - bufferHeight;
        const visibleBottom = relativeScroll + viewportHeight + bufferHeight;

        const firstVisibleRow = Math.max(0, Math.floor(visibleTop / rowHeight));
        const lastVisibleRow = Math.min(
            Math.ceil(this.items.length / this.columns) - 1,
            Math.ceil(visibleBottom / rowHeight)
        );

        const firstVisibleIdx = firstVisibleRow * this.columns;
        const lastVisibleIdx = Math.min(this.items.length - 1, (lastVisibleRow + 1) * this.columns - 1);

        // Skip if range hasn't changed significantly
        if (this.visibleRange.start === firstVisibleIdx && this.visibleRange.end === lastVisibleIdx) {
            return;
        }

        this.visibleRange = { start: firstVisibleIdx, end: lastVisibleIdx };

        // Remove items that are no longer visible
        this._recycleInvisibleItems(firstVisibleIdx, lastVisibleIdx);

        // Add newly visible items
        this._renderVisibleRange(firstVisibleIdx, lastVisibleIdx);
    }

    /**
     * Remove items outside the visible range
     */
    _recycleInvisibleItems(visibleStart, visibleEnd) {
        const keysToRemove = [];

        for (const [key, itemData] of this.renderedElements) {
            if (itemData.index < visibleStart || itemData.index > visibleEnd) {
                keysToRemove.push(key);
            }
        }

        for (const key of keysToRemove) {
            const itemData = this.renderedElements.get(key);
            if (itemData && itemData.element) {
                itemData.element.remove();
            }
            this.renderedElements.delete(key);
        }
    }

    /**
     * Render items in the visible range
     */
    _renderVisibleRange(startIdx, endIdx) {
        const fragment = document.createDocumentFragment();
        const newElements = [];

        for (let i = startIdx; i <= endIdx && i < this.items.length; i++) {
            const key = this.getItemKey(i, this.items[i]);

            if (!this.renderedElements.has(key)) {
                const element = this._createItemElement(i, this.items[i]);
                this.renderedElements.set(key, {
                    element,
                    index: i,
                    data: this.items[i],
                });
                fragment.appendChild(element);
                newElements.push(element);
            }
        }

        if (newElements.length > 0) {
            this.container.appendChild(fragment);
            this._notifyItemsRendered(newElements);
        }
    }

    /**
     * Create a single item element with positioning
     */
    _createItemElement(index, data) {
        const layout = this.layoutCache[index];
        if (!layout) return null;

        const element = this.renderItem(index, data);

        if (element) {
            element.style.position = 'absolute';
            element.style.top = `${layout.top}px`;
            element.style.left = `${layout.left}px`;
            element.style.width = `${layout.width}px`;
            element.style.height = `${layout.height}px`;
            element.dataset.virtualIndex = index;
        }

        return element;
    }

    /**
     * Render all items (fallback for small lists)
     */
    _renderAllItems() {
        this.container.innerHTML = '';
        this.container.classList.remove('virtual-scroll');
        this.container.style.position = '';
        this.container.style.display = '';
        this.container.style.minHeight = '';
        this.container.style.gridTemplateColumns = '';

        const fragment = document.createDocumentFragment();
        const renderedElements = [];

        for (let i = 0; i < this.items.length; i++) {
            const element = this.renderItem(i, this.items[i]);
            if (element) {
                element.dataset.virtualIndex = i;
                fragment.appendChild(element);
                renderedElements.push(element);
            }
        }

        this.container.appendChild(fragment);
        this._notifyItemsRendered(renderedElements);
    }

    /**
     * Render empty state
     */
    _renderEmptyState() {
        this.container.innerHTML = '';
        this.container.style.display = '';
        this.container.style.position = '';
        this.container.style.minHeight = '';
        this.container.style.gridTemplateColumns = '';
    }

    /**
     * Update a single item without full re-render
     * @param {number|string} key - Item key
     * @param {Object} newData - Updated item data
     */
    updateItem(key, newData) {
        const itemData = this.renderedElements.get(key);
        if (!itemData) return false;

        const newElement = this.renderItem(itemData.index, newData);
        if (newElement && itemData.element.parentNode) {
            itemData.element.parentNode.replaceChild(newElement, itemData.element);
            itemData.element = newElement;
            itemData.data = newData;

            // Apply positioning
            const layout = this.layoutCache[itemData.index];
            if (layout) {
                newElement.style.position = 'absolute';
                newElement.style.top = `${layout.top}px`;
                newElement.style.left = `${layout.left}px`;
                newElement.style.width = `${layout.width}px`;
                newElement.style.height = `${layout.height}px`;
            }
        }

        return true;
    }

    /**
     * Update item class/state without re-creating element
     * @param {number|string} key - Item key
     * @param {string} className - Class to toggle
     * @param {boolean} add - Whether to add or remove the class
     */
    toggleItemClass(key, className, add) {
        const itemData = this.renderedElements.get(key);
        if (!itemData || !itemData.element) return false;

        if (add) {
            itemData.element.classList.add(className);
        } else {
            itemData.element.classList.remove(className);
        }

        if (className === 'selected') {
            itemData.element.setAttribute('aria-selected', add ? 'true' : 'false');
        }

        return true;
    }

    /**
     * Scroll to a specific item
     * @param {number} index - Item index
     */
    scrollToItem(index) {
        if (index < 0 || index >= this.items.length) return;

        const layout = this.layoutCache[index];
        if (!layout) return;

        this.scrollContainer.scrollTop = layout.top;
    }

    /**
     * Get the item index at a specific scroll position
     * @param {number} scrollTop - Scroll position
     * @returns {number} Item index
     */
    getItemAtScrollPosition(scrollTop) {
        const row = Math.floor(scrollTop / (this.itemHeight + this.config.rowGap));
        return Math.min(row * this.columns, this.items.length - 1);
    }

    /**
     * Get current rendered item count
     * @returns {number}
     */
    getRenderedCount() {
        return this.renderedElements.size;
    }

    /**
     * Check if virtual scrolling is enabled
     * @returns {boolean}
     */
    isVirtual() {
        return this.isVirtualEnabled;
    }

    /**
     * Force a layout recalculation and re-render
     */
    refresh() {
        this._recalculateLayout();
        this._updateVisibleItems();
    }

    /**
     * Update configuration
     * @param {Object} newConfig - Configuration overrides
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };

        // Re-evaluate virtual scrolling
        const shouldEnableVirtual = this.config.forceVirtual || this.items.length >= this.config.threshold;
        if (shouldEnableVirtual !== this.isVirtualEnabled) {
            this.setItems(this.items);
        } else {
            this.refresh();
        }
    }

    /**
     * Reconfigure rendering without destroying observers/listeners.
     * Useful when the same virtual list can be reused across view changes.
     * @param {Object} options
     */
    reconfigure(options = {}) {
        if (typeof options.renderItem === 'function') {
            this.renderItem = options.renderItem;
        }
        if (typeof options.getItemKey === 'function') {
            this.getItemKey = options.getItemKey;
        }
        if (typeof options.estimateItemHeight === 'function') {
            this.estimateItemHeight = options.estimateItemHeight;
        }
        if (Object.prototype.hasOwnProperty.call(options, 'onItemsRendered')) {
            this.onItemsRendered = typeof options.onItemsRendered === 'function' ? options.onItemsRendered : null;
        }
        if (options.config) {
            this.config = { ...this.config, ...options.config };
        }

        this.renderedElements.forEach(({ element }) => element?.remove());
        this.renderedElements.clear();
        this.visibleRange = { start: -1, end: -1 };

        const shouldEnableVirtual = this.config.forceVirtual || this.items.length >= this.config.threshold;
        this.isVirtualEnabled = shouldEnableVirtual;

        if (!shouldEnableVirtual) {
            this._renderAllItems();
            return;
        }

        this.container.innerHTML = '';
        this.container.classList.add('virtual-scroll');
        this._recalculateLayout();
        this._updateVisibleItems();
    }

    /**
     * Get the index for a key using the configured key getter.
     * @param {number|string} targetKey
     * @returns {number}
     */
    getIndexForKey(targetKey) {
        for (let i = 0; i < this.items.length; i++) {
            if (String(this.getItemKey(i, this.items[i])) === String(targetKey)) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Get layout data for an item index.
     * @param {number} index
     * @returns {Object|null}
     */
    getLayoutForIndex(index) {
        return this.layoutCache?.[index] || null;
    }

    /**
     * Get layout data for an item key.
     * @param {number|string} targetKey
     * @returns {Object|null}
     */
    getLayoutForKey(targetKey) {
        const index = this.getIndexForKey(targetKey);
        return index >= 0 ? this.getLayoutForIndex(index) : null;
    }

    /**
     * Notify caller when new elements have been mounted.
     * @param {HTMLElement[]} elements
     */
    _notifyItemsRendered(elements) {
        if (!this.onItemsRendered || !elements || elements.length === 0) return;

        try {
            this.onItemsRendered(elements);
        } catch (error) {
            if (typeof window !== 'undefined' && window.Logger) {
                window.Logger.warn('VirtualList: onItemsRendered callback failed:', error);
            }
        }
    }

    /**
     * Clean up and destroy the instance
     */
    destroy() {
        // Clear timers
        clearTimeout(this.resizeDebounceTimer);
        if (this.scrollRAF) {
            cancelAnimationFrame(this.scrollRAF);
            this.scrollRAF = null;
        }

        // Disconnect observers
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }

        // Remove scroll listener
        if (this.scrollHandler) {
            this.scrollEventTarget.removeEventListener('scroll', this.scrollHandler);
            this.scrollHandler = null;
        }

        // Remove sentinel elements
        if (this.topSentinel && this.topSentinel.parentNode) {
            this.topSentinel.parentNode.removeChild(this.topSentinel);
        }
        if (this.bottomSentinel && this.bottomSentinel.parentNode) {
            this.bottomSentinel.parentNode.removeChild(this.bottomSentinel);
        }

        // Clear rendered elements
        this.onItemsRendered = null;
        this.renderedElements.clear();

        // Remove virtual-scroll class
        if (this.container) {
            this.container.innerHTML = '';
            this.container.classList.remove('virtual-scroll');
            this.container.style.position = '';
            this.container.style.display = '';
            this.container.style.minHeight = '';
            this.container.style.gridTemplateColumns = '';
        }

        // Clear state
        this.items = [];
        this.layoutCache = null;
        this.visibleRange = { start: -1, end: -1 };
        this.isVirtualEnabled = false;
    }
}

/**
 * WaterfallLayout Extension
 * Extends VirtualList to support waterfall (masonry) layout
 */
class WaterfallVirtualList extends VirtualList {
    constructor(options) {
        super(options);

        // Waterfall-specific config
        this.columnHeights = [];      // Current height of each column
        this.itemPositions = [];      // Position data for each item
        this.columnWidth = 0;

        // Waterfall config
        this.waterfallConfig = {
            columnWidth: options.columnWidth || 280,
            minHeight: options.minHeight || 180,
            maxHeight: options.maxHeight || 600,
            estimatedHeight: options.estimatedHeight || 350,
        };
    }

    /**
     * Recalculate layout for waterfall mode
     */
    _recalculateLayout() {
        if (!this.container) return;

        const containerWidth = this.container.clientWidth;

        // Calculate columns based on column width
        this.columns = Math.max(1, Math.floor(
            (containerWidth + this.config.columnGap) /
            (this.waterfallConfig.columnWidth + this.config.columnGap)
        ));

        this.columnWidth = (containerWidth - (this.columns - 1) * this.config.columnGap) / this.columns;

        // Reset column heights
        this.columnHeights = new Array(this.columns).fill(0);
        this.itemPositions = [];

        // Calculate positions for each item
        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];

            // Estimate height based on aspect ratio
            let height = this._estimateItemHeight(i, item);

            // Find shortest column
            let minCol = 0;
            let minHeight = this.columnHeights[0];
            for (let c = 1; c < this.columns; c++) {
                if (this.columnHeights[c] < minHeight) {
                    minCol = c;
                    minHeight = this.columnHeights[c];
                }
            }

            // Store position
            this.itemPositions.push({
                index: i,
                column: minCol,
                top: minHeight,
                left: minCol * (this.columnWidth + this.config.columnGap),
                width: this.columnWidth,
                height,
            });

            // Update column height
            this.columnHeights[minCol] += height + this.config.rowGap;
        }

        // Total height is the tallest column
        this.totalHeight = Math.max(0, Math.max(...this.columnHeights, 0) - this.config.rowGap);

        // Set container styles
        this.container.style.position = 'relative';
        this.container.style.display = 'block';
        this.container.style.minHeight = `${this.totalHeight}px`;
        this.container.style.gridTemplateColumns = '';

        // Use itemPositions as layout cache
        this.layoutCache = this.itemPositions;
    }

    /**
     * Append items without reflowing already-positioned cards.
     * Existing items stay in place; only new items are laid out below.
     */
    appendItems(newItems) {
        if (!newItems || newItems.length === 0) return;

        const previousLength = this.items.length;
        this.items = [...this.items, ...newItems];

        if (!this.isVirtualEnabled) {
            this.setItems(this.items);
            return;
        }

        if (!this.container) {
            this._recalculateLayout();
            this._updateVisibleItems();
            return;
        }

        const containerWidth = this.container.clientWidth;
        const nextColumns = Math.max(1, Math.floor(
            (containerWidth + this.config.columnGap) /
            (this.waterfallConfig.columnWidth + this.config.columnGap)
        ));
        const nextColumnWidth = (containerWidth - (nextColumns - 1) * this.config.columnGap) / nextColumns;

        if (
            this.itemPositions.length === 0 ||
            nextColumns !== this.columns ||
            Math.abs(nextColumnWidth - this.columnWidth) > 1
        ) {
            this._recalculateLayout();
            this._updateVisibleItems();
            return;
        }

        newItems.forEach((item, offset) => {
            const index = previousLength + offset;
            const height = this._estimateItemHeight(index, item);

            let minCol = 0;
            let minHeight = this.columnHeights[0];
            for (let c = 1; c < this.columns; c++) {
                if (this.columnHeights[c] < minHeight) {
                    minCol = c;
                    minHeight = this.columnHeights[c];
                }
            }

            this.itemPositions.push({
                index,
                column: minCol,
                top: minHeight,
                left: minCol * (this.columnWidth + this.config.columnGap),
                width: this.columnWidth,
                height,
            });

            this.columnHeights[minCol] += height + this.config.rowGap;
        });

        this.totalHeight = Math.max(0, Math.max(...this.columnHeights, 0) - this.config.rowGap);
        this.container.style.minHeight = `${this.totalHeight}px`;
        this.layoutCache = this.itemPositions;

        this._updateVisibleItems();
    }

    /**
     * Estimate item height based on aspect ratio
     */
    _estimateItemHeight(index, item) {
        if (item.width && item.height) {
            const aspectHeight = (item.height / item.width) * this.columnWidth;
            return Math.max(
                this.waterfallConfig.minHeight,
                Math.min(this.waterfallConfig.maxHeight, aspectHeight)
            );
        }
        return this.waterfallConfig.estimatedHeight;
    }

    /**
     * Update visible items for waterfall layout
     */
    _updateVisibleItems() {
        if (!this.isVirtualEnabled || !this.container || !this.scrollContainer) return;

        if (this.items.length === 0) {
            this._renderEmptyState();
            return;
        }

        const viewportHeight = this._getViewportHeight();
        const relativeScroll = this._getRelativeScroll();

        const bufferHeight = this.config.bufferSize * this.waterfallConfig.estimatedHeight;
        const visibleTop = relativeScroll - bufferHeight;
        const visibleBottom = relativeScroll + viewportHeight + bufferHeight;

        // Find visible items
        const visibleIndices = [];
        for (let i = 0; i < this.itemPositions.length; i++) {
            const pos = this.itemPositions[i];
            if (pos.top + pos.height >= visibleTop && pos.top <= visibleBottom) {
                visibleIndices.push(i);
            }
        }

        // Update visible range
        this.visibleRange = {
            start: visibleIndices.length > 0 ? Math.min(...visibleIndices) : -1,
            end: visibleIndices.length > 0 ? Math.max(...visibleIndices) : -1,
        };

        // Remove items that are no longer visible
        const keysToRemove = [];
        for (const [key, itemData] of this.renderedElements) {
            if (!visibleIndices.includes(itemData.index)) {
                keysToRemove.push(key);
            }
        }

        for (const key of keysToRemove) {
            const itemData = this.renderedElements.get(key);
            if (itemData && itemData.element) {
                itemData.element.remove();
            }
            this.renderedElements.delete(key);
        }

        // Add newly visible items
        const fragment = document.createDocumentFragment();
        const newElements = [];
        for (const i of visibleIndices) {
            const key = this.getItemKey(i, this.items[i]);

            if (!this.renderedElements.has(key)) {
                const element = this._createWaterfallItemElement(i, this.items[i]);
                if (element) {
                    this.renderedElements.set(key, {
                        element,
                        index: i,
                        data: this.items[i],
                    });
                    fragment.appendChild(element);
                    newElements.push(element);
                }
            }
        }

        if (newElements.length > 0) {
            this.container.appendChild(fragment);
            this._notifyItemsRendered(newElements);
        }
    }

    /**
     * Create a waterfall item element
     */
    _createWaterfallItemElement(index, data) {
        const layout = this.itemPositions[index];
        if (!layout) return null;

        const element = this.renderItem(index, data);

        if (element) {
            element.style.position = 'absolute';
            element.style.top = `${layout.top}px`;
            element.style.left = `${layout.left}px`;
            element.style.width = `${layout.width}px`;
            element.style.height = `${layout.height}px`;
            element.style.aspectRatio = 'auto';
            element.dataset.virtualIndex = index;
        }

        return element;
    }
}

// Export for use
if (typeof window !== 'undefined') {
    window.VirtualList = VirtualList;
    window.WaterfallVirtualList = WaterfallVirtualList;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { VirtualList, WaterfallVirtualList };
}
