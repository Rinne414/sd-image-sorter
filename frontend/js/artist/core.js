/**
 * artist/core.js — artist-ident.js decomposition (family base; MUST LOAD FIRST).
 * Moved BYTE-IDENTICAL from frontend/js/artist-ident.js pre-cut lines 1-61 +
 * 134-137 + 155-159 + 321-349 + 496-508 + 1165-1168 (of 1,171): the file
 * header, `const ArtistIdent = {` + every state field + thresholdDefaults,
 * tText/tKey/localizeDiagnosticsMessage, getArtistStat,
 * formatConfidencePercent, getInitials/formatArtistName,
 * _escapeHtml/_decodeArtistValue, the object-literal `};` closer and the
 * `window.ArtistIdent = ArtistIdent;` publish. Declares the ONE unsealed
 * object every other artist/*.js file Object.assign()s onto — this file
 * must load before the rest of the family; artist/boot.js runs the
 * DOMContentLoaded tail LAST. No 'use strict' anywhere in the family: the
 * original was a non-strict classic script (similar.js precedent); bare
 * `Logger` / `formatUserError` globals resolve via the shared
 * classic-script scope.
 */
/**
 * SD Image Sorter - Artist Identification Module
 * Identifies artist/style of images using LSNet-style classification.
 */

const ArtistIdent = {
    isIdentifying: false,
    selectedArtist: null,
    selectedArtistPageSize: 120,
    selectedArtistOffset: 0,
    selectedArtistHasMore: false,
    selectedArtistImages: [],
    artistRequestToken: 0,
    viewMode: 'grid',
    stats: {},
    diagnostics: null,
    eventsBound: false,
    progressTracker: null,
    thresholdDefaults: {
        value: 0.03,
        suggestedLow: 0.02,
        suggestedHigh: 0.08,
    },

    tText(enText, zhText) {
        return window.I18n?.getLang?.() === 'zh-CN' ? zhText : enText;
    },

    tKey(key, enText, zhText = enText, params = null) {
        const translated = window.I18n?.t?.(key, params || undefined);
        if (translated && translated !== key) return translated;
        let fallback = this.tText(enText, zhText);
        if (params && typeof params === 'object') {
            Object.entries(params).forEach(([token, value]) => {
                fallback = fallback.replaceAll(`{${token}}`, String(value));
            });
        }
        return fallback;
    },

    localizeDiagnosticsMessage(message) {
        const raw = String(message || '').trim();
        if (!raw) return '';

        if (raw === 'Kaloscope runtime is ready.') {
            return this.tText(raw, 'Kaloscope 运行环境已就绪。');
        }
        if (raw === 'Artist identification still needs the LSNet runtime, Kaloscope files, or Python dependencies.') {
            return this.tText(raw, '还缺少 LSNet / Kaloscope / Python 依赖。');
        }
        if (raw === "On Windows, comfyui-lsnet may log 'SkaFn failed; falling back to PyTorchSkaFn'. That fallback is usually okay if artist predictions still appear.") {
            return this.tText(
                raw,
                'Windows 下若出现 “SkaFn failed; falling back to PyTorchSkaFn”，但结果仍能出来，通常可以先忽略。'
            );
        }

        return raw;
    },

    _getExplicitGallerySelectionIds() {
        const selectedIds = window.AppFilterAccess?.getSelectedImageIds?.();
        return Array.isArray(selectedIds)
            ? selectedIds
                .map((id) => Number(id))
                .filter((id) => Number.isFinite(id) && id > 0)
            : [];
    },

    getArtistStat(artist) {
        return this.stats?.artist_stats?.[artist] || { count: 0, avg_confidence: 0, max_confidence: 0 };
    },

    formatConfidencePercent(value) {
        const numeric = Number(value || 0);
        return `${(numeric * 100).toFixed(1)}%`;
    },

    getInitials(name) {
        const safeName = String(name ?? '').trim();
        if (!safeName || safeName === 'undefined') return '?';

        const parts = safeName
            .replace(/_/g, ' ')
            .split(/\s+/)
            .filter(Boolean);

        if (parts.length === 0) return '?';
        if (parts.length === 1) {
            return parts[0].substring(0, 2).toUpperCase();
        }

        return parts.slice(0, 2).map(p => p[0].toUpperCase()).join('');
    },

    formatArtistName(name) {
        const safeName = String(name ?? '').trim();
        if (!safeName || safeName === 'undefined') return 'Undefined';

        return safeName
            .replace(/_/g, ' ')
            .split(/\s+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    },

    _escapeHtml(value) {
        // Delegate to global escapeHtml from modules/utils/escape.js
        return window.escapeHtml(value);
    },

    _decodeArtistValue(value) {
        try {
            return decodeURIComponent(String(value ?? ''));
        } catch (e) {
            return String(value ?? '');
        }
    },

};

// Export
window.ArtistIdent = ArtistIdent;
