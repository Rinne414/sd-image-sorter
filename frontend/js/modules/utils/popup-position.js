/**
 * Viewport-safe positioning for fixed popups under the app's root UI zoom.
 */
(function () {
    'use strict';

    function getScale() {
        return Math.max(
            0.1,
            Number(window.UiScale?.get?.())
                || parseFloat(document.documentElement.style.zoom)
                || 1
        );
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), Math.max(min, max));
    }

    function toCssPx(value) {
        return value / getScale();
    }

    function setFixedRect(element, rect) {
        if (!element || !rect) return;
        element.style.top = `${Math.round(toCssPx(rect.top))}px`;
        element.style.left = `${Math.round(toCssPx(rect.left))}px`;
        if (Number.isFinite(rect.width)) {
            element.style.width = `${Math.max(0, toCssPx(rect.width))}px`;
        }
        if (Number.isFinite(rect.height)) {
            element.style.height = `${Math.max(0, toCssPx(rect.height))}px`;
        }
    }

    function place(element, options = {}) {
        if (!element) return null;

        const margin = Number.isFinite(options.margin) ? options.margin : 8;
        const gap = Number.isFinite(options.gap) ? options.gap : 6;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const availableWidth = Math.max(1, viewportWidth - margin * 2);
        const availableHeight = Math.max(1, viewportHeight - margin * 2);
        const maxWidth = Math.min(
            Number.isFinite(options.maxWidth) ? options.maxWidth : availableWidth,
            availableWidth
        );
        const maxHeight = Math.min(
            Number.isFinite(options.maxHeight) ? options.maxHeight : availableHeight,
            availableHeight
        );
        const anchorRect = options.anchor?.getBoundingClientRect?.() || null;
        const placement = options.placement || (anchorRect ? 'bottom-start' : 'point');

        element.style.right = 'auto';
        element.style.bottom = 'auto';
        element.style.maxWidth = `${toCssPx(maxWidth)}px`;
        element.style.maxHeight = `${toCssPx(maxHeight)}px`;
        if (Number.isFinite(options.width)) {
            element.style.width = `${toCssPx(Math.min(options.width, availableWidth))}px`;
        } else if (options.matchWidth && anchorRect) {
            element.style.width = `${toCssPx(Math.min(anchorRect.width, availableWidth))}px`;
        }
        element.style.left = '0px';
        element.style.top = '0px';

        const measured = element.getBoundingClientRect();
        const width = Math.min(measured.width || 0, maxWidth);
        const height = Math.min(measured.height || 0, maxHeight);
        const offsetX = Number(options.offsetX) || 0;
        const offsetY = Number(options.offsetY) || 0;
        let left;
        let top;

        if (anchorRect) {
            if (placement.endsWith('-end')) left = anchorRect.right - width;
            else if (placement.startsWith('left')) left = anchorRect.left - width - gap;
            else if (placement.startsWith('right')) left = anchorRect.right + gap;
            else left = anchorRect.left;

            if (placement.startsWith('top')) top = anchorRect.top - height - gap;
            else if (placement.startsWith('left') || placement.startsWith('right')) {
                top = anchorRect.top + (anchorRect.height - height) / 2;
            } else top = anchorRect.bottom + gap;

            if (placement.startsWith('bottom') && top + height + margin > viewportHeight) {
                top = anchorRect.top - height - gap;
            } else if (placement.startsWith('top') && top < margin) {
                top = anchorRect.bottom + gap;
            } else if (placement.startsWith('right') && left + width + margin > viewportWidth) {
                left = anchorRect.left - width - gap;
            } else if (placement.startsWith('left') && left < margin) {
                left = anchorRect.right + gap;
            }
        } else {
            const x = Number.isFinite(options.x) ? options.x : viewportWidth / 2;
            const y = Number.isFinite(options.y) ? options.y : viewportHeight / 3;
            left = x;
            top = y;
            if (left + width + margin > viewportWidth) left = x - width;
            if (top + height + margin > viewportHeight) top = y - height;
        }

        left = clamp(left + offsetX, margin, viewportWidth - width - margin);
        top = clamp(top + offsetY, margin, viewportHeight - height - margin);
        element.style.left = `${Math.round(toCssPx(left))}px`;
        element.style.top = `${Math.round(toCssPx(top))}px`;

        return { left, top, width, height };
    }

    window.PopupPosition = Object.freeze({ getScale, place, setFixedRect, toCssPx });
})();
