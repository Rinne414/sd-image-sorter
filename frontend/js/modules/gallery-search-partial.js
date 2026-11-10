/**
 * Partial names for lora: and checkpoint: search terms.
 *
 * The filters match a LoRA or checkpoint by its whole name, which is right
 * for a name picked from a list, but a typed "lora:detail" found nothing
 * while the library held "detail_tweaker". A typed value with no library
 * entry of exactly that name stands for every entry whose name contains it;
 * a value that is a whole name keeps meaning only that one.
 *
 * `needsLookup` says whether a query has values not looked up yet, `resolve`
 * asks the library for them, and `expand` then answers from what is known.
 */
(function () {
    'use strict';

    const ENDPOINTS = {
        loras: '/api/loras/library',
        checkpoints: '/api/checkpoints/library',
    };
    // Which library each filter field reads its names from.
    const FIELD_KIND = {
        loras: 'loras',
        excludeLoras: 'loras',
        checkpoints: 'checkpoints',
        excludeCheckpoints: 'checkpoints',
    };
    // The library changes with every import; an answer is trusted this long.
    const KNOWN_FOR_MS = 60000;

    const known = new Map();

    function cacheKey(kind, value) {
        return `${kind}\n${String(value).toLowerCase()}`;
    }

    function fresh(kind, value) {
        const entry = known.get(cacheKey(kind, value));
        return entry && Date.now() - entry.at < KNOWN_FOR_MS ? entry : null;
    }

    function namesOf(data) {
        const rows = (data && (data.loras || data.checkpoints)) || [];
        return rows
            .map((row) => (typeof row === 'string' ? row : (row.lora ?? row.checkpoint ?? row.name ?? null)))
            .filter((name) => typeof name === 'string' && name);
    }

    /** The names a typed value stands for: itself, or every library name containing it. */
    function expand(field, values) {
        const kind = FIELD_KIND[field];
        if (!kind) return values || [];
        const out = [];
        (values || []).forEach((value) => {
            const entry = fresh(kind, value);
            (entry ? entry.names : [value]).forEach((name) => {
                if (!out.includes(name)) out.push(name);
            });
        });
        return out;
    }

    async function lookUp(kind, value) {
        let names = [];
        try {
            const response = await fetch(`${ENDPOINTS[kind]}?q=${encodeURIComponent(value)}`);
            if (response.ok) names = namesOf(await response.json());
        } catch (error) {
            // The library did not answer: the typed value is used as a whole name.
            names = [];
        }
        const typed = String(value).toLowerCase();
        const isWholeName = names.some((name) => name.toLowerCase() === typed);
        // Nothing contains it: keep the typed value, so the gallery says "no match".
        const stands = isWholeName || names.length === 0 ? [value] : names;
        known.set(cacheKey(kind, value), { at: Date.now(), names: stands });
    }

    function unknownValues(parsed) {
        const pairs = [];
        Object.keys(FIELD_KIND).forEach((field) => {
            const kind = FIELD_KIND[field];
            (parsed?.[field] || []).forEach((value) => {
                if (!fresh(kind, value)) pairs.push([kind, value]);
            });
        });
        return pairs;
    }

    /** Whether the query has a lora:/checkpoint: value the library was not asked about yet. */
    function needsLookup(parsed) {
        return unknownValues(parsed).length > 0;
    }

    /** Ask the library about every value not known yet; afterwards `expand` knows them all. */
    async function resolve(parsed) {
        await Promise.all(unknownValues(parsed).map(([kind, value]) => lookUp(kind, value)));
    }

    window.GallerySearchPartial = Object.freeze({ expand, needsLookup, resolve });
})();
