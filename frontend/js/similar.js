/**
 * SD Image Sorter - Similar Images Module (decomposed shim)
 * The SimilarImages god-object now lives in frontend/js/similar/*.js — an
 * Object.assign mixin family over the base object declared in
 * similar/core.js (each file's header records its pre-cut line range).
 * This file stays as a real, servable script so /static/js/similar.js
 * remains a stable URL; index.html keeps its tag last in the family
 * (gallery.js / image-reader.js shim precedent — no test GETs it, the
 * shim is kept for URL stability only).
 */
