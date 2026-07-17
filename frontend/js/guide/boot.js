/**
 * guide/boot.js — guide.js decomposition (LOADS LAST).
 * Extracted VERBATIM from frontend/js/guide.js pre-split lines
 * 1077-1084 (of 1,085): the readyState DUAL-BRANCH boot ('loading'
 * registers ONE DOMContentLoaded listener; anything else calls
 * Guide.init() immediately — both branches kept verbatim, NOT
 * collapsed into a single listener) and the sole
 * `window.Guide = Guide` publish. Classic script: the ONLY family
 * file with top-level execution, so its tag must come LAST —
 * `Guide` (guide/engine.js) and the data consts (guide/copy.js) are
 * already initialized in the shared global lexical environment.
 * 'use strict' added per-file (the original IIFE was strict
 * throughout); everything below the directive is byte-identical to
 * the pre-split file.
 */
'use strict';

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => Guide.init());
    } else {
        Guide.init();
    }

    window.Guide = Guide;
