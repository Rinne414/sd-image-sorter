/**
 * SD Image Sorter - Image Reader Tab (decomposed shim)
 * The ImageReader god-object now lives in frontend/js/image-reader/*.js — an
 * Object.assign mixin family over the base object declared in
 * image-reader/core.js (each file's header records its pre-cut line range).
 * This file stays as a real, servable script because index.html's script tag
 * and the test_frontend_contract.py _reader_family_source helper both
 * reference /static/js/image-reader.js (gallery.js shim precedent).
 */
