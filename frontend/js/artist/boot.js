/**
 * artist/boot.js — artist-ident.js decomposition (verbatim; LOADS LAST).
 * Moved BYTE-IDENTICAL from frontend/js/artist-ident.js pre-cut lines
 * 1169-1171 (of 1,171): the DOMContentLoaded tail that calls
 * ArtistIdent.applySavedPreferences(). The `window.ArtistIdent =
 * ArtistIdent;` publish (pre-cut line 1168) stays in artist/core.js.
 * `ArtistIdent` resolves to the script-global const declared in core.js
 * (similar/boot.js precedent). Must be the LAST family tag in
 * index.html: applySavedPreferences lives in artist/preferences.js and
 * _syncControls reaches methods from every other family file. Classic
 * non-strict script.
 */
document.addEventListener('DOMContentLoaded', () => {
    ArtistIdent.applySavedPreferences();
});
