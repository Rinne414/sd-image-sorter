/**
 * Skeleton Loading Components
 * Provides placeholder UI components for smooth loading states
 */

const Skeleton = {
    /**
     * Create a skeleton element with shimmer animation
     * @param {string} className - Additional class names
     * @param {object} options - Configuration options
     * @returns {HTMLDivElement}
     */
    create(className = '', options = {}) {
        const el = document.createElement('div');
        el.className = `skeleton ${className}`.trim();
        if (options.width) el.style.width = options.width;
        if (options.height) el.style.height = options.height;
        return el;
    },

    /**
     * Create a text skeleton
     * @param {string} size - Size variant: 'sm', 'md', 'lg', 'xl'
     * @param {number} count - Number of lines
     * @returns {DocumentFragment}
     */
    text(size = 'md', count = 1) {
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < count; i++) {
            const el = document.createElement('div');
            el.className = `skeleton skeleton-text${size ? ` ${size}` : ''}`.trim();
            // Vary width slightly for natural look
            if (i === count - 1 && count > 1) {
                el.style.width = '60%';
            }
            fragment.appendChild(el);
        }
        return fragment;
    },

    /**
     * Create an image skeleton placeholder
     * @param {object} options - Width and height options
     * @returns {HTMLDivElement}
     */
    image(options = {}) {
        const el = document.createElement('div');
        el.className = 'skeleton-image';
        if (options.width) el.style.width = options.width;
        if (options.height) el.style.height = options.height;
        return el;
    },

    /**
     * Create a gallery item skeleton
     * @returns {HTMLDivElement}
     */
    galleryItem() {
        const el = document.createElement('div');
        el.className = 'skeleton-gallery-item skeleton-item';
        el.innerHTML = `
            <div class="skeleton-image"></div>
            <div class="skeleton-overlay">
                <div class="skeleton-badge skeleton"></div>
            </div>
        `;
        return el;
    }
};

/**
 * SkeletonGallery - Renders placeholder gallery grid
 */
const SkeletonGallery = {
    container: null,
    count: 20,
    visible: false,

    /**
     * Initialize skeleton gallery
     * @param {HTMLElement|string} container - Container element or selector
     * @param {number} count - Number of skeleton items
     */
    init(container, count = 20) {
        this.container = typeof container === 'string'
            ? document.querySelector(container)
            : container;
        this.count = count;
    },

    /**
     * Show skeleton gallery
     * @param {string} viewMode - 'grid', 'large', or 'waterfall'
     */
    show(viewMode = 'grid') {
        if (!this.container) {
            this.container = document.getElementById('gallery-grid');
        }
        if (!this.container) return;

        // Clear existing content
        this.container.innerHTML = '';

        // Create skeleton grid
        const grid = document.createElement('div');
        grid.className = 'skeleton-gallery-grid';
        grid.id = 'skeleton-gallery-container';

        // Adjust count based on view mode
        const itemCount = viewMode === 'large' ? 12 : this.count;

        for (let i = 0; i < itemCount; i++) {
            const item = Skeleton.galleryItem();
            // Vary heights slightly for waterfall mode
            if (viewMode === 'waterfall') {
                const heights = [200, 250, 300, 350, 400];
                item.style.height = heights[Math.floor(Math.random() * heights.length)] + 'px';
            }
            grid.appendChild(item);
        }

        this.container.appendChild(grid);
        this.visible = true;
    },

    /**
     * Hide skeleton gallery with optional fade transition
     */
    hide(fade = false) {
        const skeletonEl = document.getElementById('skeleton-gallery-container');
        if (!skeletonEl) return;

        if (fade) {
            skeletonEl.classList.add('skeleton-fade-out');
            setTimeout(() => {
                skeletonEl.remove();
                this.visible = false;
            }, 300);
        } else {
            skeletonEl.remove();
            this.visible = false;
        }
    },

    /**
     * Check if skeleton is visible
     * @returns {boolean}
     */
    isVisible() {
        return this.visible && document.getElementById('skeleton-gallery-container') !== null;
    }
};

/**
 * SkeletonModal - Renders placeholder modal content
 */
