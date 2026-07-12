/**
 * app/constants-prefs.js — app.js decomposition, stage 2 (leaf sections).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js,
 * pre-split lines 6-249. Classic script: shares ONE global lexical
 * environment with app.js and the other app/ parts; index.html loads
 * every app/ file BEFORE app.js, so these top-level declarations stay
 * visible there. No behavior change intended.
 */
const API_BASE = '';  // Same origin
const SCAN_PREVIEW_PAGE_SIZE = 80;
const VALID_ASPECT_RATIO_FILTERS = new Set(['square', 'landscape', 'portrait']);
const VALID_PROMPT_MATCH_MODES = new Set(['exact', 'contains']);

// Utility: Debounce function
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

// HTML escape utility
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Utility: Throttle function
function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// i18n helper for app-level dynamic strings.
function appT(key, fallback, params) {
    const val = window.I18n?.t?.(key, params);
    let text = (val && val !== key) ? val : (fallback || key);
    if (params && typeof params === 'object') {
        for (const [paramKey, paramValue] of Object.entries(params)) {
            text = String(text).split(`{${paramKey}}`).join(String(paramValue));
        }
    }
    return text;
}

function normalizeAspectRatioFilter(value) {
    const text = String(value || '').trim();
    return VALID_ASPECT_RATIO_FILTERS.has(text) ? text : '';
}

function normalizePromptMatchMode(value) {
    const text = String(value || '').trim().toLowerCase();
    return VALID_PROMPT_MATCH_MODES.has(text) ? text : 'exact';
}

// Generators that show as their own top-level tab in the gallery header.
// Keep this small and intentional — the goal is to spend the limited
// horizontal space only on the generators most users actually have in bulk.
const PRIMARY_GENERATORS = ['comfyui', 'nai', 'webui', 'forge', 'unknown'];

// Generators that are bundled under the "Others" top-level tab. Each
// is still filterable individually via the Filter Criteria modal — this
// list only controls what `data-gen="others"` resolves to. Stay in sync
// with backend/metadata_parser.py::MetadataParser.OTHERS_BUNDLE.
const OTHERS_GENERATOR_BUNDLE = [
    'others',
    'fooocus',
    'reforge',
    'easy-diffusion',
    'invokeai',
    'swarmui',
    'drawthings',
    'gemini',
    'gpt-image'
];

const ALL_GENERATORS = [...PRIMARY_GENERATORS, ...OTHERS_GENERATOR_BUNDLE];

function formatGeneratorLabel(generator, fallbackUnknown = 'Unknown') {
    const normalized = String(generator || 'unknown').trim().toLowerCase();
    const keyMap = {
        all: 'generator.all',
        nai: 'generator.nai',
        comfyui: 'generator.comfyui',
        forge: 'generator.forge',
        webui: 'generator.webui',
        reforge: 'generator.reforge',
        fooocus: 'generator.fooocus',
        'easy-diffusion': 'generator.easyDiffusion',
        invokeai: 'generator.invokeai',
        swarmui: 'generator.swarmui',
        drawthings: 'generator.drawthings',
        gemini: 'generator.gemini',
        'gpt-image': 'generator.gptImage',
        others: 'generator.others',
        unknown: 'generator.unknown'
    };
    const translationKey = keyMap[normalized];
    if (translationKey) {
        return appT(translationKey, normalized === 'unknown' ? fallbackUnknown : normalized);
    }
    return String(generator || appT('generator.unknown', fallbackUnknown));
}

// ============== Request Manager (Cancellation Support) ==============
// Owned by modules/core/request-manager.js (loaded before this file);
// bare `RequestManager` references resolve to that global.

const GALLERY_VIEW_MODE_KEY = 'gallery-view-mode';
const FILTER_STATE_KEY = 'sd-image-sorter-filter-state';
const SCAN_ADVANCED_OPEN_KEY = 'sd-image-sorter-scan-advanced-open';
const TAG_ADVANCED_OPEN_KEY = 'sd-image-sorter-tag-advanced-open';
const UI_SCALE_STORAGE_KEY = 'ui_scale_v1';
const TAGGER_DEFAULTS_STORAGE_KEY = 'sd-image-sorter-tagger-defaults-v1';
const ARTIST_DEFAULTS_STORAGE_KEY = 'sd-image-sorter-artist-defaults-v1';
const FILTERED_SELECTION_CONFIRM_THRESHOLD = 10000;
const FILTERED_SELECTION_CHUNK_SIZE = 2000;
const EXPORT_PREVIEW_MAX_IMAGES = 2000;
const EXPORT_PREVIEW_MAX_CHARS = 200000;
const FACET_SUGGESTION_LIMIT = 24;
const FACET_FILTER_SEARCH_LIMIT = 200;

