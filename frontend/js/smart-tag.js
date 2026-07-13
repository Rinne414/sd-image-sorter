/**
 * SD Image Sorter - Smart Tag module (servable shim).
 *
 * The former 1,246-line Smart Tag wizard (the Dataset Maker "Smart Tag
 * (WD14 + VLM)" modal: source resolution, tagger catalog + model-default
 * adoption, consensus vote UI, /api/smart-tag/start payload assembly,
 * progress poll + AI-queue rendering, Ollama banner, cancel/close) was
 * decomposed VERBATIM into the frontend/js/smart-tag/ module family
 * (static script tags in index.html, one shared classic-script global
 * lexical environment — the autosep/censor precedent, per-file
 * 'use strict' per the image-reader precedent): state (base, FIRST) ->
 * sources -> progress-ui -> ollama-banner -> modal -> taggers -> vote-ui
 * -> form -> run -> boot (LAST: bindHandlers + DOM-ready gate + the
 * single window.SmartTag publish). Only state-first and boot-last are
 * load-bearing; every other cross-file reference resolves at event time
 * (hoisted function globals + base consts). Four generic identifiers
 * were renamed for tree-wide global uniqueness ($ -> smartTag$,
 * $$ -> smartTag$$, t -> smartTagT, closeModal -> closeSmartTagModal);
 * everything else moved byte-identical. This file stays a real servable
 * asset (index.html references it last in the family and the release
 * packages ship it); backend contract tests read the whole family via
 * _smart_tag_family_source() in backend/tests/test_frontend_contract.py.
 */
