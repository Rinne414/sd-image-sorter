/**
 * modules/components/virtual-list-waterfall.js — virtual-list.js decomposition.
 * Moved BYTE-IDENTICAL from virtual-list.js pre-cut lines 825-1123: the
 * WaterfallVirtualList subclass and the dual window/CommonJS export tail
 * (which needs BOTH classes in scope). `extends VirtualList` resolves the
 * global lexical class binding created by virtual-list.js, so THIS FILE'S
 * <script> tag must come immediately after virtual-list.js in index.html
 * (TDZ: the binding exists only after that script executes). The base file
 * keeps a documented ~3%-over-800 structural exemption: VirtualList is one
 * cohesive 809-line class, and a prototype-mixin cut would flip its methods
 * from non-enumerable (class syntax) to enumerable (Object.assign), a real
 * semantic delta. Sloppy scope preserved: no 'use strict' added (class
 * bodies are inherently strict; the export tail is deliberately sloppy).
 */
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
     * Waterfall reads its column width from waterfallConfig (constructor
     * bound), not config.minColumnWidth — keep them in sync when the shared
     * thumbnail size pushes a new width through updateConfig (owner FB-3).
     */
    updateConfig(newConfig) {
        if (newConfig && Number(newConfig.minColumnWidth) > 0) {
            this.waterfallConfig.columnWidth = Number(newConfig.minColumnWidth);
        }
        super.updateConfig(newConfig);
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
     * Get waterfall layout data for an item index.
     * @param {number} index
     * @returns {Object|null}
     */
    _getLayoutForIndex(index) {
        return this.itemPositions?.[index] || null;
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
