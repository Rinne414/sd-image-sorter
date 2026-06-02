/**
 * SD Image Sorter - Accessibility Utilities
 * Shared functions for screen reader announcements and focus management
 */

/**
 * Announce a message to screen readers using ARIA live region.
 * Creates or reuses a live region element for the announcement.
 *
 * @param {string} message - The message to announce
 * @param {string} priority - 'polite' (default) or 'assertive' for urgent messages
 */
function announce(message, priority = 'polite') {
    if (!message) return;

    let liveRegion = document.getElementById('a11y-live-region');

    // Create live region if it doesn't exist
    if (!liveRegion) {
        liveRegion = document.createElement('div');
        liveRegion.id = 'a11y-live-region';
        liveRegion.setAttribute('aria-live', priority);
        liveRegion.setAttribute('aria-atomic', 'true');
        liveRegion.className = 'sr-only';
        liveRegion.style.cssText = `
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border: 0;
        `;
        document.body.appendChild(liveRegion);
    } else {
        // Update priority if needed
        liveRegion.setAttribute('aria-live', priority);
    }

    // Clear and set message to trigger announcement
    liveRegion.textContent = '';
    // Small delay to ensure the announcement is triggered
    setTimeout(() => {
        liveRegion.textContent = message;
    }, 50);
}

/**
 * Get all focusable elements within a container.
 * Returns elements that can receive keyboard focus.
 *
 * @param {HTMLElement} element - The container element to search within
 * @returns {NodeList} List of focusable elements
 */
function getFocusableElements(element) {
    if (!element) return [];

    const selector = [
        'button:not([disabled])',
        '[href]',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
        '[contenteditable="true"]'
    ].join(', ');

    return element.querySelectorAll(selector);
}

/**
 * Trap focus within an element (typically a modal).
 * Prevents focus from leaving the element via Tab key.
 *
 * @param {HTMLElement} element - The element to trap focus within
 * @returns {Function} Cleanup function to remove the focus trap
 */
function trapFocus(element) {
    if (!element) return () => {};

    const focusableElements = getFocusableElements(element);
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    function handleKeyDown(e) {
        if (e.key !== 'Tab') return;

        const focusableNow = getFocusableElements(element);
        const first = focusableNow[0];
        const last = focusableNow[focusableNow.length - 1];

        if (e.shiftKey) {
            // Shift+Tab - focus previous element
            if (document.activeElement === first || document.activeElement === element) {
                e.preventDefault();
                last?.focus();
            }
        } else {
            // Tab - focus next element
            if (document.activeElement === last) {
                e.preventDefault();
                first?.focus();
            }
        }
    }

    element.addEventListener('keydown', handleKeyDown);

    // Focus first focusable element
    if (firstFocusable) {
        setTimeout(() => firstFocusable.focus(), 50);
    }

    // Return cleanup function
    return () => {
        element.removeEventListener('keydown', handleKeyDown);
    };
}

/**
 * Create or get the ARIA live region for toast notifications.
 * Ensures toasts are announced to screen readers.
 *
 * @returns {HTMLElement} The live region element
 */
function getOrCreateToastLiveRegion() {
    let region = document.getElementById('toast-live-region');

    if (!region) {
        region = document.createElement('div');
        region.id = 'toast-live-region';
        region.setAttribute('aria-live', 'polite');
        region.setAttribute('aria-atomic', 'true');
        region.className = 'sr-only';
        region.style.cssText = `
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border: 0;
        `;
        document.body.appendChild(region);
    }

    return region;
}

/**
 * Handle keyboard navigation for a grid of items.
 * Enables arrow key navigation within a grid container.
 *
 * @param {KeyboardEvent} event - The keyboard event
 * @param {HTMLElement} container - The grid container
 * @param {string} itemSelector - CSS selector for grid items
 * @param {Object} options - Additional options
 * @param {number} options.columns - Number of columns in the grid (for arrow key navigation)
 * @param {Function} options.onSelect - Callback when Enter is pressed on an item
 */
function handleGridKeyboardNavigation(event, container, itemSelector, options = {}) {
    const { columns = 4, onSelect, onNavigate, wrap = true } = options;
    const items = Array.from(container.querySelectorAll(itemSelector));
    if (items.length === 0) return;

    const currentIndex = items.findIndex(item => item === document.activeElement || item.contains(document.activeElement));

    let nextIndex = -1;

    switch (event.key) {
        case 'ArrowRight':
            event.preventDefault();
            nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : (wrap ? 0 : currentIndex);
            break;
        case 'ArrowLeft':
            event.preventDefault();
            nextIndex = currentIndex > 0 ? currentIndex - 1 : (wrap ? items.length - 1 : currentIndex);
            break;
        case 'ArrowDown':
            event.preventDefault();
            nextIndex = currentIndex + columns < items.length ? currentIndex + columns : currentIndex;
            break;
        case 'ArrowUp':
            event.preventDefault();
            nextIndex = currentIndex - columns >= 0 ? currentIndex - columns : currentIndex;
            break;
        case 'Enter':
        case ' ':
            if (onSelect && currentIndex >= 0) {
                event.preventDefault();
                onSelect(items[currentIndex], currentIndex);
            }
            return;
        case 'Home':
            event.preventDefault();
            nextIndex = 0;
            break;
        case 'End':
            event.preventDefault();
            nextIndex = items.length - 1;
            break;
        default:
            return;
    }

    if (nextIndex >= 0 && items[nextIndex]) {
        items[nextIndex].focus();
        if (typeof onNavigate === 'function') {
            onNavigate(items[nextIndex], nextIndex);
        }
    }
}

// Export for ES modules (future use)
// export { announce, getFocusableElements, trapFocus, getOrCreateToastLiveRegion, handleGridKeyboardNavigation };

// Export to global namespace for current use (backward compatibility)
window.A11y = {
    announce,
    getFocusableElements,
    trapFocus,
    getOrCreateToastLiveRegion,
    handleGridKeyboardNavigation
};
