/**
 * SD Image Sorter - Artist Identification Module (decomposed shim)
 * The ArtistIdent god-object now lives in frontend/js/artist/*.js — an
 * Object.assign mixin family over the base object declared in
 * artist/core.js (each file's header records its pre-cut line range).
 * This file stays as a real, servable script so /static/js/artist-ident.js
 * remains a stable URL; index.html keeps its tag last in the family
 * (gallery.js / similar.js / image-reader.js shim precedent — no test
 * GETs it, the shim is kept for URL stability only).
 */