const SkeletonModal = {
    container: null,

    /**
     * Show skeleton modal for image preview
     * @param {string} modalId - Modal element ID
     */
    showImageModal(modalId = 'image-modal') {
        const modal = document.getElementById(modalId);
        if (!modal) return;

        // Keep the persistent preview header visible while detail content loads.
        const infoColumn = modal.querySelector('.modal-info-scroll') || modal.querySelector('.modal-info-workspace');
        if (!infoColumn) return;

        // Create skeleton content wrapper
        const skeletonWrapper = document.createElement('div');
        skeletonWrapper.id = 'skeleton-modal-content';
        skeletonWrapper.innerHTML = `
            <div class="skeleton-actions">
                <div class="skeleton skeleton-action-btn"></div>
                <div class="skeleton skeleton-action-btn"></div>
                <div class="skeleton skeleton-action-btn"></div>
                <div class="skeleton skeleton-action-btn"></div>
            </div>
            <div class="skeleton skeleton-filename"></div>
            <div class="skeleton skeleton-meta-row"></div>
            <div class="skeleton skeleton-meta-row" style="width: 120px;"></div>
            <div class="skeleton skeleton-meta-row" style="width: 180px;"></div>
            <div class="skeleton-section">
                <div class="skeleton skeleton-section-title"></div>
                <div class="skeleton skeleton-prompt"></div>
            </div>
            <div class="skeleton-section">
                <div class="skeleton skeleton-section-title"></div>
                <div class="skeleton-tags">
                    <div class="skeleton skeleton-tag"></div>
                    <div class="skeleton skeleton-tag"></div>
                    <div class="skeleton skeleton-tag"></div>
                    <div class="skeleton skeleton-tag"></div>
                    <div class="skeleton skeleton-tag"></div>
                </div>
            </div>
        `;

        // Insert skeleton at the beginning of info column
        const existingSkeleton = infoColumn.querySelector('#skeleton-modal-content');
        if (existingSkeleton) {
            existingSkeleton.remove();
        }
        infoColumn.insertBefore(skeletonWrapper, infoColumn.firstChild);

        // Also add skeleton to image column
        const imageContainer = modal.querySelector('.modal-image-container');
        if (imageContainer) {
            const imageSkeleton = document.createElement('div');
            imageSkeleton.id = 'skeleton-modal-image';
            imageSkeleton.className = 'skeleton-image';
            imageSkeleton.style.cssText = 'width: 100%; max-width: 600px; aspect-ratio: 1; margin: auto;';

            const existingImageSkeleton = imageContainer.querySelector('#skeleton-modal-image');
            if (existingImageSkeleton) {
                existingImageSkeleton.remove();
            }

            const actualImage = imageContainer.querySelector('#modal-image');
            if (actualImage) {
                actualImage.style.opacity = '0';
                imageContainer.insertBefore(imageSkeleton, actualImage);
            }
        }
    },

    /**
     * Hide skeleton modal content
     * @param {string} modalId - Modal element ID
     */
    hideImageModal(modalId = 'image-modal') {
        const modal = document.getElementById(modalId);
        if (!modal) return;

        // Remove skeleton content
        const skeletonContent = modal.querySelector('#skeleton-modal-content');
        if (skeletonContent) {
            skeletonContent.remove();
        }

        // Remove skeleton image and show actual image
        const skeletonImage = modal.querySelector('#skeleton-modal-image');
        if (skeletonImage) {
            skeletonImage.remove();
        }

        const actualImage = modal.querySelector('#modal-image');
        if (actualImage) {
            actualImage.style.opacity = '1';
        }
    }
};

/**
 * SkeletonSidebar - Renders placeholder sidebar content
 */
const SkeletonSidebar = {
    container: null,

    /**
     * Show skeleton sidebar
     * @param {string} containerId - Sidebar container ID
     */
    show(containerId = 'view-gallery') {
        const view = document.getElementById(containerId);
        if (!view) return;

        const sidebar = view.querySelector('.filter-sidebar');
        if (!sidebar) return;

        // Add skeleton class to existing content
        sidebar.classList.add('skeleton-loading');

        // Create skeleton overlay
        const skeletonOverlay = document.createElement('div');
        skeletonOverlay.id = 'skeleton-sidebar-overlay';
        skeletonOverlay.className = 'skeleton-sidebar';
        skeletonOverlay.innerHTML = `
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton-section">
                <div class="skeleton skeleton-section-title"></div>
                <div class="skeleton skeleton-option"></div>
                <div class="skeleton skeleton-option"></div>
                <div class="skeleton skeleton-option"></div>
            </div>
            <div class="skeleton-section">
                <div class="skeleton skeleton-section-title"></div>
                <div class="skeleton skeleton-option"></div>
                <div class="skeleton skeleton-option"></div>
            </div>
            <div class="skeleton-section">
                <div class="skeleton skeleton-section-title"></div>
                <div class="skeleton skeleton-option"></div>
                <div class="skeleton skeleton-option"></div>
                <div class="skeleton skeleton-option"></div>
                <div class="skeleton skeleton-option"></div>
            </div>
            <div class="skeleton-section">
                <div class="skeleton skeleton-section-title"></div>
                <div class="skeleton skeleton-option"></div>
                <div class="skeleton skeleton-option"></div>
            </div>
        `;

        // Insert as first child of sidebar
        sidebar.insertBefore(skeletonOverlay, sidebar.firstChild);
    },

    /**
     * Hide skeleton sidebar
     * @param {string} containerId - Sidebar container ID
     */
    hide(containerId = 'view-gallery') {
        const view = document.getElementById(containerId);
        if (!view) return;

        const sidebar = view.querySelector('.filter-sidebar');
        if (!sidebar) return;

        sidebar.classList.remove('skeleton-loading');

        const skeletonOverlay = sidebar.querySelector('#skeleton-sidebar-overlay');
        if (skeletonOverlay) {
            skeletonOverlay.remove();
        }
    }
};

