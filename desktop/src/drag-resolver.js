'use strict';

/**
 * Turns the image ids a page sends for a native drag into file paths by asking
 * the backend, so the page can never make the shell drag an arbitrary path.
 * No Electron imports: runs under `node --test` (desktop/test/drag-resolver.test.js).
 */

const { backendUrl } = require('./paths');

// POST /api/images/by-ids takes at most this many ids per request.
const BY_IDS_CHUNK = 2000;
const LIBRARY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;
const MAIN_LIBRARY_ID = 'main';
const REQUEST_TIMEOUT_MS = 30000;

/** Positive integer ids, each once, in the order given; anything else is dropped. */
function cleanImageIds(ids) {
    if (!Array.isArray(ids)) return [];
    const seen = new Set();
    const result = [];
    for (const raw of ids) {
        if (!Number.isSafeInteger(raw) || raw <= 0 || seen.has(raw)) continue;
        seen.add(raw);
        result.push(raw);
    }
    return result;
}

function cleanLibraryId(libraryId) {
    return typeof libraryId === 'string' && LIBRARY_ID_RE.test(libraryId) ? libraryId : MAIN_LIBRARY_ID;
}

/**
 * Paths for the ids, in the ids' order. `fetchRows(chunk)` returns the backend's
 * rows ({ id, path }) for one chunk; a row for an id nobody asked for is ignored.
 */
async function resolveImagePaths(ids, fetchRows) {
    const wanted = cleanImageIds(ids);
    const pathById = new Map();
    for (let start = 0; start < wanted.length; start += BY_IDS_CHUNK) {
        const chunk = wanted.slice(start, start + BY_IDS_CHUNK);
        const wantedInChunk = new Set(chunk);
        for (const row of await fetchRows(chunk)) {
            if (row && wantedInChunk.has(row.id) && typeof row.path === 'string') pathById.set(row.id, row.path);
        }
    }
    return wanted.map((id) => pathById.get(id)).filter(Boolean);
}

/** The backend's gallery rows for these ids in this library (the shell sends no Origin, like a script). */
async function fetchImagesByIds(port, libraryId, ids) {
    const response = await fetch(`${backendUrl(port)}/api/images/by-ids`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SD-Library-Id': cleanLibraryId(libraryId) },
        body: JSON.stringify({ image_ids: ids }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`The program could not look up the files (HTTP ${response.status}).`);
    const body = await response.json();
    return Array.isArray(body?.images) ? body.images : [];
}

module.exports = { BY_IDS_CHUNK, cleanImageIds, cleanLibraryId, fetchImagesByIds, resolveImagePaths };
