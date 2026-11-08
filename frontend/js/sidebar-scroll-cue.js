/**
 * sidebar-scroll-cue.js - the gallery sidebar says when more is below.
 *
 * The browse area scrolls above a footer that grows in selection mode; at
 * laptop heights its last rows were cut mid-row with nothing saying the list
 * goes on (UI audit 2026-11-08). This marks the scroller `has-more-below`
 * while it can scroll further down; the CSS fades its bottom edge then.
 */
(function () {
    'use strict';

    function bind() {
        const scroller = document.querySelector('.filter-sidebar-scroll');
        if (!scroller || scroller.dataset.scrollCue === '1') return;
        scroller.dataset.scrollCue = '1';
        const update = () => {
            const more = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2;
            scroller.classList.toggle('has-more-below', more);
        };
        scroller.addEventListener('scroll', update, { passive: true });
        new ResizeObserver(update).observe(scroller);
        // Rows come and go (collections, folders, folded sections) without a resize of the scroller.
        new MutationObserver(update).observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
        update();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
