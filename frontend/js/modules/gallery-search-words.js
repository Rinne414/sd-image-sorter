/**
 * Chinese and Japanese words in the Gallery search, read as tags.
 *
 * Prompts, captions and file names are in English, so a typed "猫耳" found
 * nothing, although the program ships the table that knows 猫耳 is cat_ears.
 * A free-text word the table knows as a whole name becomes that tag when the
 * library has pictures with it; when it has none, the word is searched as the
 * tag's English words instead (the prompt may still say "cat ears"). The
 * "read as" chips show what happened, so nothing is swapped out of sight.
 *
 * Same three steps as modules/gallery-search-partial.js: `needsLookup` says
 * whether a query has words not asked about yet, `resolve` asks, and `apply`
 * then answers from what is known.
 */
(function () {
    'use strict';

    const ENDPOINT = '/api/tags/words';
    // Hiragana, katakana and CJK ideographs: the scripts the name table is written in.
    const NAME_SCRIPT = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;
    // The library changes with every tagging run; an answer is trusted this long.
    const KNOWN_FOR_MS = 60000;

    const known = new Map();

    function fresh(word) {
        const entry = known.get(word);
        return entry && Date.now() - entry.at < KNOWN_FOR_MS ? entry : null;
    }

    function candidateWords(parsed) {
        return (parsed?.freeText || []).filter((word) => NAME_SCRIPT.test(word) && !/\s/.test(word));
    }

    /** Whether the query has a Chinese or Japanese word the table was not asked about yet. */
    function needsLookup(parsed) {
        return candidateWords(parsed).some((word) => !fresh(word));
    }

    /** Ask about every word not known yet; afterwards `apply` knows them all. */
    async function resolve(parsed) {
        const words = [...new Set(candidateWords(parsed).filter((word) => !fresh(word)))];
        if (!words.length) return;
        let found = {};
        try {
            const query = words.map((word) => `q=${encodeURIComponent(word)}`).join('&');
            const response = await fetch(`${ENDPOINT}?${query}`);
            if (response.ok) found = (await response.json()).words || {};
        } catch (error) {
            // No answer: the words stay free text.
            found = {};
        }
        const at = Date.now();
        words.forEach((word) => known.set(word, { at, tag: found[word]?.tag || null, pictures: Number(found[word]?.pictures || 0) }));
    }

    /**
     * The parsed query with its known words read as tags. Returns the same
     * object when nothing is known, a changed copy otherwise.
     */
    function apply(parsed) {
        const words = candidateWords(parsed).filter((word) => fresh(word)?.tag);
        if (!words.length) return parsed;
        const tags = [...(parsed.tags || [])];
        const freeText = [];
        (parsed.freeText || []).forEach((word) => {
            const entry = words.includes(word) ? fresh(word) : null;
            if (!entry) freeText.push(word);
            else if (entry.pictures > 0) {
                if (!tags.includes(entry.tag)) tags.push(entry.tag);
            } else freeText.push(entry.tag.replace(/_/g, ' '));
        });
        const parts = (parsed.parts || []).map((part) => {
            const entry = part.kind === 'free' && words.includes(part.value) ? fresh(part.value) : null;
            if (!entry) return part;
            return entry.pictures > 0
                ? { ...part, kind: 'filter', key: 'tag', op: '', value: `${entry.tag} (${part.value})` }
                : { ...part, value: entry.tag.replace(/_/g, ' ') };
        });
        return { ...parsed, tags, freeText, parts };
    }

    window.GallerySearchWords = Object.freeze({ apply, needsLookup, resolve });
})();
