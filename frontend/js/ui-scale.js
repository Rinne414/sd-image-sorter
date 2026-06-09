/*
 * ui-scale.js — adaptive interface scaling for large / high-resolution desktops.
 *
 * The app's CSS is tuned for ~1920px-wide displays. On larger native panels
 * (2560, 3440 ultrawide, 4K @ 100% OS scaling) every fixed-px control renders
 * physically small. This module applies a single root `zoom` so the whole UI
 * (nav, sidebar, modals, canvas) scales uniformly and the layout reflows to the
 * reduced CSS viewport — verified to produce no horizontal overflow.
 *
 * Loaded synchronously in <head> so the initial zoom is set before first paint
 * (no flash of unscaled UI). Exposes window.UiScale for a manual override.
 *
 * Loop-safety: breakpoints are evaluated in JS against window.innerWidth, which
 * under CSS `zoom` reports the *device* viewport width unchanged by the zoom
 * (verified: 2560 stays 2560 at zoom 1.3; the content reflows to 2560/1.3 but
 * innerWidth does not). That makes innerWidth zoom-invariant, so applying a zoom
 * never feeds back into the measurement and the result is stable across resizes.
 * A CSS @media (min-width){zoom} rule, by contrast, WOULD oscillate.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'ui_scale_v1'; // 'auto' (default) | numeric string e.g. '1.25'
  var MIN_SCALE = 1;
  var MAX_SCALE = 1.8;
  var RESIZE_DEBOUNCE_MS = 150;

  // Auto scale by zoom-invariant logical width. Displays <= ~1920 (laptops,
  // 1080p, 1440p windows) stay at 1.0 so the common case is never altered.
  function autoScaleForWidth(logicalWidth) {
    if (logicalWidth >= 3600) return 1.5; // 4K @ 100%
    if (logicalWidth >= 3100) return 1.4; // 3440 ultrawide
    if (logicalWidth >= 2350) return 1.3; // 2560 / 2880 (matches ~1920 feel)
    if (logicalWidth >= 2000) return 1.15;
    return 1;
  }

  function currentZoom() {
    var z = parseFloat(document.documentElement.style.zoom);
    return (z && isFinite(z) && z > 0) ? z : 1;
  }

  function clampScale(n) {
    if (!isFinite(n)) return 1;
    if (n < MIN_SCALE) return MIN_SCALE;
    if (n > MAX_SCALE) return MAX_SCALE;
    return n;
  }

  // Returns a forced scale number, or null when in 'auto' mode.
  function readOverride() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw || raw === 'auto') return null;
      var n = parseFloat(raw);
      if (isFinite(n)) return clampScale(n);
    } catch (e) { /* storage unavailable (private mode) → auto */ }
    return null;
  }

  function setZoom(target) {
    var de = document.documentElement;
    de.style.setProperty('--ui-scale-current', String(target));
    de.style.setProperty('--ui-scale-inverse', String(1 / target));
    if (Math.abs(currentZoom() - target) <= 0.001) return;
    // An empty string removes the inline zoom (back to the CSS default of 1).
    de.style.zoom = target === 1 ? '' : String(target);
  }

  function apply() {
    var logicalWidth = window.innerWidth; // zoom-invariant under CSS zoom (see header)
    var override = readOverride();
    var target = override != null ? override : autoScaleForWidth(logicalWidth);
    setZoom(clampScale(target));
  }

  var resizeTimer = null;
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(apply, RESIZE_DEBOUNCE_MS);
  }

  window.addEventListener('resize', onResize);

  // Public API for a settings control / power users.
  //   UiScale.set(1.25) → force 125%   |   UiScale.set('auto') → adaptive
  //   UiScale.get()     → current scale |   UiScale.apply()    → recompute now
  window.UiScale = {
    set: function (value) {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          (value == null || value === 'auto') ? 'auto' : String(clampScale(parseFloat(value)))
        );
      } catch (e) { /* ignore */ }
      apply();
    },
    get: currentZoom,
    apply: apply,
    autoScaleForWidth: autoScaleForWidth
  };

  // Run immediately (head, pre-paint). documentElement exists during head parse.
  apply();
})();
