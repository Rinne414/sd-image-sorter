/** Fill [data-msg] elements of an extension page from _locales. */
(function () {
    'use strict';
    document.querySelectorAll('[data-msg]').forEach((node) => {
        const text = chrome.i18n.getMessage(node.dataset.msg);
        if (text) node.textContent = text;
    });
    document.documentElement.lang = chrome.i18n.getUILanguage();
})();
