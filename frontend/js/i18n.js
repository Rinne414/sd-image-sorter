/**
 * SD Image Sorter - Internationalization (i18n) Engine
 * Lightweight translation system supporting English and Simplified Chinese.
 * No external dependencies - works with vanilla JS.
 *
 * Usage:
 *   HTML static text:   <span data-i18n="nav.gallery">Gallery</span>
 *   Placeholders:       <input data-i18n-placeholder="filter.searchTags">
 *   Tooltips:           <button data-i18n-title="action.scan">
 *   Aria labels:        <button data-i18n-aria="action.scan">
 *   Dynamic JS text:    I18n.t('gallery.imageCount', { count: 42 })
 */

(function () {
    'use strict';

    var STORAGE_KEY = 'sd-image-sorter-lang';
    var SUPPORTED_LANGS = ['en', 'zh-CN'];
    var DEFAULT_LANG = 'en';

    // English counts read right when the count is 1: "{count} images are too
    // small" is written "1 image is too small". The packs keep one plural
    // sentence; when a count is exactly 1, format() writes the noun that
    // follows it (maybe after one modifier, "{count} folder images") and a
    // verb right after it ("are", "have") in the singular. The lists are the
    // ones in frontend-v4/src/i18n/plural.ts; backend/tests/test_i18n_plural.py
    // keeps them equal and holds every English count in lang/en.js to them.
    // Chinese has no plural and never matches.
    var PLURALS = {
        images: 'image', pictures: 'picture', videos: 'video', sources: 'source', conditions: 'condition',
        records: 'record', tags: 'tag', captions: 'caption', tokens: 'token', stars: 'star', pairs: 'pair',
        groups: 'group', words: 'word', times: 'time', steps: 'step', rounds: 'round', originals: 'original',
        models: 'model', megapixels: 'megapixel', folders: 'folder', threads: 'thread', notes: 'note',
        frames: 'frame', issues: 'issue', duplicates: 'duplicate', details: 'detail', conflicts: 'conflict',
        categories: 'category', batches: 'batch', artists: 'artist', areas: 'area', epochs: 'epoch',
        files: 'file', requests: 'request', posts: 'post', favorites: 'favorite', collections: 'collection',
        libraries: 'library', presets: 'preset', rules: 'rule', sets: 'set', results: 'result', names: 'name',
        entries: 'entry', boxes: 'box', copies: 'copy', masks: 'mask', jobs: 'job', matches: 'match',
        filters: 'filter', items: 'item', previews: 'preview', errors: 'error', warnings: 'warning',
        seconds: 'second', minutes: 'minute', grades: 'grade', comparisons: 'comparison', sections: 'section',
        prompts: 'prompt', blockers: 'blocker', regions: 'region', variants: 'variant', suggestions: 'suggestion',
        problems: 'problem', packages: 'package', edits: 'edit', detections: 'detection', candidates: 'candidate',
        GIFs: 'GIF', outliers: 'outlier', findings: 'finding'
    };
    var MODIFIERS = [
        'folder', 'image', 'old', 'more', 'new', 'edited', 'hand-edited', 'untagged', 'uncensored', 'selected',
        'scored', 'picked', 'generated', 'extra', 'common', 'other', 'library', 'clearable',
        'indexed', 'matching', 'filter', 'unique', 'flagged', 'duplicate', 'redundant', 'censored', 'queued',
        'ready-made', 'gallery', 'moved', 'sidecar', 'noise', 'local', 'dataset', 'unreadable', 'middle',
        'near-identical', 'scan', 'original', 'unconfirmed', 'detection', 'matched', 'queue', 'category',
        'existing', 'trait', 'disguise', 'missing', 'suspected', 'filtered'
    ];
    var VERBS = {
        are: 'is', were: 'was', have: 'has', do: 'does', look: 'looks', spell: 'spells', share: 'shares',
        match: 'matches', belong: 'belongs', use: 'uses', need: 'needs', stop: 'stops', lack: 'lacks'
    };
    var LINKS = ['that', 'which', 'who'];
    var ADVERBS = ['already', 'now', 'still', 'just', 'also', 'more'];
    // A count after one of these is not the subject ("Caption edits for {n}
    // images were cleared"): its verb stays, unless a link word ties the verb
    // to the counted noun ("for {n} images that were not exported").
    var PREPOSITION_BEFORE = /\b(?:for|of|with|from|on|in|into|to|by|at|about|than|after|before|across|per|between|among)\s+(?:the\s+|all\s+|these\s+)?$/i;

    function keysOf(map) {
        return Object.keys(map).join('|');
    }

    // "{count}", maybe closed by an inline tag ("<strong>{count}</strong> images"),
    // then an optional "modifier noun" and an optional "link adverb verb".
    var COUNTED = new RegExp(
        '\\{(\\w+)\\}(</[a-z]+>)?' +
        '(?: (?:(' + MODIFIERS.join('|').replace(/-/g, '\\-') + ') )?(' + keysOf(PLURALS) + ')\\b)?' +
        '(?:(?: (' + LINKS.join('|') + '))?(?: (' + ADVERBS.join('|') + '))? (' + keysOf(VERBS) + ')\\b)?',
        'g'
    );

    /** The template with every count that is exactly 1 followed by singular words. */
    function singularize(template, params) {
        return template.replace(COUNTED, function (match, key, tag, mod, noun, link, adverb, verb, offset) {
            if (String(params[key]) !== '1' || (!noun && !verb)) return match;
            var out = '{' + key + '}' + (tag || '');
            if (noun) out += ' ' + (mod ? mod + ' ' : '') + PLURALS[noun];
            if (verb) {
                var isSubject = link || !PREPOSITION_BEFORE.test(template.slice(0, offset));
                out += (link ? ' ' + link : '') + (adverb ? ' ' + adverb : '') + ' ' + (isSubject ? VERBS[verb] : verb);
            }
            return out;
        });
    }

    var I18n = {
        currentLang: DEFAULT_LANG,
        translations: {},
        _initialized: false,

        /**
         * Initialize i18n system.
         * Loads saved language preference, registers available translations,
         * and applies translations to the DOM.
         */
        init: function () {
            // Register language packs from global variables set by lang/*.js files
            if (window.I18nLang_en) {
                this.translations['en'] = window.I18nLang_en;
            }
            if (window.I18nLang_zhCN) {
                this.translations['zh-CN'] = window.I18nLang_zhCN;
            }

            // Load saved preference
            var saved = null;
            try {
                saved = localStorage.getItem(STORAGE_KEY);
            } catch (e) {
                // localStorage may be unavailable
            }

            if (saved && SUPPORTED_LANGS.indexOf(saved) !== -1) {
                this.currentLang = saved;
            } else {
                // Try to detect from browser language
                var browserLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
                if (browserLang.indexOf('zh') === 0) {
                    this.currentLang = 'zh-CN';
                } else {
                    this.currentLang = DEFAULT_LANG;
                }
            }

            this._applyLangClass();
            this._initialized = true;
        },

        /**
         * Set the active language and re-translate the entire page.
         * @param {string} lang - Language code ('en' or 'zh-CN')
         */
        setLang: function (lang) {
            if (SUPPORTED_LANGS.indexOf(lang) === -1) {
                return;
            }
            if (lang === this.currentLang && this._initialized) {
                return;
            }

            this.currentLang = lang;

            try {
                localStorage.setItem(STORAGE_KEY, lang);
            } catch (e) {
                // Ignore localStorage errors
            }

            this._applyLangClass();
            this.applyToDOM();
            if (window.App?.syncGallerySortLabels) {
                window.App.syncGallerySortLabels();
            }

            // Update <html lang> attribute
            document.documentElement.lang = lang === 'zh-CN' ? 'zh-CN' : 'en';

            // Dispatch custom event so JS modules can react
            var event;
            try {
                event = new CustomEvent('languageChanged', {
                    detail: { lang: lang }
                });
            } catch (e) {
                // IE fallback
                event = document.createEvent('CustomEvent');
                event.initCustomEvent('languageChanged', true, true, { lang: lang });
            }
            document.dispatchEvent(event);
        },

        /**
         * Get a translated string by key, with optional parameter interpolation.
         * Falls back to English if the key is missing in the current language.
         * Falls back to the key itself if missing from all languages.
         *
         * SECURITY CONTRACT: params are interpolated verbatim (String()) and are
         * NOT HTML-escaped. Some translation values intentionally contain HTML
         * (e.g. "<strong>{count}</strong>"). Therefore any caller that assigns
         * t()'s result to innerHTML MUST pre-escape user-influenced params
         * (filenames, prompts, tags, folder/naming) at the call site.
         *
         * @param {string} key - Translation key (e.g. 'gallery.imageCount')
         * @param {Object} [params] - Interpolation parameters (e.g. { count: 42 })
         * @returns {string} Translated string
         */
        t: function (key, params) {
            var langPack = this.translations[this.currentLang];
            var fallbackPack = this.translations[DEFAULT_LANG];

            var text = (langPack && langPack[key] != null)
                ? langPack[key]
                : (fallbackPack && fallbackPack[key] != null)
                    ? fallbackPack[key]
                    : key;

            return this.format(text, params);
        },

        /**
         * Fill {param} placeholders (every occurrence, values verbatim, no
         * `$` patterns), writing a count of exactly 1 with singular words.
         * The same SECURITY CONTRACT as t() applies to the params.
         *
         * @param {string} template - Text with {param} placeholders
         * @param {Object} [params] - Values for the placeholders
         * @returns {string}
         */
        format: function (template, params) {
            var text = String(template == null ? '' : template);
            if (!params || typeof params !== 'object') return text;
            // One pass: a value that contains "{other}" is not filled again.
            return singularize(text, params).replace(/\{(\w+)\}/g, function (match, key) {
                return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
            });
        },

        /** The singular lists, read by backend/tests/test_i18n_plural.py. */
        pluralRules: { PLURALS: PLURALS, MODIFIERS: MODIFIERS, VERBS: VERBS },

        /**
         * Apply translations to all DOM elements with data-i18n attributes.
         * Handles: data-i18n (textContent), data-i18n-placeholder,
         *          data-i18n-title, data-i18n-aria (aria-label),
         *          data-i18n-html (legacy alias, rendered as textContent).
         */
        applyToDOM: function () {
            // data-i18n: set textContent
            var elements = document.querySelectorAll('[data-i18n]');
            for (var i = 0; i < elements.length; i++) {
                var el = elements[i];
                // Honor the dynamic-text lock (same contract as ui-refresh's
                // _setButton): a runtime label like "Apply · ~N images" must
                // not be reset to its static key while the lock is held.
                if (el.dataset && el.dataset.i18nLocked === '1') {
                    continue;
                }
                var key = el.getAttribute('data-i18n');
                if (key) {
                    el.textContent = this.t(key);
                }
            }

            // data-i18n-html: legacy alias. Keep it text-only to avoid translation XSS.
            var htmlElements = document.querySelectorAll('[data-i18n-html]');
            for (var i = 0; i < htmlElements.length; i++) {
                var el = htmlElements[i];
                var key = el.getAttribute('data-i18n-html');
                if (key) {
                    el.textContent = this.t(key);
                }
            }

            // data-i18n-placeholder: set placeholder attribute
            var placeholders = document.querySelectorAll('[data-i18n-placeholder]');
            for (var i = 0; i < placeholders.length; i++) {
                var el = placeholders[i];
                var key = el.getAttribute('data-i18n-placeholder');
                if (key) {
                    el.placeholder = this.t(key);
                    // shorter hints for a narrow field: the first that fits is shown (modules/core/path-input.js)
                    var shortKeys = (el.getAttribute('data-i18n-placeholder-short') || '').split(/\s+/).filter(Boolean);
                    if (shortKeys.length && typeof window.fitPlaceholder === 'function') {
                        var texts = [this.t(key)];
                        for (var s = 0; s < shortKeys.length; s++) texts.push(this.t(shortKeys[s]));
                        window.fitPlaceholder(el, texts);
                    }
                }
            }

            // data-i18n-title: set title attribute (tooltip)
            var titles = document.querySelectorAll('[data-i18n-title]');
            for (var i = 0; i < titles.length; i++) {
                var el = titles[i];
                var key = el.getAttribute('data-i18n-title');
                if (key) {
                    el.title = this.t(key);
                }
            }

            // data-i18n-aria: set aria-label attribute
            var arias = document.querySelectorAll('[data-i18n-aria]');
            for (var i = 0; i < arias.length; i++) {
                var el = arias[i];
                var key = el.getAttribute('data-i18n-aria');
                if (key) {
                    el.setAttribute('aria-label', this.t(key));
                }
            }
        },

        /**
         * Get the current language code.
         * @returns {string}
         */
        getLang: function () {
            return this.currentLang;
        },

        /**
         * Toggle between English and Simplified Chinese.
         */
        toggle: function () {
            var newLang = this.currentLang === 'en' ? 'zh-CN' : 'en';
            this.setLang(newLang);
        },

        /**
         * Check if the current language is Chinese.
         * @returns {boolean}
         */
        isChinese: function () {
            return this.currentLang === 'zh-CN';
        },

        /**
         * Join a translated label and a value. Chinese uses the full-width colon
         * with no space (the language pack's house style), other languages "label: value".
         * @param {string} label
         * @param {*} value
         * @returns {string}
         */
        joinLabel: function (label, value) {
            return label + (String(this.currentLang).indexOf('zh') === 0 ? '\uFF1A' : ': ') + value;
        },

        /**
         * A translated label with its colon, for a value that follows in its own element.
         * @param {string} label
         * @returns {string}
         */
        labelColon: function (label) {
            return label + (String(this.currentLang).indexOf('zh') === 0 ? '\uFF1A' : ':');
        },

        /**
         * Get list of supported language codes.
         * @returns {string[]}
         */
        getSupportedLangs: function () {
            return SUPPORTED_LANGS.slice();
        },

        /**
         * Add or update a language pack dynamically.
         * @param {string} lang - Language code
         * @param {Object} translations - Key-value translation map
         */
        addLang: function (lang, translations) {
            if (!this.translations[lang]) {
                this.translations[lang] = {};
            }
            var keys = Object.keys(translations);
            for (var i = 0; i < keys.length; i++) {
                this.translations[lang][keys[i]] = translations[keys[i]];
            }
            if (SUPPORTED_LANGS.indexOf(lang) === -1) {
                SUPPORTED_LANGS.push(lang);
            }
        },

        /**
         * Apply the lang-zh CSS class to <html> when Chinese is active.
         * This allows CSS to adapt layouts for wider Chinese characters.
         * @private
         */
        _applyLangClass: function () {
            var html = document.documentElement;
            if (this.currentLang === 'zh-CN') {
                html.classList.add('lang-zh');
                html.classList.remove('lang-en');
            } else {
                html.classList.add('lang-en');
                html.classList.remove('lang-zh');
            }
        }
    };

    // Expose globally
    window.I18n = I18n;

})();
