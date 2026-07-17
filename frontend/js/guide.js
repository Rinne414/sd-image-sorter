/**
 * SD Image Sorter - Contextual Guide System (servable shim).
 *
 * The former 1,085-line contextual-guide god file (bilingual per-tab
 * guide copy, keyboard-shortcut metadata, inline ❔ button anchors,
 * injected modal styles, modal rendering + focus trap, translation
 * refresh, inline-button lifecycle, idempotent init, and the mutable
 * window.Guide singleton) was decomposed VERBATIM into the
 * frontend/js/guide/ module family (static script tags in index.html,
 * one shared classic-script global lexical environment — the
 * smart-tag/autosep/censor precedent, per-file 'use strict'):
 * copy (GUIDE_COPY + TAB_SHORTCUTS + TAB_ANCHORS data consts, FIRST)
 * -> engine (the single mutable `Guide` object; every method uses
 * `this`) -> boot (LAST: the readyState dual-branch init + the sole
 * window.Guide = Guide publish). The three data consts stay lexical
 * — NOT window own-properties — and window.Guide keeps object
 * identity, unsealed and unfrozen; show(tab) still returns exactly
 * `false` for missing copy so keyboard-shortcuts.js can fall back to
 * the shortcuts panel (all pinned by
 * tests/e2e/specs/guide-pins.spec.ts, 11 pins). No identifiers were
 * renamed (tree-wide collision census: GUIDE_COPY / TAB_SHORTCUTS /
 * TAB_ANCHORS / Guide are declared nowhere else). This file stays a
 * real servable asset: index.html references it last in the family
 * and the release packages ship it.
 */
