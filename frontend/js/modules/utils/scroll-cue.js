/**
 * "More below" cue for fixed-height side panels.
 *
 * At laptop heights (1366x768) several panels end in the middle of a row, with
 * nothing saying the rest is one scroll away: the censor sidebar under its
 * pinned save card, the artist settings under the pinned run buttons, and the
 * Auto-Separate panes. Each panel listed here carries data-more-below while
 * content sits past its bottom edge; ui-refresh.css draws the fade from it.
 */
(function () {
    'use strict';

    var PANEL_SELECTOR = [
        '#view-censor .censor-sidebar-v2.right',
        '#view-artist .artist-controls',
        '#view-sorting .autosep-pane-body',
    ].join(', ');

    // Fractional layout leaves scrollHeight a pixel or two past a fully
    // scrolled panel; that is the end, not "more below".
    var END_TOLERANCE_PX = 2;

    function sync(panel) {
        var hasMore = panel.scrollTop + panel.clientHeight < panel.scrollHeight - END_TOLERANCE_PX;
        panel.toggleAttribute('data-more-below', hasMore);
    }

    // A panel's content height changes without the panel resizing (a section
    // opens, a list fills), so its children are watched as well as the panel.
    var resizeObserver = new ResizeObserver(function (entries) {
        entries.forEach(function (entry) {
            var panel = entry.target.matches(PANEL_SELECTOR)
                ? entry.target
                : entry.target.parentElement;
            if (panel) sync(panel);
        });
    });

    function bind() {
        document.querySelectorAll(PANEL_SELECTOR).forEach(function (panel) {
            if (panel.dataset.scrollCueBound === '1') return;
            panel.dataset.scrollCueBound = '1';
            panel.addEventListener('scroll', function () { sync(panel); }, { passive: true });
            resizeObserver.observe(panel);
            Array.prototype.forEach.call(panel.children, function (child) {
                resizeObserver.observe(child);
            });
            sync(panel);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
