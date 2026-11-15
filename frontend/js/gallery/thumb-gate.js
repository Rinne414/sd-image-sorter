/**
 * gallery/thumb-gate.js - thumbnails wait while the gallery is flung.
 *
 * A fast flick through a large library renders hundreds of cards for a moment
 * each, and every one asked the server for its thumbnail: 286 to 758 requests
 * in a 3 s flick at 100,000 pictures, none cancelled. The tiles left on screen
 * when the flick stopped then waited behind all of them, a few seconds of blank
 * tiles with real pictures (36 ms per thumbnail, measured 2026-11-08). Cards
 * rendered while the gallery moves faster than anyone can look get their
 * picture once it settles; scrolling at a reading pace loads as before.
 *
 * Classic script with no dependencies: window.GalleryThumbGate.create(options)
 * returns { noteScroll, shouldDefer, defer, flush, dispose }.
 */
(function () {
    'use strict';

    // Faster than this is a flick, not reading: about two screens a second.
    const FAST_PX_PER_MS = 2.5;
    // The gallery counts as settled after this long without a scroll event.
    const SETTLE_MS = 120;
    // Longer than any busy frame: a gap this long is a pause even if the
    // settle timer has not run yet.
    const BUSY_FRAME_MAX_MS = 1000;
    // A flick stays a flick until it has moved slowly for this long: smooth
    // scrolling eases every wheel step in and out, and those slow frames in the
    // middle of a flick must not let cards through.
    const SLOW_HOLD_MS = 150;

    /**
     * @param {{
     *   getScrollTop: () => number,
     *   load: (item: HTMLElement) => void,
     *   now?: () => number,
     *   setTimer?: (fn: () => void, ms: number) => unknown,
     *   clearTimer?: (id: unknown) => void,
     *   onFlush?: (reason: string, count: number) => void,
     *   requestFrame?: (fn: () => void) => unknown,
     * }} options
     */
    function create(options) {
        const getScrollTop = options.getScrollTop;
        const load = options.load;
        const now = options.now || (() => performance.now());
        const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
        const clearTimer = options.clearTimer || ((id) => clearTimeout(id));
        // Told why deferred cards were let through: 'settled' or 'slowed' (tests, measurements).
        const onFlush = options.onFlush || null;
        // The page learns the new scroll position only when a frame is drawn.
        // On a busy machine frames are further apart than SETTLE_MS, so the
        // settle check waits for the next frame (the gallery passes
        // requestAnimationFrame; without it the check runs at once).
        const requestFrame = options.requestFrame || ((fn) => fn());

        let lastTop = null;
        let lastAt = 0;
        let isFast = false;
        let slowSince = null;
        let timer = null;
        const pending = new Set();

        // Distance of a card's middle from the middle of the window: the cards
        // the user is looking at load first, the buffer rows after them.
        function distanceFromView(item) {
            const rect = item.getBoundingClientRect();
            return Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2);
        }

        /** Load every deferred card still on the page, nearest first; the rest left with their row. */
        function flush(reason = 'manual') {
            if (onFlush && pending.size) onFlush(reason, pending.size);
            if (timer !== null) clearTimer(timer);
            timer = null;
            isFast = false;
            slowSince = null;
            const items = Array.from(pending).filter((item) => item.isConnected);
            pending.clear();
            items
                .map((item) => ({ item, distance: distanceFromView(item) }))
                .sort((a, b) => a.distance - b.distance)
                .forEach(({ item }) => load(item));
        }

        // The settle timer can fire while scroll events are still queued
        // behind a busy frame (gaps of 166 ms were seen mid-flick): the
        // position tells whether the gallery really stopped.
        function settle() {
            const settleTimer = timer;
            requestFrame(() => {
                // A scroll event in the meantime set a new timer: still moving.
                if (timer !== settleTimer) return;
                timer = null;
                if (lastTop !== null && Math.abs(getScrollTop() - lastTop) > 1) {
                    timer = setTimer(settle, SETTLE_MS);
                    return;
                }
                flush('settled');
            });
        }

        return {
            /** Call on every scroll event of the gallery's scroll container. */
            noteScroll() {
                const top = getScrollTop();
                const at = now();
                // The first event after a pause starts afresh: a single jump (a
                // click on the scrollbar, End, a restored position) loads at
                // once, while dragging the scrollbar thumb sends a stream of
                // events and counts as a flick. A pause means the settle timer
                // ran: on a busy machine frames can be further apart than
                // SETTLE_MS while the flick goes on (CI runners, 2026-11-16).
                const gap = at - lastAt;
                const isPaused = gap > BUSY_FRAME_MAX_MS || (timer === null && gap > SETTLE_MS);
                if (lastTop !== null && at > lastAt && !isPaused) {
                    const speed = Math.abs(top - lastTop) / (at - lastAt);
                    if (speed > FAST_PX_PER_MS) {
                        isFast = true;
                        slowSince = null;
                    } else if (isFast) {
                        if (slowSince === null) slowSince = at;
                        if (at - slowSince >= SLOW_HOLD_MS) {
                            // Down to a reading pace while still moving (the
                            // tail of a touchpad fling): show what is there.
                            lastTop = top;
                            lastAt = at;
                            flush('slowed');
                            timer = setTimer(settle, SETTLE_MS);
                            return;
                        }
                    }
                }
                lastTop = top;
                lastAt = at;
                if (timer !== null) clearTimer(timer);
                timer = setTimer(settle, SETTLE_MS);
            },
            shouldDefer() {
                return isFast;
            },
            defer(item) {
                pending.add(item);
            },
            flush: () => flush('manual'),
            dispose() {
                if (timer !== null) clearTimer(timer);
                timer = null;
                pending.clear();
            },
        };
    }

    window.GalleryThumbGate = { create, FAST_PX_PER_MS, SETTLE_MS, SLOW_HOLD_MS };
})();
