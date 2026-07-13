/**
 * image-reader/boot.js — image-reader.js decomposition (verbatim; LOADS LAST).
 * Moved BYTE-IDENTICAL from frontend/js/image-reader.js pre-cut lines
 * 1744-1748 (of 1,749): the DOMContentLoaded / immediate init() invocation.
 * The window.ImageReader publish stays in image-reader/core.js; this file only
 * invokes init(). `ImageReader` resolves to the script-global const declared
 * in core.js (prompt-lab/boot.js precedent). Must be the LAST family tag in
 * index.html — init() reaches methods from every other family file.
 */
'use strict';

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => ImageReader.init());
    } else {
        ImageReader.init();
    }
