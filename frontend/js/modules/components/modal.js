/**
 * @fileoverview Modal management with focus trap
 * @module components/modal
 */

// Use global DOM functions (loaded from dom.js)
// Assumes window.$ and window.$$ are available

/**
 * @typedef {Object} ModalOptions
 * @property {boolean} [closeOnBackdrop=true] - Close when clicking backdrop
 * @property {boolean} [closeOnEscape=true] - Close on Escape key
 * @property {Function} [onOpen] - Callback when modal opens
 * @property {Function} [onClose] - Callback when modal closes
 */

/** @type {Element|null} Last focused element before modal opened */
let _lastFocusedElement = null;

/** @type {Function|null} Current focus trap handler */
let _focusTrapHandler = null;

/** @type {AbortController|null} AbortController for modal listeners */
let _modalAbortController = null;

/** @type {Map<string, ModalOptions>} Modal options registry */
const modalRegistry = new Map();

/**
 * Trap focus within modal for accessibility
 * @param {Element} modal - Modal element
 */
function trapFocus(modal) {
    const focusableElements = modal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    // Remove existing trap if any
    if (_focusTrapHandler) {
        document.removeEventListener('keydown', _focusTrapHandler);
    }

    _focusTrapHandler = (e) => {
        if (e.key !== 'Tab') return;

        if (e.shiftKey) {
            if (document.activeElement === firstFocusable) {
                e.preventDefault();
                lastFocusable.focus();
            }
        } else {
            if (document.activeElement === lastFocusable) {
                e.preventDefault();
                firstFocusable.focus();
            }
        }
    };

    document.addEventListener('keydown', _focusTrapHandler);
}

/**
 * Release focus trap and restore focus
 */
function releaseFocus() {
    if (_focusTrapHandler) {
        document.removeEventListener('keydown', _focusTrapHandler);
        _focusTrapHandler = null;
    }
    if (_lastFocusedElement && typeof _lastFocusedElement.focus === 'function') {
        _lastFocusedElement.focus();
    }
    _lastFocusedElement = null;
}

/**
 * Show modal by ID
 * @param {string} modalId - Modal element ID
 * @param {ModalOptions} [options={}] - Modal options
 */
function showModal(modalId, options = {}) {
    const modal = window.$ ? window.$(`#${modalId}`) : document.getElementById(modalId);
    if (!modal) return;

    // Store the element that had focus before opening modal
    _lastFocusedElement = document.activeElement;

    // Register options
    modalRegistry.set(modalId, {
        closeOnBackdrop: true,
        closeOnEscape: true,
        ...options
    });

    // Show modal
    modal.classList.add('visible');

    // Set up focus trap
    trapFocus(modal);

    // Focus the first focusable element or the close button
    const closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) {
        setTimeout(() => closeBtn.focus(), 100);
    }

    // Set up escape key listener
    setupEscapeListener(modalId);

    // Call onOpen callback
    if (options.onOpen) {
        options.onOpen(modal);
    }

    // Set up backdrop click listener
    setupBackdropListener(modal, modalId);
}

/**
 * Set up escape key listener for modal
 * @param {string} modalId - Modal ID
 */
function setupEscapeListener(modalId) {
    if (_modalAbortController) {
        _modalAbortController.abort();
    }
    _modalAbortController = new AbortController();
    const signal = _modalAbortController.signal;

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const options = modalRegistry.get(modalId);
            if (options?.closeOnEscape !== false) {
                hideModal(modalId);
            }
        }
    }, { signal });
}

/**
 * Set up backdrop click listener
 * @param {Element} modal - Modal element
 * @param {string} modalId - Modal ID
 */
function setupBackdropListener(modal, modalId) {
    const backdrop = modal.querySelector('.modal-backdrop');
    if (backdrop) {
        const options = modalRegistry.get(modalId);
        if (options?.closeOnBackdrop !== false) {
            backdrop.onclick = () => hideModal(modalId);
        }
    }
}

/**
 * Hide modal by ID
 * @param {string} modalId - Modal element ID
 */
function hideModal(modalId) {
    const modal = window.$ ? window.$(`#${modalId}`) : document.getElementById(modalId);
    if (!modal) return;

    modal.classList.remove('visible');

    // Get options and call onClose callback
    const options = modalRegistry.get(modalId);
    if (options?.onClose) {
        options.onClose(modal);
    }

    // Release focus trap and restore focus
    releaseFocus();

    // Abort escape listener
    if (_modalAbortController) {
        _modalAbortController.abort();
        _modalAbortController = null;
    }
}

/**
 * Toggle modal visibility
 * @param {string} modalId - Modal element ID
 * @param {ModalOptions} [options={}] - Modal options
 * @returns {boolean} Whether modal is now visible
 */
