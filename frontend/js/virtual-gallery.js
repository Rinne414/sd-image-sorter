/**
 * SD Image Sorter - Virtual Scrolling Gallery
 * Renders only visible gallery items for performance with large collections.
 * Replaces the default Gallery.render() with a virtualized version.
 */

const VirtualGallery = {
    // Configuration
    BUFFER_ROWS: 3,       // Extra rows above/below viewport
    ITEM_MIN_WIDTH: 200,  // Matches CSS grid minmax
    ROW_GAP: 16,          // Matches CSS gap

    // State
    containerEl: null,
    scrollEl: null,
    sentinelEl: null,
    itemHeight: 0,
    columns: 0,
    totalRows: 0,
    visibleStart: 0,
    visibleEnd: 0,
    renderedItems: new Map(), // row index -> DOM element
    images: [],
    isLargeGrid: false,
    resizeObserver: null,
    scrollRAF: null,
    initialized: false,

    /**
     * Initialize virtual gallery, replacing the default render.
     */
    init() {
        if (this.initialized) return;

        const grid = document.getElementById('gallery-grid');
        if (!grid) return;

        this.containerEl = grid;
        this.scrollEl = grid.parentElement; // The scrollable container

        // Create sentinel for total height
        this.sentinelEl = document.createElement('div');
        this.sentinelEl.className = 'virtual-gallery-sentinel';
        this.sentinelEl.style.cssText = 'width: 100%; pointer-events: none;';

        // Observe container resize to recalculate columns
        this.resizeObserver = new ResizeObserver(() => {
            this.recalculate();
        });
        this.resizeObserver.observe(this.containerEl);

        // Bind scroll handler
        this.scrollEl.addEventListener('scroll', () => this.onScroll(), { passive: true });

        // Override Gallery.render with virtual version
        const originalSetImages = Gallery.setImages.bind(Gallery);
        Gallery.setImages = (images) => {
            Gallery.images = images;
            this.setImages(images);
        };

        // Also override direct render calls
        Gallery.render = () => {
            this.setImages(Gallery.images);
        };

        this.initialized = true;
    },

    /**
     * Set images and trigger virtual render.
     */
    setImages(images) {
        this.images = images || [];
        this.renderedItems.clear();
        this.recalculate();
        this.renderVisible();
    },

    /**
     * Recalculate layout dimensions.
     */
    recalculate() {
        if (!this.containerEl) return;

        const containerWidth = this.containerEl.clientWidth;
        const minWidth = this.isLargeGrid ? 300 : this.ITEM_MIN_WIDTH;

        // Calculate columns (matches CSS auto-fill behavior)
        this.columns = Math.max(1, Math.floor((containerWidth + this.ROW_GAP) / (minWidth + this.ROW_GAP)));

        // Calculate item height (square aspect ratio)
        const itemWidth = (containerWidth - (this.columns - 1) * this.ROW_GAP) / this.columns;
        this.itemHeight = itemWidth; // aspect-ratio: 1

        // Total rows
        this.totalRows = Math.ceil(this.images.length / this.columns);

        // Update sentinel height to maintain scroll range
        const totalHeight = this.totalRows * (this.itemHeight + this.ROW_GAP) - this.ROW_GAP;
        this.sentinelEl.style.height = Math.max(0, totalHeight) + 'px';

        // Set container to relative for absolute positioned rows
        this.containerEl.style.position = 'relative';
        this.containerEl.style.display = 'block';
        this.containerEl.style.minHeight = Math.max(0, totalHeight) + 'px';

        // Re-render visible items
        this.renderVisible();
    },

    /**
     * Handle scroll events.
     */
    onScroll() {
        if (this.scrollRAF) return;
        this.scrollRAF = requestAnimationFrame(() => {
            this.scrollRAF = null;
            this.renderVisible();
        });
    },

    /**
     * Calculate and render only visible rows.
     */
    renderVisible() {
        if (!this.containerEl || this.images.length === 0) {
            this.containerEl.innerHTML = '';
            if (this.images.length === 0) {
                this.containerEl.style.display = 'grid';
                this.containerEl.innerHTML = `
                    <div style="grid-column: 1/-1; text-align: center; padding: 60px; color: var(--text-secondary);">
                        <div style="font-size: 48px; margin-bottom: 16px;">📷</div>
                        <p>No images found. Click "Scan Folder" to add images.</p>
                    </div>
                `;
            }
            return;
        }

        const scrollTop = this.scrollEl.scrollTop;
        const viewportHeight = this.scrollEl.clientHeight;
        const containerTop = this.containerEl.offsetTop - this.scrollEl.offsetTop;
        const relativeScroll = scrollTop - containerTop;

        const rowHeight = this.itemHeight + this.ROW_GAP;

        // Calculate visible row range
        const firstVisibleRow = Math.max(0, Math.floor(relativeScroll / rowHeight) - this.BUFFER_ROWS);
        const lastVisibleRow = Math.min(
            this.totalRows - 1,
            Math.ceil((relativeScroll + viewportHeight) / rowHeight) + this.BUFFER_ROWS
        );

        // Remove rows that are no longer visible
        for (const [rowIdx, rowEl] of this.renderedItems) {
            if (rowIdx < firstVisibleRow || rowIdx > lastVisibleRow) {
                rowEl.remove();
                this.renderedItems.delete(rowIdx);
            }
        }

        // Add newly visible rows
        for (let rowIdx = firstVisibleRow; rowIdx <= lastVisibleRow; rowIdx++) {
            if (!this.renderedItems.has(rowIdx)) {
                const rowEl = this.createRow(rowIdx);
                if (rowEl) {
                    this.containerEl.appendChild(rowEl);
                    this.renderedItems.set(rowIdx, rowEl);
                }
            }
        }

        this.visibleStart = firstVisibleRow;
        this.visibleEnd = lastVisibleRow;
    },

    /**
     * Create a row of gallery items.
     */
    createRow(rowIndex) {
        const startIdx = rowIndex * this.columns;
        if (startIdx >= this.images.length) return null;

        const endIdx = Math.min(startIdx + this.columns, this.images.length);
        const rowHeight = this.itemHeight + this.ROW_GAP;
        const topOffset = rowIndex * rowHeight;

        const { API, AppState } = window.App || {};
        const genColors = {
            comfyui: '#22c55e',
            nai: '#f97316',
            webui: '#3b82f6',
            forge: '#8b5cf6',
            unknown: '#64748b'
        };

        const rowEl = document.createElement('div');
        rowEl.className = 'virtual-row';
        rowEl.style.cssText = `
            position: absolute;
            top: ${topOffset}px;
            left: 0;
            right: 0;
            display: grid;
            grid-template-columns: repeat(${this.columns}, 1fr);
            gap: ${this.ROW_GAP}px;
            height: ${this.itemHeight}px;
        `;
        rowEl.dataset.row = rowIndex;

        for (let i = startIdx; i < endIdx; i++) {
            const image = this.images[i];
            const item = document.createElement('div');
            item.className = 'gallery-item';

            if (AppState && AppState.selectedIds.has(image.id)) {
                item.classList.add('selected');
            }

            item.dataset.id = image.id;
            item.draggable = true;
            item.style.cssText = `
                position: relative;
                aspect-ratio: 1;
                border-radius: 12px;
                overflow: hidden;
                background: var(--bg-card);
                cursor: pointer;
            `;

            const thumbnailUrl = API ? API.getThumbnailUrl(image.id) : `/api/image-thumbnail/${image.id}`;
            item.innerHTML = `
                <img src="${thumbnailUrl}" alt="${image.filename}" loading="lazy"
                     style="width:100%;height:100%;object-fit:cover;">
                <div class="gallery-item-overlay">
                    <span class="gallery-item-generator" style="background: ${genColors[image.generator] || genColors.unknown}">
                        ${image.generator}
                    </span>
                </div>
            `;

            // Click handler
            item.addEventListener('click', () => {
                if (AppState && AppState.selectionMode) {
                    Gallery.toggleSelection(image.id);
                } else {
                    Gallery.openPreview(image.id);
                }
            });

            // Drag support
            item.addEventListener('dragstart', (e) => {
                const imgUrl = API ? API.getImageUrl(image.id) : `/api/image-file/${image.id}`;
                const absoluteUrl = new URL(imgUrl, window.location.origin).href;

                e.dataTransfer.setData('text/uri-list', absoluteUrl);
                e.dataTransfer.setData('text/plain', absoluteUrl);

                const mimeType = image.filename.toLowerCase().endsWith('.png') ? 'image/png' :
                    image.filename.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
                e.dataTransfer.setData('DownloadURL', `${mimeType}:${image.filename}:${absoluteUrl}`);

                const img = item.querySelector('img');
                if (img && img.src) {
                    e.dataTransfer.setDragImage(img, 50, 50);
                }

                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'copyMove';
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
            });

            rowEl.appendChild(item);
        }

        return rowEl;
    },

    /**
     * Toggle large grid mode.
     */
    setLargeGrid(isLarge) {
        this.isLargeGrid = isLarge;
        this.ITEM_MIN_WIDTH = isLarge ? 300 : 200;
        this.recalculate();
    },

    /**
     * Clean up observers and listeners.
     */
    destroy() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.scrollRAF) {
            cancelAnimationFrame(this.scrollRAF);
            this.scrollRAF = null;
        }
        this.renderedItems.clear();
        this.initialized = false;
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Delay init slightly to ensure Gallery is available
    setTimeout(() => {
        VirtualGallery.init();
    }, 50);
});

window.VirtualGallery = VirtualGallery;