/**
 * SkeletonHeader - Renders placeholder gallery header
 */
const SkeletonHeader = {
    /**
     * Show skeleton header
     * @param {string} containerId - Header container ID
     */
    show(containerId = 'gallery-grid') {
        const grid = document.getElementById(containerId);
        if (!grid) return;

        // Insert skeleton header before the grid
        const existingHeader = grid.querySelector('#skeleton-header');
        if (existingHeader) return;

        const skeletonHeader = document.createElement('div');
        skeletonHeader.id = 'skeleton-header';
        skeletonHeader.className = 'skeleton-header';
        skeletonHeader.innerHTML = `
            <div class="skeleton-header-left">
                <div class="skeleton skeleton-count"></div>
                <div class="divider-v"></div>
                <div class="skeleton-generator-tabs">
                    <div class="skeleton skeleton-gen-tab"></div>
                    <div class="skeleton skeleton-gen-tab"></div>
                    <div class="skeleton skeleton-gen-tab"></div>
                    <div class="skeleton skeleton-gen-tab"></div>
                    <div class="skeleton skeleton-gen-tab"></div>
                </div>
            </div>
            <div class="skeleton-header-right">
                <div class="skeleton skeleton-dropdown"></div>
                <div class="divider-v"></div>
                <div class="skeleton skeleton-view-btn"></div>
                <div class="skeleton skeleton-view-btn"></div>
                <div class="skeleton skeleton-view-btn"></div>
            </div>
        `;

        grid.parentElement.insertBefore(skeletonHeader, grid);
    },

    /**
     * Hide skeleton header
     */
    hide() {
        const header = document.getElementById('skeleton-header');
        if (header) {
            header.remove();
        }
    }
};

/**
 * SkeletonFilterModal - Renders placeholder filter modal content
 */
const SkeletonFilterModal = {
    /**
     * Show skeleton filter modal
     * @param {string} modalId - Modal element ID
     */
    show(modalId = 'filter-modal') {
        const modal = document.getElementById(modalId);
        if (!modal) return;

        const content = modal.querySelector('.modal-content');
        if (!content) return;

        const skeletonContent = document.createElement('div');
        skeletonContent.id = 'skeleton-filter-content';
        skeletonContent.className = 'skeleton-filter-modal';
        skeletonContent.innerHTML = `
            <div class="skeleton skeleton-text lg" style="width: 150px;"></div>
            <div class="skeleton-filter-grid">
                <div class="skeleton-filter-section">
                    <div class="skeleton skeleton-filter-section-title"></div>
                    <div class="skeleton skeleton-filter-option"></div>
                    <div class="skeleton skeleton-filter-option"></div>
                    <div class="skeleton skeleton-filter-option"></div>
                    <div class="skeleton skeleton-filter-option"></div>
                    <div class="skeleton skeleton-filter-option"></div>
                </div>
                <div class="skeleton-filter-section">
                    <div class="skeleton skeleton-filter-section-title"></div>
                    <div class="skeleton skeleton-filter-input"></div>
                    <div class="skeleton skeleton-filter-option"></div>
                    <div class="skeleton skeleton-filter-option"></div>
                    <div class="skeleton skeleton-filter-option"></div>
                </div>
            </div>
        `;

        // Hide actual content
        const actualContent = modal.querySelector('.filter-modal-grid');
        if (actualContent) {
            actualContent.style.display = 'none';
        }

        content.appendChild(skeletonContent);
    },

    /**
     * Hide skeleton filter modal
     * @param {string} modalId - Modal element ID
     */
    hide(modalId = 'filter-modal') {
        const modal = document.getElementById(modalId);
        if (!modal) return;

        const skeletonContent = modal.querySelector('#skeleton-filter-content');
        if (skeletonContent) {
            skeletonContent.remove();
        }

        // Show actual content
        const actualContent = modal.querySelector('.filter-modal-grid');
        if (actualContent) {
            actualContent.style.display = '';
        }
    }
};

// Export to global scope
window.Skeleton = Skeleton;
window.SkeletonGallery = SkeletonGallery;
window.SkeletonModal = SkeletonModal;
window.SkeletonSidebar = SkeletonSidebar;
window.SkeletonHeader = SkeletonHeader;
window.SkeletonFilterModal = SkeletonFilterModal;
