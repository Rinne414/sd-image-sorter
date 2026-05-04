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

            // Interpolate {param} placeholders
            if (params && typeof params === 'object') {
                var keys = Object.keys(params);
                for (var i = 0; i < keys.length; i++) {
                    var placeholder = '{' + keys[i] + '}';
                    text = text.split(placeholder).join(String(params[keys[i]]));
                }
            }

            return text;
        },

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
