/**
 * SD Image Sorter - Onboarding Tour
 * Interactive guided tour for new users
 */

const OnboardingTour = (function() {
    'use strict';

    const STORAGE_KEY = 'sd-image-sorter-onboarding-completed';
    const DISMISSED_KEY = 'sd-image-sorter-onboarding-dismissed-version';
    const AUTO_START_ENABLED = true;
    const FIRST_RUN_CHECK_KEY = 'sd-image-sorter-has-seen-images';

    // Current tour version - increment when adding new features
    const TOUR_VERSION = 1;

    // Tour step definitions
    const TOUR_STEPS = [
        {
            id: 'welcome',
            title: 'Welcome to SD Image Sorter',
            content: `<p>This tool helps you organize, tag, and manage your Stable Diffusion generated images.</p>
                <p>Features include:</p>
                <ul>
                    <li>Scan folders for images with metadata</li>
                    <li>AI-powered tagging with WD14</li>
                    <li>Auto-separate by filters</li>
                    <li>Manual keyboard sorting (WASD)</li>
                    <li>Canvas-based censor editing</li>
                </ul>`,
            target: null, // Center modal, no target element
            position: 'center'
        },
        {
            id: 'navigation-tabs',
            title: 'Navigation Tabs',
            content: `<p>Switch between different views:</p>
                <ul>
                    <li><strong>Gallery</strong> - Browse and filter your images</li>
                    <li><strong>Auto-Separate</strong> - Move images matching filters</li>
                    <li><strong>Manual Sort</strong> - WASD keyboard sorting</li>
                    <li><strong>Censored Edit</strong> - Canvas-based censoring</li>
                    <li><strong>Similar</strong> - Find similar images</li>
                    <li><strong>Prompt Lab</strong> - Analyze prompts</li>
                    <li><strong>Artist ID</strong> - Identify artist styles</li>
                </ul>`,
            target: '.nav-tabs',
            position: 'bottom'
        },
        {
            id: 'scan-folder',
            title: 'Scan Your Images',
            content: `<p>Click <strong>Scan Folder</strong> to load images from a directory.</p>
                <p>The app will:</p>
                <ul>
                    <li>Detect the generator (ComfyUI, NAI, WebUI, Forge)</li>
                    <li>Extract prompts, checkpoints, and LoRAs</li>
                    <li>Store metadata in a local database</li>
                </ul>`,
            target: '#btn-scan',
            position: 'bottom'
        },
        {
            id: 'tag-images',
            title: 'AI Tagging',
            content: `<p>Click <strong>Tag Images</strong> to run WD14 AI tagger on your images.</p>
                <p>Tags include:</p>
                <ul>
                    <li>General content tags</li>
                    <li>Character tags</li>
                    <li>Rating tags (general, sensitive, questionable, explicit)</li>
                </ul>
                <p>Use tags to filter and organize your collection.</p>`,
            target: '#btn-tag',
            position: 'bottom'
        },
        {
            id: 'filters',
            title: 'Filter Sidebar',
            content: `<p>Use the filter sidebar to narrow down your gallery:</p>
                <ul>
                    <li><strong>Generators</strong> - Filter by source</li>
                    <li><strong>Tags</strong> - Filter by AI tags</li>
                    <li><strong>Checkpoints</strong> - Filter by model</li>
                    <li><strong>LoRAs</strong> - Filter by LoRA used</li>
                    <li><strong>Prompts</strong> - Search prompt text</li>
                </ul>
                <p>Click <strong>Edit Filters</strong> for advanced options.</p>`,
            target: '.filter-sidebar',
            position: 'right'
        },
        {
            id: 'manual-sort',
            title: 'Manual Sort (WASD)',
            content: `<p>Use keyboard controls to quickly sort images:</p>
                <ul>
                    <li><strong>W</strong> - Move to top folder</li>
                    <li><strong>A</strong> - Move to left folder</li>
                    <li><strong>S</strong> - Move to bottom folder</li>
                    <li><strong>D</strong> - Move to right folder</li>
                    <li><strong>Space</strong> - Skip image</li>
                    <li><strong>Z</strong> - Undo last action</li>
                </ul>
                <p>Configure your folder destinations in the Manual Sort tab.</p>`,
            target: '[data-view="sorting"]',
            position: 'bottom'
        },
        {
            id: 'censor-edit',
            title: 'Censor Editor',
            content: `<p>The Censored Edit tab provides canvas-based editing tools:</p>
                <ul>
                    <li><strong>Brush/Pen</strong> - Draw censor masks</li>
                    <li><strong>Eraser</strong> - Remove mask areas</li>
                    <li><strong>Clone Stamp</strong> - Copy textures</li>
                    <li><strong>AI Detection</strong> - Auto-detect regions</li>
                </ul>
                <p>Process single images or batch censor multiple images.</p>`,
            target: '[data-view="censor"]',
            position: 'bottom'
        },
        {
            id: 'complete',
            title: 'You\'re All Set!',
            content: `<p>You're ready to start organizing your images!</p>
                <p>Tips:</p>
                <ul>
                    <li>Hover over images to see details</li>
                    <li>Use the Library button to browse all tags</li>
                    <li>Press <kbd>?</kbd> anytime to restart this tour</li>
                </ul>
                <p>Happy sorting!</p>`,
            target: null,
            position: 'center'
        }
    ];

    // State
    let currentStepIndex = 0;
    let isActive = false;
    let overlayEl = null;
    let tooltipEl = null;
    let progressEl = null;
    let originalOverflow = '';

    function cleanupResidualTourUi() {
        document.querySelectorAll('.onboarding-overlay, .onboarding-tooltip').forEach((node) => {
            node.remove();
        });
        document.body.style.overflow = '';
    }

    /**
     * Check if onboarding has been completed
     * @returns {boolean}
     */
    function isCompleted() {
        const completed = localStorage.getItem(STORAGE_KEY);
        if (completed) {
            try {
                const data = JSON.parse(completed);
                return data.version >= TOUR_VERSION && data.completed === true;
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    /**
     * Check if current version was dismissed
     * @returns {boolean}
     */
    function wasDismissed() {
        const dismissed = localStorage.getItem(DISMISSED_KEY);
        return dismissed && parseInt(dismissed, 10) >= TOUR_VERSION;
    }

    /**
     * Mark onboarding as completed
     */
    function markCompleted() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            version: TOUR_VERSION,
            completed: true,
            completedAt: new Date().toISOString()
        }));
    }

    /**
     * Mark current version as dismissed
     */
    function markDismissed() {
        localStorage.setItem(DISMISSED_KEY, TOUR_VERSION.toString());
    }

    /**
     * Reset onboarding state (for testing or manual restart)
     */
    function resetState() {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(DISMISSED_KEY);
    }

    /**
     * Create the overlay element
     * @returns {HTMLElement}
     */
    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'onboarding-overlay';
        overlay.innerHTML = `
            <div class="onboarding-highlight-container">
                <div class="onboarding-highlight"></div>
            </div>
        `;
        return overlay;
    }

    /**
     * Create the tooltip element
     * @returns {HTMLElement}
     */
    function createTooltip() {
        const tooltip = document.createElement('div');
        tooltip.className = 'onboarding-tooltip';
        tooltip.setAttribute('role', 'dialog');
        tooltip.setAttribute('aria-labelledby', 'onboarding-title');
        tooltip.innerHTML = `
            <div class="onboarding-header">
                <h3 id="onboarding-title" class="onboarding-title"></h3>
                <button class="onboarding-skip" aria-label="Skip tour">
                    <span>Skip</span>
                </button>
            </div>
            <div class="onboarding-content"></div>
            <div class="onboarding-footer">
                <div class="onboarding-progress"></div>
                <div class="onboarding-actions">
                    <button class="btn btn-ghost onboarding-back" disabled>
                        <span>Back</span>
                    </button>
                    <button class="btn btn-primary onboarding-next">
                        <span>Next</span>
                    </button>
                </div>
            </div>
        `;
        return tooltip;
    }

    /**
     * Update progress indicators
     */
    function updateProgress() {
        const progressContainer = tooltipEl.querySelector('.onboarding-progress');
        progressContainer.innerHTML = '';

        TOUR_STEPS.forEach((step, index) => {
            const dot = document.createElement('span');
            dot.className = 'onboarding-progress-dot';
            if (index < currentStepIndex) {
                dot.classList.add('completed');
            } else if (index === currentStepIndex) {
                dot.classList.add('active');
            }
            dot.setAttribute('aria-label', `Step ${index + 1}`);
            progressContainer.appendChild(dot);
        });
    }

    /**
     * Position the tooltip relative to the target element
     * @param {HTMLElement} targetEl - Target element to highlight
     * @param {string} position - Preferred position (top, bottom, left, right, center)
     */
    function positionTooltip(targetEl, position) {
        const highlight = overlayEl.querySelector('.onboarding-highlight');

        if (!targetEl || position === 'center') {
            // Center mode - hide highlight, center tooltip
            highlight.style.display = 'none';
            tooltipEl.classList.add('onboarding-center');
            tooltipEl.style.top = '50%';
            tooltipEl.style.left = '50%';
            tooltipEl.style.transform = 'translate(-50%, -50%)';
            return;
        }

        highlight.style.display = 'block';
        tooltipEl.classList.remove('onboarding-center');

        // Get target position
        const targetRect = targetEl.getBoundingClientRect();
        const tooltipRect = tooltipEl.getBoundingClientRect();

        // Position highlight around target
        const padding = 8;
        highlight.style.top = `${targetRect.top - padding}px`;
        highlight.style.left = `${targetRect.left - padding}px`;
        highlight.style.width = `${targetRect.width + padding * 2}px`;
        highlight.style.height = `${targetRect.height + padding * 2}px`;

        // Position tooltip
        const gap = 16;
        let top, left;

        switch (position) {
            case 'top':
                top = targetRect.top - tooltipRect.height - gap;
                left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
                break;
            case 'bottom':
                top = targetRect.bottom + gap;
                left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
                break;
            case 'left':
                top = targetRect.top + (targetRect.height - tooltipRect.height) / 2;
                left = targetRect.left - tooltipRect.width - gap;
                break;
            case 'right':
                top = targetRect.top + (targetRect.height - tooltipRect.height) / 2;
                left = targetRect.right + gap;
                break;
            default:
                top = targetRect.bottom + gap;
                left = targetRect.left;
        }

        // Keep tooltip within viewport
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (left < 20) left = 20;
        if (left + tooltipRect.width > viewportWidth - 20) {
            left = viewportWidth - tooltipRect.width - 20;
        }
        if (top < 80) top = 80; // Below nav bar
        if (top + tooltipRect.height > viewportHeight - 20) {
            top = viewportHeight - tooltipRect.height - 20;
        }

        tooltipEl.style.top = `${top}px`;
        tooltipEl.style.left = `${left}px`;
        tooltipEl.style.transform = 'none';

        // Scroll target into view if needed
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /**
     * Show a specific step
     * @param {number} index - Step index
     */
    function showStep(index) {
        if (index < 0 || index >= TOUR_STEPS.length) return;

        currentStepIndex = index;
        const step = TOUR_STEPS[index];

        // Update tooltip content
        const titleEl = tooltipEl.querySelector('.onboarding-title');
        const contentEl = tooltipEl.querySelector('.onboarding-content');

        titleEl.textContent = step.title;
        contentEl.innerHTML = step.content;

        // Update buttons
        const backBtn = tooltipEl.querySelector('.onboarding-back');
        const nextBtn = tooltipEl.querySelector('.onboarding-next');

        backBtn.disabled = index === 0;
        nextBtn.querySelector('span').textContent = index === TOUR_STEPS.length - 1 ? 'Finish' : 'Next';

        // Update progress
        updateProgress();

        // Find target element and position
        let targetEl = null;
        if (step.target) {
            targetEl = document.querySelector(step.target);
        }

        // Small delay to allow DOM updates
        requestAnimationFrame(() => {
            positionTooltip(targetEl, step.position);
        });
    }

    /**
     * Go to next step
     */
    function nextStep() {
        if (currentStepIndex < TOUR_STEPS.length - 1) {
            showStep(currentStepIndex + 1);
        } else {
            complete();
        }
    }

    /**
     * Go to previous step
     */
    function prevStep() {
        if (currentStepIndex > 0) {
            showStep(currentStepIndex - 1);
        }
    }

    /**
     * Start the tour
     */
    function start() {
        if (isActive) return;

        isActive = true;
        currentStepIndex = 0;

        // Prevent body scroll
        originalOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        // Create and append elements
        overlayEl = createOverlay();
        tooltipEl = createTooltip();

        document.body.appendChild(overlayEl);
        document.body.appendChild(tooltipEl);

        // Add event listeners
        const skipBtn = tooltipEl.querySelector('.onboarding-skip');
        const backBtn = tooltipEl.querySelector('.onboarding-back');
        const nextBtn = tooltipEl.querySelector('.onboarding-next');

        skipBtn.addEventListener('click', skip);
        backBtn.addEventListener('click', prevStep);
        nextBtn.addEventListener('click', nextStep);

        // Allow clicking the overlay backdrop to dismiss the tour
        overlayEl.addEventListener('click', (e) => {
            if (e.target === overlayEl) skip();
        });

        // Keyboard navigation
        document.addEventListener('keydown', handleKeydown);

        // Show first step
        showStep(0);

        // Announce to screen readers
        tooltipEl.setAttribute('aria-live', 'polite');
    }

    /**
     * Handle keyboard navigation
     * @param {KeyboardEvent} e
     */
    function handleKeydown(e) {
        if (!isActive) return;

        switch (e.key) {
            case 'ArrowRight':
            case 'Enter':
                e.preventDefault();
                nextStep();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                prevStep();
                break;
            case 'Escape':
                e.preventDefault();
                skip();
                break;
        }
    }

    /**
     * Skip the tour
     */
    function skip() {
        markDismissed();
        end();
    }

    /**
     * Complete the tour
     */
    function complete() {
        markCompleted();
        end();
    }

    /**
     * End the tour (cleanup)
     */
    function end() {
        isActive = false;

        // Remove event listeners
        document.removeEventListener('keydown', handleKeydown);

        // Remove elements with animation
        if (overlayEl) {
            overlayEl.classList.add('onboarding-fade-out');
            setTimeout(() => {
                if (overlayEl && overlayEl.parentNode) {
                    overlayEl.parentNode.removeChild(overlayEl);
                }
            }, 300);
        }

        if (tooltipEl) {
            tooltipEl.classList.add('onboarding-fade-out');
            setTimeout(() => {
                if (tooltipEl && tooltipEl.parentNode) {
                    tooltipEl.parentNode.removeChild(tooltipEl);
                }
            }, 300);
        }

        overlayEl = null;
        tooltipEl = null;

        // Restore body scroll
        document.body.style.overflow = originalOverflow;
    }

    /**
     * Initialize - auto-start tour for first-time users.
     * Tour is also available via OnboardingTour.start() programmatically.
     */
    function init() {
        cleanupResidualTourUi();

        // Auto-start only on true first-run: user has never loaded images
        // and hasn't completed or dismissed the tour before.
        if (AUTO_START_ENABLED && !isCompleted() && !wasDismissed()) {
            const hasSeen = localStorage.getItem(FIRST_RUN_CHECK_KEY);
            if (!hasSeen) {
                setTimeout(() => start(), 800);
            }
        }
    }

    /** Mark that the user has loaded images at least once (called by app after gallery loads). */
    function markHasSeenImages() {
        localStorage.setItem(FIRST_RUN_CHECK_KEY, '1');
    }

    // Public API
    return {
        init,
        start,
        skip,
        complete,
        resetState,
        isCompleted,
        wasDismissed,
        markHasSeenImages
    };
})();

// Export to window for backward compatibility
window.OnboardingTour = OnboardingTour;

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', OnboardingTour.init);
} else {
    OnboardingTour.init();
}
