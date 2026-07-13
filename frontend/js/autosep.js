/**
 * SD Image Sorter - Auto-Separate module (servable shim).
 *
 * The former 1,981-line Auto-Separate workbench (filter → preview → batch
 * copy/move + settings modal + background move/copy progress poller) was
 * decomposed VERBATIM into the frontend/js/autosep/ module family (static
 * script tags in index.html, one shared classic-script global lexical
 * environment): state-constants (base, FIRST) → operation-mode →
 * filters-scope → init (the DOMContentLoaded boot rides with
 * initAutoSeparate) → serialize → configs → settings → summary-chips →
 * preview → move-progress. Only state-constants-first is load-bearing;
 * every cross-file reference is runtime-only (hoisted function globals +
 * base consts), and each of the five window.* exports is published in the
 * family file that declares its function. This file stays a real servable
 * asset (index.html references it and the release packages ship it);
 * backend contract tests read the whole family via
 * _autosep_family_source() / the release-build family concat.
 */