// Storage helpers (readStoredBoolean / writeStoredBoolean / readStoredJson /
// writeStoredJson / removeStoredKey) are owned by modules/core/storage-utils.js,
// loaded before this file.

function finiteNumberInRange(value, min, max, fallback = null) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    if (numeric < min || numeric > max) return fallback;
    return numeric;
}

function booleanPreference(value, fallback = null) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return fallback;
}

const AppPreferences = {
    keys: {
        uiScale: UI_SCALE_STORAGE_KEY,
        taggerDefaults: TAGGER_DEFAULTS_STORAGE_KEY,
        artistDefaults: ARTIST_DEFAULTS_STORAGE_KEY,
    },

    getUiScaleMode() {
        try {
            const raw = localStorage.getItem(UI_SCALE_STORAGE_KEY);
            return raw || 'auto';
        } catch (error) {
            return 'auto';
        }
    },

    setUiScaleMode(value) {
        const mode = value == null || value === 'auto' ? 'auto' : String(value);
        if (window.UiScale && typeof window.UiScale.set === 'function') {
            window.UiScale.set(mode);
        } else {
            try {
                localStorage.setItem(UI_SCALE_STORAGE_KEY, mode);
            } catch (error) {
                // Ignore localStorage failures.
            }
        }
    },

    getTaggerDefaults() {
        return readStoredJson(TAGGER_DEFAULTS_STORAGE_KEY, null);
    },

    setTaggerDefaults(defaults) {
        const payload = {
            version: 1,
            savedAt: new Date().toISOString(),
            modelName: String(defaults?.modelName || '').trim(),
            threshold: finiteNumberInRange(defaults?.threshold, 0, 1, null),
            characterThreshold: finiteNumberInRange(defaults?.characterThreshold, 0, 1, null),
            useGpu: booleanPreference(defaults?.useGpu, null),
            batchSize: defaults?.batchSize != null ? String(defaults.batchSize) : '',
            customProfile: String(defaults?.customProfile || '').trim(),
            customModelPath: String(defaults?.customModelPath || '').trim(),
            customTagsPath: String(defaults?.customTagsPath || '').trim(),
        };
        return writeStoredJson(TAGGER_DEFAULTS_STORAGE_KEY, payload);
    },

    clearTaggerDefaults() {
        removeStoredKey(TAGGER_DEFAULTS_STORAGE_KEY);
    },

    getArtistDefaults() {
        return readStoredJson(ARTIST_DEFAULTS_STORAGE_KEY, null);
    },

    setArtistDefaults(defaults) {
        const payload = {
            version: 1,
            savedAt: new Date().toISOString(),
            modelSource: String(defaults?.modelSource || 'huggingface').trim() || 'huggingface',
            modelPath: String(defaults?.modelPath || '').trim(),
            threshold: finiteNumberInRange(defaults?.threshold, 0, 0.25, 0.03),
            useGpu: booleanPreference(defaults?.useGpu, true),
        };
        return writeStoredJson(ARTIST_DEFAULTS_STORAGE_KEY, payload);
    },

    clearArtistDefaults() {
        removeStoredKey(ARTIST_DEFAULTS_STORAGE_KEY);
    },

    clearAiDefaults() {
        this.clearTaggerDefaults();
        this.clearArtistDefaults();
    },
};

function getDefaultGalleryPageSize(mode = null) {
    const resolvedMode = mode || localStorage.getItem(GALLERY_VIEW_MODE_KEY) || 'grid';
    const viewportWidth = window.innerWidth || 1600;

    if (resolvedMode === 'large') {
        if (viewportWidth >= 1800) return 220;
        if (viewportWidth >= 1366) return 180;
        return 140;
    }

    if (resolvedMode === 'waterfall') {
        if (viewportWidth >= 1800) return 260;
        if (viewportWidth >= 1366) return 220;
        return 180;
    }

    if (viewportWidth >= 1800) return 420;
    if (viewportWidth >= 1366) return 320;
    return 240;
}

