/**
 * separation-console/boot.js — separation-console.js decomposition
 * (verbatim; LOADS LAST). Moved BYTE-IDENTICAL from
 * frontend/js/modules/separation-console.js pre-cut lines 1149-1154 (of
 * 1,155): the `window.SeparationConsole = SeparationConsole;` publish and
 * the DOMContentLoaded/immediate init() tail — kept LAST to mirror the
 * original file, where the publish sits AFTER the complete object
 * literal. `SeparationConsole` resolves to the script-global const
 * declared in core.js. Must be the LAST family tag in index.html: init()
 * wires listeners into methods from every other family file. Strict
 * per-file (the original IIFE was strict).
 */
'use strict';
    window.SeparationConsole = SeparationConsole;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => SeparationConsole.init());
    } else {
        SeparationConsole.init();
    }
