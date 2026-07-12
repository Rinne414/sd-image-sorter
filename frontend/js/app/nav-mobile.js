/**
 * app/nav-mobile.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 3402-3665 (of 10,152): mobile navigation (leave-as-is per project rules).
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
// ============== Mobile Navigation ==============

function initMobileNavigation() {
    const mobileMenuToggle = $('#mobile-menu-toggle');
    const mobileNavOverlay = $('#mobile-nav-overlay');
    const mobileNavClose = $('#mobile-nav-close');
    const mobileNavItems = $$('.mobile-nav-item');

    // Toggle mobile menu
    mobileMenuToggle?.addEventListener('click', () => {
        toggleMobileMenu();
    });

    // Close mobile menu
    mobileNavClose?.addEventListener('click', () => {
        closeMobileMenu();
    });

    // Close menu when clicking overlay
    mobileNavOverlay?.addEventListener('click', (e) => {
        if (e.target === mobileNavOverlay) {
            closeMobileMenu();
        }
    });

    // Mobile nav item clicks
    mobileNavItems.forEach(item => {
        item.addEventListener('click', () => {
            const viewName = item.dataset.view;
            if (viewName) {
                // Update active state
                mobileNavItems.forEach(i => i.classList.remove('active'));
                item.classList.add('active');

                // Switch view and close menu
                switchView(viewName);
                closeMobileMenu();
            }
        });
    });

    // Mobile action buttons
    $('#mobile-btn-scan')?.addEventListener('click', () => {
        closeMobileMenu();
        showModal('scan-modal');
    });

    $('#mobile-btn-tag')?.addEventListener('click', () => {
        closeMobileMenu();
        showModal('tag-modal');
    });

    $('#mobile-btn-tags-library')?.addEventListener('click', () => {
        closeMobileMenu();
        openTagsLibrary();
    });

    $('#mobile-btn-model-manager')?.addEventListener('click', () => {
        closeMobileMenu();
        openModelManager();
    });

    // Mobile filter toggle (fixed button)
    const mobileFilterToggle = $('#mobile-filter-toggle');
    mobileFilterToggle?.addEventListener('click', () => {
        toggleMobileFilterSidebar();
    });

    // Mobile filter header button
    const mobileFilterHeaderBtn = $('#mobile-filter-header-btn');
    mobileFilterHeaderBtn?.addEventListener('click', () => {
        toggleMobileFilterSidebar();
    });

    // Close mobile menu on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (mobileNavOverlay?.classList.contains('visible')) {
                closeMobileMenu();
            }
            closeMobileFilterSidebar();
        }
    });

    // Handle resize - keep nav usable when tabs overflow on desktop
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const collapsed = updateNavigationOverflowState();
            if (!collapsed) {
                closeMobileMenu();
                closeMobileFilterSidebar();
            }
        }, 150);
    });

    updateNavigationOverflowState();
}

function toggleMobileMenu() {
    const mobileMenuToggle = $('#mobile-menu-toggle');
    const mobileNavOverlay = $('#mobile-nav-overlay');

    const isOpen = mobileNavOverlay?.classList.contains('visible');

    if (isOpen) {
        closeMobileMenu();
    } else {
        openMobileMenu();
    }
}

function syncBodyScrollLocks() {
    const mobileNavOverlay = $('#mobile-nav-overlay');
    const filterSidebar = $('.filter-sidebar');
    const shouldLock = mobileNavOverlay?.classList.contains('visible')
        || filterSidebar?.classList.contains('mobile-visible');
    document.body.style.overflow = shouldLock ? 'hidden' : '';
}

function setMobileFilterSidebarExpanded(expanded) {
    ['#mobile-filter-toggle', '#mobile-filter-header-btn'].forEach((selector) => {
        const button = $(selector);
        if (button) {
            button.setAttribute('aria-expanded', String(expanded));
        }
    });
}

function closeMobileFilterSidebar() {
    const filterSidebar = $('.filter-sidebar');
    if (filterSidebar) {
        filterSidebar.classList.remove('mobile-visible');
    }

    const overlay = $('.filter-sidebar-overlay');
    if (overlay) {
        overlay.remove();
    }

    setMobileFilterSidebarExpanded(false);
    syncBodyScrollLocks();
}

function openMobileMenu() {
    const mobileMenuToggle = $('#mobile-menu-toggle');
    const mobileNavOverlay = $('#mobile-nav-overlay');

    mobileMenuToggle?.classList.add('active');
    mobileMenuToggle?.setAttribute('aria-expanded', 'true');
    mobileNavOverlay?.classList.add('visible');

    syncBodyScrollLocks();

    // Sync active state with current view
    const currentView = AppState.currentView;
    $$('.mobile-nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.view === currentView);
    });
}

function closeMobileMenu() {
    const mobileMenuToggle = $('#mobile-menu-toggle');
    const mobileNavOverlay = $('#mobile-nav-overlay');

    mobileMenuToggle?.classList.remove('active');
    mobileMenuToggle?.setAttribute('aria-expanded', 'false');
    mobileNavOverlay?.classList.remove('visible');

    syncBodyScrollLocks();
}

function toggleMobileFilterSidebar() {
    const filterSidebar = $('.filter-sidebar');

    if (filterSidebar) {
        const willOpen = !filterSidebar.classList.contains('mobile-visible');
        if (!willOpen) {
            closeMobileFilterSidebar();
            return;
        }

        filterSidebar.classList.add('mobile-visible');
        setMobileFilterSidebarExpanded(true);

        // If showing, add a close button dynamically
        if (filterSidebar.classList.contains('mobile-visible')) {
            // Add overlay for closing
            if (!$('.filter-sidebar-overlay')) {
                const overlay = document.createElement('div');
                overlay.className = 'filter-sidebar-overlay';
                overlay.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.7);
                    z-index: 999;
                `;
                overlay.addEventListener('click', () => closeMobileFilterSidebar());
                document.body.appendChild(overlay);
            }

            syncBodyScrollLocks();
        }
    }
}

// Function to update mobile filter badge
function updateMobileFilterBadge() {
    const badge = $('#mobile-filter-badge');
    if (!badge) return;

    // Count active filters
    let filterCount = 0;

    // Check generators (if not all selected)
    const allGenerators = [...ALL_GENERATORS];
    if (AppState.filters.generators.length !== allGenerators.length) {
        filterCount++;
    }

    // Check ratings (if not all selected)
    const allRatings = ['general', 'sensitive', 'questionable', 'explicit'];
    if (AppState.filters.ratings.length !== allRatings.length) {
        filterCount++;
    }

    // Tags
    if (AppState.filters.tags && AppState.filters.tags.length > 0) {
        filterCount++;
    }

    // Checkpoints
    if (AppState.filters.checkpoints && AppState.filters.checkpoints.length > 0) {
        filterCount++;
    }

    // Loras
    if (AppState.filters.loras && AppState.filters.loras.length > 0) {
        filterCount++;
    }

    // Prompts
    if (AppState.filters.prompts && AppState.filters.prompts.length > 0) {
        filterCount++;
    }

    // Artist
    if (AppState.filters.artist) {
        filterCount++;
    }

    // Show/hide badge
    if (filterCount > 0) {
        badge.style.display = 'flex';
        badge.textContent = filterCount;
    } else {
        badge.style.display = 'none';
    }
}