function toggleModal(modalId, options = {}) {
    const modal = window.$ ? window.$(`#${modalId}`) : document.getElementById(modalId);
    if (!modal) return false;

    const isVisible = modal.classList.contains('visible');
    if (isVisible) {
        hideModal(modalId);
        return false;
    } else {
        showModal(modalId, options);
        return true;
    }
}

/**
 * Check if modal is visible
 * @param {string} modalId - Modal element ID
 * @returns {boolean} Whether modal is visible
 */
function isModalVisible(modalId) {
    const modal = window.$ ? window.$(`#${modalId}`) : document.getElementById(modalId);
    return modal?.classList.contains('visible') ?? false;
}

/**
 * Hide all visible modals
 */
function hideAllModals() {
    const modals = window.$$ ? window.$$('.modal.visible') : document.querySelectorAll('.modal.visible');
    modals.forEach(modal => {
        modal.classList.remove('visible');
    });
    releaseFocus();

    if (_modalAbortController) {
        _modalAbortController.abort();
        _modalAbortController = null;
    }
}

/**
 * Initialize input modal handlers
 * Creates a promise-based input modal
 */
let inputModalResolve = null;

function initInputModal() {
    const $ = window.$ || ((sel) => document.querySelector(sel));
    const inputField = $('#input-modal-field');
    const okBtn = $('#btn-input-ok');
    const cancelBtn = $('#btn-input-cancel');
    const backdrop = $('#input-modal .modal-backdrop');

    if (!inputField || !okBtn) return;

    const handleOk = () => {
        const value = inputField?.value || '';
        hideModal('input-modal');
        if (inputModalResolve) {
            inputModalResolve(value);
            inputModalResolve = null;
        }
    };

    const handleCancel = () => {
        hideModal('input-modal');
        if (inputModalResolve) {
            inputModalResolve(null);
            inputModalResolve = null;
        }
    };

    okBtn.addEventListener('click', handleOk);
    if (cancelBtn) cancelBtn.addEventListener('click', handleCancel);
    if (backdrop) backdrop.addEventListener('click', handleCancel);

    // Handle Enter key in input field
    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleOk();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancel();
        }
    });
}

/**
 * Show input modal and get user input
 * @param {string} title - Modal title
 * @param {string} message - Modal message
 * @param {string} [defaultValue=''] - Default input value
 * @returns {Promise<string|null>} User input or null if cancelled
 */
function showInputModal(title, message, defaultValue = '') {
    const $ = window.$ || ((sel) => document.querySelector(sel));
    return new Promise((resolve) => {
        // Resolve previous if still pending
        if (inputModalResolve) {
            inputModalResolve(null);
        }
        inputModalResolve = resolve;

        // Set modal content
        const titleEl = $('#input-modal-title');
        const messageEl = $('#input-modal-message');
        const inputEl = $('#input-modal-field');

        if (titleEl) titleEl.textContent = title || 'Enter Value';
        if (messageEl) messageEl.textContent = message || '';
        if (inputEl) {
            inputEl.value = defaultValue;
            inputEl.placeholder = '';
        }

        // Show modal
        showModal('input-modal');

        // Focus input after modal is visible
        setTimeout(() => {
            inputEl?.focus();
            inputEl?.select();
        }, 100);
    });
}

/**
 * Show confirmation modal
 * @param {string} title - Modal title
 * @param {string} message - Modal message
 * @param {Function} [onOk] - Callback on confirm
 * @param {Function} [onCancel] - Callback on cancel
 */
let _confirmAbort = null;

function showConfirm(title, message, onOk, onCancel) {
    const $ = window.$ || ((sel) => document.querySelector(sel));
    const titleEl = $('#confirm-title');
    const messageEl = $('#confirm-message');
    const okBtn = $('#btn-confirm-ok');
    const cancelBtn = $('#btn-confirm-cancel');

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;

    // Abort previous confirm listeners
    if (_confirmAbort) _confirmAbort.abort();
    _confirmAbort = new AbortController();
    const signal = _confirmAbort.signal;

    if (okBtn) {
        okBtn.addEventListener('click', () => {
            hideModal('confirm-modal');
            if (onOk) onOk();
        }, { signal });
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            hideModal('confirm-modal');
            if (onCancel) onCancel();
        }, { signal });
    }

    showModal('confirm-modal');
}

const modal = {
    show: showModal,
    hide: hideModal,
    toggle: toggleModal,
    isVisible: isModalVisible,
    hideAll: hideAllModals,
    showInput: showInputModal,
    showConfirm,
    initInputModal,
    trapFocus,
    releaseFocus
};

// Export to global namespace for backward compatibility with non-module scripts
if (typeof window !== 'undefined') {
    window.showModal = showModal;
    window.hideModal = hideModal;
    window.toggleModal = toggleModal;
    window.isModalVisible = isModalVisible;
    window.hideAllModals = hideAllModals;
    window.showInputModal = showInputModal;
    window.showConfirm = showConfirm;
    window.initInputModal = initInputModal;
    window.modal = modal;
}
