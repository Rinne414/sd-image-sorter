/**
 * app/filter-summary.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 9479-9633 (of 10,152): missing-markup init, saved filter state, filter summary.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
function initMissingFilterMarkup() {
    const generatorSection = document.getElementById('modal-generator-filters');
    if (generatorSection && !document.getElementById('modal-rating-filters')) {
        const ratingSection = document.createElement('div');
        ratingSection.className = 'filter-section';
        ratingSection.innerHTML = `
            <h4>Ratings</h4>
            <div class="filter-options" id="modal-rating-filters">
                <label class="checkbox-label"><input type="checkbox" value="general" checked><span class="checkbox-custom"></span><span class="checkbox-text">General</span></label>
                <label class="checkbox-label"><input type="checkbox" value="sensitive" checked><span class="checkbox-custom"></span><span class="checkbox-text">Sensitive</span></label>
                <label class="checkbox-label"><input type="checkbox" value="questionable" checked><span class="checkbox-custom"></span><span class="checkbox-text">Questionable</span></label>
                <label class="checkbox-label"><input type="checkbox" value="explicit" checked><span class="checkbox-custom"></span><span class="checkbox-text">Explicit</span></label>
            </div>
        `;
        generatorSection.parentElement.insertBefore(ratingSection, generatorSection.nextElementSibling);
    }
}

// Clear only the artist filter
function clearArtistFilter() {
    updateAppFilters((filters) => {
        filters.artist = null;
    });
    const artistRow = $('#artist-filter-row');
    if (artistRow) artistRow.style.display = 'none';
    updateFilterSummary();
    loadImages();
    showToast(appT('filter.artistCleared', 'Artist filter cleared'), 'info');
}

// Save filter state to localStorage
function saveFilterState() {
    try {
        const stateToSave = {
            ...cloneFilterState(AppState.filters),
            promptMatchMode: normalizePromptMatchMode(AppState.filters.promptMatchMode),
        };
        localStorage.setItem(FILTER_STATE_KEY, JSON.stringify(stateToSave));
    } catch (e) {
        Logger.warn('Failed to save filter state:', e);
    }
}

/**
 * Wire gallery sidebar filter-summary rows as deep-link chips into the
 * filter modal (B2). Clicking "模型" opens the modal scrolled to checkpoints
 * so users stop confusing the read-only summary with dead text / prompt chips.
 * Idempotent — safe to call from updateFilterSummary repeatedly.
 */
function ensureFilterSummaryDeepLinks() {
    const host = document.getElementById('filter-summary');
    if (!host || host.dataset.deepLinksBound === '1') return;
    host.dataset.deepLinksBound = '1';

    host.querySelectorAll('.summary-row[data-filter-field]').forEach((row) => {
        row.classList.add('filter-summary-chip');
        if (!row.hasAttribute('role')) row.setAttribute('role', 'button');
        if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '0');
        const field = row.getAttribute('data-filter-field');
        const open = (event) => {
            if (event.target.closest('.btn-clear-filter, button')) return;
            event.preventDefault();
            if (typeof openFilterModal === 'function') {
                openFilterModal({ focusField: field });
            }
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                open(event);
            }
        });
    });
}

function updateFilterSummary() {
    // Save filter state whenever summary is updated
    saveFilterState();
    ensureFilterSummaryDeepLinks();

    const f = AppState.filters;

    // Aurora Phase 3: keep the toolbar quick chips in step with the store,
    // whatever surface changed it (modal, chips, summary ✕, Clear all).
    if (window.GalleryToolbar) {
        window.GalleryToolbar.syncFromFilters(f);
    }

    // Use shared filter summary formatter for common fields
    const summary = window.formatFilterSummary(f);

    // These summary values are JS-owned (formatFilterSummary already localizes
    // every default via I18n.t). The spans ship a data-i18n default so the
    // pre-JS render is translated, but once we write a real scope value the
    // attribute MUST be stripped — otherwise the next I18n.applyToDOM (fires on
    // languageChanged) resets the span to "All"/"None" and the sidebar lies
    // about the active filter on a destructive mass-move surface. See §filter.
    const setSummary = (id, value) => {
        const el = $(id);
        if (!el) return;
        el.removeAttribute('data-i18n');
        el.textContent = value;
    };

    setSummary('#summary-generators', summary.generators);
    setSummary('#summary-ratings', summary.ratings);
    setSummary('#summary-tags', summary.tags);
    setSummary('#summary-checkpoints', summary.checkpoints);
    setSummary('#summary-loras', summary.loras);
    setSummary('#summary-prompt', summary.prompts);
    setSummary('#summary-search', summary.search);
    setSummary('#summary-colors', summary.colors || appT('filter.any', 'Any'));

    // Mark active rows so the chip affordance is obvious when a filter is set.
    const activeByField = {
        generators: Array.isArray(f.generators) && Array.isArray(ALL_GENERATORS)
            && f.generators.length > 0 && f.generators.length < ALL_GENERATORS.length,
        ratings: Array.isArray(f.ratings) && f.ratings.length > 0 && f.ratings.length < 4,
        tags: Array.isArray(f.tags) && f.tags.length > 0,
        checkpoints: Array.isArray(f.checkpoints) && f.checkpoints.length > 0,
        loras: Array.isArray(f.loras) && f.loras.length > 0,
        prompts: Array.isArray(f.prompts) && f.prompts.length > 0,
        search: Boolean(f.search && String(f.search).trim()),
        colors: Boolean(
            (f.colorHues && f.colorHues.length)
            || (f.excludeColorHues && f.excludeColorHues.length)
            || f.colorTemperature
            || f.brightnessDistribution
            || f.brightnessMin != null
            || f.brightnessMax != null
            || f.minSaturation != null
            || f.maxSaturation != null
        ),
    };
    document.querySelectorAll('#filter-summary .summary-row[data-filter-field]').forEach((row) => {
        const field = row.getAttribute('data-filter-field');
        row.classList.toggle('is-active', Boolean(activeByField[field]));
        row.setAttribute('aria-pressed', activeByField[field] ? 'true' : 'false');
    });

    // Artist filter
    const artistRow = $('#artist-filter-row');
    const artistSummary = $('#summary-artist');
    if (artistRow && artistSummary) {
        if (f.artist) {
            artistRow.style.display = 'flex';
            artistSummary.textContent = summary.artist;
        } else {
            artistRow.style.display = 'none';
        }
    }

    // Update mobile filter badge
    if (typeof updateMobileFilterBadge === 'function') {
        updateMobileFilterBadge();
    }

    const detail = { filters: cloneFilterState(AppState.filters) };
    window.dispatchEvent(new CustomEvent('gallery-filters-changed', { detail }));
    document.dispatchEvent(new CustomEvent('gallery-filters-changed', { detail }));
}

