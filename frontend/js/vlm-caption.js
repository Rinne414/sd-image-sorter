/**
 * SD Image Sorter - VLM Captioning Module (decomposed shim)
 * The VLMCaption god-object now lives in frontend/js/vlm-caption/*.js — an
 * Object.assign mixin family over the base object declared in
 * vlm-caption/core.js (each file's header records its pre-cut line range).
 * This file stays as a real, servable script so /static/js/vlm-caption.js
 * remains a stable URL; index.html keeps its tag last in the family
 * (gallery.js / similar.js / artist-ident.js shim precedent — no test GETs
 * it, the shim is kept for URL stability only).
 */
