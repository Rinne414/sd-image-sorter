/**
 * Separation Console (SEP-1) — decomposed shim.
 * The SeparationConsole singleton now lives in
 * frontend/js/modules/separation-console/*.js — an Object.assign mixin
 * family over the base object declared in separation-console/core.js
 * (each file's header records its pre-cut line range; boot.js publishes
 * window.SeparationConsole and runs the DOMContentLoaded init LAST,
 * mirroring the original file tail). This file stays as a real, servable
 * script so /static/js/modules/separation-console.js remains a stable
 * URL; index.html keeps its tag last in the family block (gallery.js /
 * smart-tag.js / artist-ident.js shim precedent — nothing GETs it, the
 * shim is kept for URL stability only).
 */
