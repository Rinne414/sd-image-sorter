/**
 * @fileoverview DOM utilities for element selection and manipulation
 * @module utils/dom
 */

/**
 * Query selector shorthand - select single element
 * @param {string} selector - CSS selector
 * @param {Element|Document} [context=document] - Context element
 * @returns {Element|null} Found element or null
 */
function $(selector, context = document) {
    return context.querySelector(selector);
}

/**
 * Query selector all shorthand - select multiple elements
 * @param {string} selector - CSS selector
 * @param {Element|Document} [context=document] - Context element
 * @returns {NodeListOf<Element>} NodeList of found elements
 */
function $$(selector, context = document) {
    return context.querySelectorAll(selector);
}

/**
 * Create element with attributes and children
 * @param {string} tag - Element tag name
 * @param {Object} [attributes={}] - Element attributes
 * @param {(string|Element)[]} [children=[]] - Child elements or text
 * @returns {Element} Created element
 */
function createElement(tag, attributes = {}, children = []) {
    const element = document.createElement(tag);

    Object.entries(attributes).forEach(([key, value]) => {
        if (key === 'class' || key === 'className') {
            element.className = value;
        } else if (key === 'style' && typeof value === 'object') {
            Object.assign(element.style, value);
        } else if (key.startsWith('on') && typeof value === 'function') {
            const eventName = key.slice(2).toLowerCase();
            element.addEventListener(eventName, value);
        } else if (key === 'dataset' && typeof value === 'object') {
            Object.entries(value).forEach(([dataKey, dataValue]) => {
                element.dataset[dataKey] = dataValue;
            });
        } else {
            element.setAttribute(key, value);
        }
    });

    children.forEach(child => {
        if (typeof child === 'string') {
            element.appendChild(document.createTextNode(child));
        } else if (child instanceof Element) {
            element.appendChild(child);
        }
    });

    return element;
}

/**
 * Remove all children from an element
 * @param {Element} element - Element to clear
 */
function clearElement(element) {
    while (element.firstChild) {
        element.removeChild(element.firstChild);
    }
}

/**
 * Show element (remove hidden class or set display)
 * @param {Element} element - Element to show
 * @param {string} [display=''] - Display value (default uses element's default)
 */
function showElement(element, display = '') {
    element.style.display = display;
}

/**
 * Hide element
 * @param {Element} element - Element to hide
 */
function hideElement(element) {
    element.style.display = 'none';
}

/**
 * Toggle element visibility
 * @param {Element} element - Element to toggle
 * @param {boolean} [force] - Force show (true) or hide (false)
 * @returns {boolean} New visibility state
 */
function toggleElement(element, force) {
    const isHidden = element.style.display === 'none';
    const shouldShow = force !== undefined ? force : isHidden;

    element.style.display = shouldShow ? '' : 'none';
    return shouldShow;
}

/**
 * Add class(es) to element
 * @param {Element} element - Target element
 * @param {...string} classNames - Class names to add
 */
function addClass(element, ...classNames) {
    element.classList.add(...classNames);
}

/**
 * Remove class(es) from element
 * @param {Element} element - Target element
 * @param {...string} classNames - Class names to remove
 */
function removeClass(element, ...classNames) {
    element.classList.remove(...classNames);
}

/**
 * Toggle class on element
 * @param {Element} element - Target element
 * @param {string} className - Class name to toggle
 * @param {boolean} [force] - Force add (true) or remove (false)
 * @returns {boolean} Whether the class is now present
 */
function toggleClass(element, className, force) {
    return element.classList.toggle(className, force);
}

/**
 * Check if element has class
 * @param {Element} element - Target element
 * @param {string} className - Class name to check
 * @returns {boolean} Whether element has the class
 */
function hasClass(element, className) {
    return element.classList.contains(className);
}

/**
 * Set or get element's text content
 * @param {Element} element - Target element
 * @param {string} [text] - Text to set (if omitted, returns current text)
 * @returns {string|void} Current text if getting, undefined if setting
 */
function text(element, textContent) {
    if (textContent === undefined) {
        return element.textContent;
    }
    element.textContent = textContent;
}

/**
 * Set or get element's HTML content
 * @param {Element} element - Target element
 * @param {string} [html] - HTML to set (if omitted, returns current HTML)
 * @returns {string|void} Current HTML if getting, undefined if setting
 */
function html(element, htmlContent) {
    if (htmlContent === undefined) {
        return element.innerHTML;
    }
    element.innerHTML = htmlContent;
}

/**
 * Set multiple attributes on element
 * @param {Element} element - Target element
 * @param {Object} attributes - Attributes to set
 */
function setAttributes(element, attributes) {
    Object.entries(attributes).forEach(([key, value]) => {
        if (value === null || value === undefined) {
            element.removeAttribute(key);
        } else {
            element.setAttribute(key, String(value));
        }
    });
}

/**
 * Get element's data attributes as object
 * @param {Element} element - Target element
 * @returns {Object<string, string>} Dataset object
 */
function getData(element) {
    return { ...element.dataset };
}

/**
 * Find parent element matching selector
 * @param {Element} element - Starting element
 * @param {string} selector - CSS selector to match
 * @returns {Element|null} Matching parent or null
 */
function closest(element, selector) {
    return element.closest(selector);
}

/**
 * Check if element is visible in viewport
 * @param {Element} element - Element to check
 * @returns {boolean} Whether element is visible
 */
function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
}

/**
 * Scroll element into view smoothly
 * @param {Element} element - Element to scroll to
 * @param {Object} [options={}] - Scroll options
 */
function scrollIntoView(element, options = {}) {
    element.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        ...options
    });
}

// Export to global namespace for backward compatibility with non-module scripts
if (typeof window !== 'undefined') {
    window.$ = $;
    window.$$ = $$;
    window.createElement = createElement;
    window.clearElement = clearElement;
    window.showElement = showElement;
    window.hideElement = hideElement;
    window.toggleElement = toggleElement;
    window.addClass = addClass;
    window.removeClass = removeClass;
    window.toggleClass = toggleClass;
    window.hasClass = hasClass;
    window.domText = text;
    window.html = html;
    window.setAttributes = setAttributes;
    window.getData = getData;
    window.closest = closest;
    window.isInViewport = isInViewport;
    window.scrollIntoView = scrollIntoView;
    window.dom = {
        $,
        $$,
        createElement,
        clearElement,
        showElement,
        hideElement,
        toggleElement,
        addClass,
        removeClass,
        toggleClass,
        hasClass,
        text,
        html,
        setAttributes,
        getData,
        closest,
        isInViewport,
        scrollIntoView
    };
}
