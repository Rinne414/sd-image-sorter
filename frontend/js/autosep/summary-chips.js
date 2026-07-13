/**
 * autosep/summary-chips.js — autosep.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/autosep.js, pre-split
 * lines 899-1037 + 1465-1466: the filter-active/clear/open-modal/chip
 * helpers and updateAutoSepSummary (strips each data-i18n so a later
 * languageChanged applyToDOM can't reset the JS-owned scope spans) with
 * its window publish (each publish stays in the file that declares its
 * function). Classic script: loads after autosep/state-constants.js (base).
 */
// ============== Update Summary Display ==============

function _isAutoSepFilterActive(field, filters) {
    const allGens = ['comfyui', 'nai', 'webui', 'forge', 'unknown'];
    const allRatings = ['general', 'sensitive', 'questionable', 'explicit'];
    switch (field) {
        case 'generators': return Array.isArray(filters.generators) && filters.generators.length > 0 && filters.generators.length < allGens.length;
        case 'ratings': return Array.isArray(filters.ratings) && filters.ratings.length > 0 && filters.ratings.length < allRatings.length;
        case 'tags': return Array.isArray(filters.tags) && filters.tags.length > 0;
        case 'checkpoints': return Array.isArray(filters.checkpoints) && filters.checkpoints.length > 0;
        case 'loras': return Array.isArray(filters.loras) && filters.loras.length > 0;
        case 'prompts': return Array.isArray(filters.prompts) && filters.prompts.length > 0;
        case 'search': return Boolean(filters.search && String(filters.search).trim());
        case 'dimensions': return Boolean(filters.minWidth || filters.maxWidth || filters.minHeight || filters.maxHeight || filters.aspectRatio);
        default: return false;
    }
}

function _clearAutoSepFilterField(field) {
    const filters = getAutoSepFilters();
    const allGens = ['comfyui', 'nai', 'webui', 'forge', 'unknown'];
    const allRatings = ['general', 'sensitive', 'questionable', 'explicit'];
    switch (field) {
        case 'generators': filters.generators = [...allGens]; filters.excludeGenerators = []; break;
        case 'ratings': filters.ratings = [...allRatings]; filters.excludeRatings = []; break;
        case 'tags': filters.tags = []; filters.excludeTags = []; break;
        case 'checkpoints': filters.checkpoints = []; filters.excludeCheckpoints = []; break;
        case 'loras': filters.loras = []; filters.excludeLoras = []; break;
        case 'prompts': filters.prompts = []; break;
        case 'search': filters.search = ''; break;
        case 'dimensions': filters.minWidth = null; filters.maxWidth = null; filters.minHeight = null; filters.maxHeight = null; filters.aspectRatio = ''; break;
    }
    setAutoSepFilters(filters);
    markAutoSepScopeCustomized();
    updateAutoSepSummary();
    renderAutoSepConfigControls();
    clearTimeout(_autosepPreviewTimer);
    _autosepPreviewTimer = setTimeout(() => {
        invalidateAutoSepPreview();
    }, 350);
}

function _openAutoSepFilterModalForField() {
    if (!window.App || !window.App.openFilterModal) return;
    window.App.openFilterModal({
        mode: 'auto-separate',
        titleText: tKey('autosep.filterTitle', 'Auto-Separate Filters', '自动分类筛选'),
        applyButtonText: tKey('autosep.applyFilters', 'Apply to Auto-Separate', '应用到自动分类'),
        resetButtonText: tKey('autosep.resetFilters', 'Reset Auto-Separate Filters', '重置自动分类筛选'),
        filterState: getAutoSepFilters(),
        onApply: (f) => {
            setAutoSepFilters(f);
            markAutoSepScopeCustomized();
            updateAutoSepSummary();
            invalidateAutoSepPreview();
            renderAutoSepConfigControls();
        },
        onReset: (f) => {
            setAutoSepFilters(f);
            markAutoSepScopeCustomized();
            updateAutoSepSummary();
            invalidateAutoSepPreview();
            renderAutoSepConfigControls();
        },
    });
}

function _applyAutoSepChip(el, field, filters) {
    const active = _isAutoSepFilterActive(field, filters);
    const parent = el.closest('.summary-item');
    if (!parent) return;

    // Remove old chip wrappers if any
    parent.querySelectorAll('.autosep-chip-btn').forEach(b => b.remove());

    if (active) {
        parent.classList.add('autosep-filter-chip-active');
        parent.classList.remove('autosep-filter-chip-add');
        // Clear button
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'autosep-chip-btn autosep-filter-chip-clear';
        clearBtn.title = 'Clear';
        clearBtn.textContent = '\u00d7';
        clearBtn.addEventListener('click', (e) => { e.stopPropagation(); _clearAutoSepFilterField(field); });
        parent.appendChild(clearBtn);
        // Click label/value to open modal
        parent.style.cursor = 'pointer';
        parent.onclick = (e) => { if (!e.target.closest('.autosep-filter-chip-clear')) _openAutoSepFilterModalForField(); };
    } else {
        parent.classList.remove('autosep-filter-chip-active');
        parent.classList.add('autosep-filter-chip-add');
        // Add '+' button
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'autosep-chip-btn autosep-filter-chip-add-icon';
        addBtn.title = 'Add filter';
        addBtn.textContent = '+';
        addBtn.addEventListener('click', (e) => { e.stopPropagation(); _openAutoSepFilterModalForField(); });
        parent.appendChild(addBtn);
        parent.style.cursor = '';
        parent.onclick = null;
    }
}

function updateAutoSepSummary() {
    const { $ } = window.App;
    const filters = getAutoSepFilters();
    if (!filters) return;

    const summary = window.formatFilterSummary(filters);

    const fields = [
        { id: '#autosep-summary-generators', key: 'generators', field: 'generators' },
        { id: '#autosep-summary-tags', key: 'tags', field: 'tags' },
        { id: '#autosep-summary-ratings', key: 'ratings', field: 'ratings' },
        { id: '#autosep-summary-checkpoints', key: 'checkpoints', field: 'checkpoints' },
        { id: '#autosep-summary-loras', key: 'loras', field: 'loras' },
        { id: '#autosep-summary-prompts', key: 'prompts', field: 'prompts' },
        { id: '#autosep-summary-search', key: 'search', field: 'search' },
        { id: '#autosep-summary-dimensions', key: 'dimensions', field: 'dimensions' },
    ];

    for (const { id, key, field } of fields) {
        const el = $(id);
        if (!el) continue;
        // Strip the data-i18n default so a later I18n.applyToDOM (languageChanged)
        // cannot reset this JS-owned scope value back to "All"/"None". The value
        // is already localized by formatFilterSummary. Matches the gallery
        // sidebar / manual-sort summary writers.
        el.removeAttribute('data-i18n');
        el.textContent = summary[key];
        _applyAutoSepChip(el, field, filters);
    }

    updateAutoSepScopeStatus();
    updateAutoSepPreviewScopeSummary();
}

// Export for use by app.js filter modal
window.updateAutoSepSummary = updateAutoSepSummary;
