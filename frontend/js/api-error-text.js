/**
 * SD Image Sorter - say an API error in the UI language.
 *
 * Endpoints answer errors as { code, message, params } (main.py turns an
 * HTTPException detail dict into that body, with `error` = `message`). The
 * English `message` is a fallback; the page shows `apiError.<code>` from the
 * language pack, filled with `params`, when the pack has that key.
 *
 * Loaded by index.html (formatApiError in app/gallery-filter-helpers.js uses
 * it for every API verb) and by quick-collect.html.
 */
(function () {
    'use strict';

    function englishText(body, fallback) {
        const candidates = [body.message, body.error, body.detail];
        const found = candidates.find((value) => typeof value === 'string' && value.trim());
        return found || fallback || '';
    }

    /**
     * @param {object} body  The error body ({ code, message, params } or { error } / { detail }).
     * @param {string} [fallback]  Text when the body says nothing usable.
     * @returns {string}
     */
    function apiErrorText(body, fallback) {
        const data = body && typeof body === 'object' ? body : {};
        const english = englishText(data, fallback);
        if (typeof data.code !== 'string' || !data.code) return english;
        const key = `apiError.${data.code}`;
        const params = data.params && typeof data.params === 'object' ? data.params : {};
        const text = window.I18n?.t?.(key, params);
        return text && text !== key ? text : english;
    }

    window.apiErrorText = apiErrorText;
})();
