/**
 * SD Image Sorter - Manual Sort module (servable shim).
 *
 * The former 3,731-line WASD "rhythm sort" workbench was decomposed VERBATIM
 * into the frontend/js/manual-sort/ module family (static script tags in
 * index.html, one shared classic-script global lexical environment):
 * state-constants (base, FIRST) → mode-operation → i18n-helpers →
 * collection-slots → filters-scope → presets-zen-enh → init → slot-start →
 * bracket → cull → slot-actions → keys → boot-touch (exports + boot, LAST).
 * Only state-constants-first and boot-touch-last are load-bearing; every
 * cross-file reference is runtime-only (hoisted function globals + base
 * consts). This file stays a real servable asset (index.html references it
 * and the release packages ship it); backend contract tests read the whole
 * family via _manual_sort_family_source() / the release-build family concat.
 */
