/**
 * manual-sort/i18n-helpers.js — manual-sort.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/manual-sort.js,
 * pre-split lines 172-210 + 630-634: normalizeManualSortPromptMatchMode,
 * DEFAULT_FOLDER_LABELS, manualSortText / formatManualSortI18n /
 * formatManualSortText, getManualSortToolLabel. Classic script: loads after
 * manual-sort/state-constants.js (base).
 */
function normalizeManualSortPromptMatchMode(value) {
    const appNormalize = window.App?.normalizePromptMatchMode;
    if (typeof appNormalize === 'function') {
        return appNormalize(value);
    }
    const text = String(value || '').trim().toLowerCase();
    return MANUAL_SORT_PROMPT_MATCH_MODES.has(text) ? text : 'exact';
}

const DEFAULT_FOLDER_LABELS = {
    w: 'Top',
    a: 'Keep',
    s: 'Delete',
    d: 'Best'
};

function manualSortText(key, enText, zhText = enText) {
    const translated = window.I18n?.t?.(key);
    if (translated && translated !== key) return translated;
    return window.I18n?.getLang?.() === 'zh-CN' ? zhText : enText;
}

function formatManualSortI18n(key, fallback, replacements = {}) {
    const v = window.I18n?.t?.(key, replacements);
    const raw = (v && v !== key) ? v : fallback;
    return Object.entries(replacements).reduce(
        (out, [token, value]) => out.replaceAll(`{${token}}`, String(value)),
        raw
    );
}

// Like formatManualSortI18n but with an explicit zh fallback, so a key that is
// not yet in the lang files still localizes correctly before token replacement.
function formatManualSortText(key, enText, zhText, replacements = {}) {
    return Object.entries(replacements).reduce(
        (out, [token, value]) => out.replaceAll(`{${token}}`, String(value)),
        manualSortText(key, enText, zhText)
    );
}

function getManualSortToolLabel() {
    return manualSortText('nav.manual', 'Manual Sort', '手动排序');
}