/**
 * Format the gallery image-count label. Hides the backend's -1 "count skipped"
 * sentinel (returned when the expensive COUNT is bypassed for cursor pagination)
 * behind the number of images actually loaded, with a trailing "+" when more
 * pages remain — so the label never reads "-1".
 */
function _galleryCountText() {
    const total = AppState.pagination.total;
    if (typeof total === 'number' && total >= 0) return String(total);
    return String(AppState.images.length) + (AppState.pagination.hasMore ? '+' : '');
}

/**
 * Render the "#image-count" label. Shown vs library-total is rendered as
 * "shown / total" whenever they differ, because the same toolbar also shows
 * the All-generator tab's library total — two different numbers side by side
 * read as a bug. The tooltip names the usual cause (originals not at their
 * recorded location). Called from every place that writes this label:
 * gallery-load.js after a load and refreshLocalizedImageCount on i18n change.
 */
function applyGalleryCountLabel() {
    const imageCount = $('#image-count');
    if (!imageCount) return;

    const shown = _galleryCountText();
    const totalEl = document.getElementById('count-all');
    const libraryTotal = totalEl ? parseInt(totalEl.textContent, 10) : NaN;
    const shownNum = parseInt(shown, 10);

    if (Number.isFinite(libraryTotal) && libraryTotal > 0
            && Number.isFinite(shownNum) && shownNum !== libraryTotal) {
        imageCount.textContent = appT('gallery.imageCountOf', '{count} of {total} images')
            .replace('{count}', shown)
            .replace('{total}', String(libraryTotal));
        const missing = (window.UnreadableBanner && typeof window.UnreadableBanner.getLastCount === 'function')
            ? window.UnreadableBanner.getLastCount()
            : null;
        if (missing > 0) {
            imageCount.title = appT(
                'gallery.imageCountMissingTip',
                '{total} indexed in this library; {missing} originals are not at their recorded location.',
                { total: libraryTotal, missing }
            );
        } else {
            imageCount.removeAttribute('title');
        }
        return;
    }

    imageCount.removeAttribute('title');
    imageCount.textContent = appT('gallery.imageCount', '{count} images')
        .replace('{count}', shown);
}

function refreshLocalizedImageCount() {
    const imageCount = $('#image-count');
    if (!imageCount) return;

    if (AppState.isLoading) {
        imageCount.textContent = appT('gallery.loading', 'Loading images...');
        imageCount.removeAttribute('title');
        return;
    }

    applyGalleryCountLabel();
}

function refreshLocalizedDynamicUi() {
    if (_scanLastProgress) {
        _updateBgScanProgress(_scanLastProgress);
        updateScanDiagnosticsCard(_scanLastProgress);
        const scanCancelButton = $('#btn-cancel-scan');
        if (scanCancelButton?.dataset.liveLabel === '1') {
            setScanCancelButtonState(_scanLastProgress.status === 'cancelling' ? 'cancelling' : 'running');
        }
    }
    refreshLocalizedImageCount();
    updateFilterSummary();
    updateSelectionUI();
    if (typeof window.updateAutoSepSummary === 'function') window.updateAutoSepSummary();
    if (typeof window.updateManualSortFilterSummary === 'function') window.updateManualSortFilterSummary();
    if (AppState.modalSelection.type) {
        const titleEl = $('#model-select-title');
        if (titleEl) {
            titleEl.textContent = AppState.modalSelection.type === 'checkpoint'
                ? appT('modelSelect.checkpointsTitle', 'Select Models')
                : appT('modelSelect.lorasTitle', 'Select LoRAs');
        }
        renderModelSelectList();
    }
    refreshAestheticUi();
    syncTaggerModelUi({ applyModelDefaults: false });
    window.Gallery?.refreshLocalizedContent?.();
}

