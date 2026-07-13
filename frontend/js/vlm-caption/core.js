/**
 * vlm-caption/core.js — vlm-caption.js decomposition (family base; MUST LOAD FIRST).
 * Moved BYTE-IDENTICAL from frontend/js/vlm-caption.js pre-cut lines 1-18 +
 * 1054-1068 + 1072-1073 (of 1,073): the file header, `const VLMCaption = {` +
 * every top state field (isRunning, _startInFlight, pollInterval, settings,
 * lastProgress, lastFailedImageIds), tText, _showStatus, the _setVal /
 * _getVal / _setChecked / _getChecked / _t micro-helpers, the object-literal
 * `};` closer and the `window.VLMCaption = VLMCaption;` publish. The publish
 * (pre-cut EOF tail) is hoisted into this file so every later family file can
 * Object.assign(window.VLMCaption, ...) onto it — a parse-time reorder only:
 * nothing reads window.VLMCaption synchronously during parse, and the
 * DOMContentLoaded boot still registers after the whole family loads
 * (vlm-caption/boot.js, LAST). The mid-literal _pullPollInterval data prop
 * (pre-cut line 770) travels with its pull-polling family in
 * connection-models.js instead of this state block (pinned shape). Declares
 * the ONE unsealed object the rest of the family joins. No 'use strict'
 * anywhere in the family: the original was a non-strict classic script
 * (artist/similar precedent); the bare `escapeHtml` global
 * (app/constants-prefs.js) resolves via the shared classic-script scope, and
 * `VLMCaption` stays a script-global const other family files (boot.js)
 * reference directly.
 */
/**
 * SD Image Sorter - VLM Captioning Module
 * Natural language captioning via Vision Language Models (Ollama, OpenAI, Anthropic, Gemini).
 */

const VLMCaption = {
    isRunning: false,
    // True while a start request is awaiting its response (double-click guard).
    _startInFlight: false,
    pollInterval: null,
    settings: {},
    lastProgress: null,
    lastFailedImageIds: [],

    tText(en, zh) {
        return window.I18n?.getLang?.() === 'zh-CN' ? zh : en;
    },

    _showStatus(elId, message, type) {
        const el = document.getElementById(elId);
        if (!el) return;
        el.textContent = message;
        el.className = `vlm-status vlm-status-${type}`;
        el.style.display = 'block';
    },

    _setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; },
    _getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; },
    _setChecked(id, val) { const el = document.getElementById(id); if (el) el.checked = !!val; },
    _getChecked(id) { const el = document.getElementById(id); return el ? el.checked : false; },
    _t(key, fallback) { const v = window.I18n?.t?.(key); return (v && v !== key) ? v : fallback; },
};

// Expose globally so other modules (e.g., v321-ui) can call methods like openSettingsModal()
window.VLMCaption = VLMCaption;
