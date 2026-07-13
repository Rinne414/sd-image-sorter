/**
 * gallery/lifecycle-a11y.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 4407-4514 (of 4,708): destroy + virtual stats + keyboard navigation + aria announcers.
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    // Cleanup when switching views
    destroy() {
        this._cancelPendingWork();
        if (this.lazyObserver) {
            this.lazyObserver.disconnect();
            this.lazyObserver = null;
        }
        // Cleanup virtual list
        if (this.virtualList) {
            this.virtualList.destroy();
            this.virtualList = null;
        }
        this.useVirtualScroll = false;
        // Also cleanup legacy VirtualGallery if it's active
        if (window.VirtualGallery && typeof window.VirtualGallery.destroy === 'function') {
            window.VirtualGallery.destroy();
        }
    },

    /**
     * Get virtual scrolling statistics
     * @returns {Object} Statistics object
     */
    getVirtualStats() {
        return {
            enabled: this.useVirtualScroll,
            itemCount: this.images.length,
            renderedCount: this.virtualList ? this.virtualList.getRenderedCount() : this.images.length,
            threshold: GALLERY_VIRTUAL_CONFIG.threshold,
        };
    },

    /**
     * Initialize keyboard navigation for gallery grid
     * Enables arrow key navigation within the gallery grid
     */
    initKeyboardNavigation() {
        if (this._keyboardNavInitialized) return;
        this._keyboardNavInitialized = true;

        const grid = document.getElementById('gallery-grid');
        if (!grid) return;

        grid.addEventListener('keydown', (e) => {
            // Only handle arrow keys when focus is on a gallery item.
            if (!e.target.classList.contains('gallery-item')) return;
            // Delegate the shared grid-navigation logic to the A11y utility so
            // the switch/focus handling lives in one place. We keep the gallery
            // semantics intact: clamp at edges (wrap:false), dynamic column
            // count from the live layout, and a screen-reader position announce
            // on each move. Enter/Space still open via the per-item keydown.
            const a11y = window.A11y;
            if (!a11y || typeof a11y.handleGridKeyboardNavigation !== 'function') return;

            const total = grid.querySelectorAll('.gallery-item').length;
            const gridStyle = window.getComputedStyle(grid);
            const gridWidth = grid.offsetWidth;
            const itemWidth = grid.querySelector('.gallery-item')?.offsetWidth || 200;
            const columnGap = parseInt(gridStyle.columnGap) || 16;
            const columns = Math.max(1, Math.floor((gridWidth + columnGap) / (itemWidth + columnGap)));

            a11y.handleGridKeyboardNavigation(e, grid, '.gallery-item', {
                columns,
                wrap: false,
                onNavigate: (_item, index) => this.announceImagePosition(index, total),
            });
        });
    },

    /**
     * Announce image position to screen readers
     * @param {number} index - Current image index
     * @param {number} total - Total number of images
     */
    announceImagePosition(index, total) {
        const image = this.images[index];
        if (!image) return;

        const message = `Image ${index + 1} of ${total}: ${image.filename || 'Untitled'}`;
        if (window.A11y && typeof window.A11y.announce === 'function') {
            window.A11y.announce(message, 'polite');
        }
    },

    /**
     * Announce loading state to screen readers
     * @param {string} message - The message to announce
     */
    announceLoading(message) {
        if (window.A11y && typeof window.A11y.announce === 'function') {
            window.A11y.announce(message, 'polite');
        }
    },

    /**
     * Announce selection change to screen readers
     * @param {string} imageId - The image ID
     * @param {boolean} selected - Whether the image is selected
     */
    announceSelection(imageId, selected) {
        const image = this.images.find(img => img.id === imageId);
        const filename = image?.filename || 'Image';
        const message = selected ? `${filename} selected` : `${filename} deselected`;
        if (window.A11y && typeof window.A11y.announce === 'function') {
            window.A11y.announce(message, 'polite');
        }
    },

});
