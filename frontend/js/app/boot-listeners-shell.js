/**
 * App boot listeners, part 1 (shell): nav tabs/tools, scan + reconnect
 * modals, tagging modal + tagger model wiring, aesthetic + update
 * buttons, modal backdrops. Body moved VERBATIM from app.js
 * initEventListeners (lines 19-480 of the post-stage-5 file); split at
 * a machine-verified boundary no function-local crosses. Registration
 * order is load-bearing: this binder runs before the gallery binder.
 */
function initBootListenersShell() {
    // Nav tabs. Tools-menu entries that open modals (Duplicate Cleanup,
    // Publish Set) are .nav-tab for styling but carry no data-view —
    // switchView(undefined) would hide every view and leave a black screen.
    $$('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.dataset.view) switchView(tab.dataset.view);
        });
    });
    setupNavToolsMenu();

    // MODELS-08: reusable "Which should I pick?" affordance. Any element with
    // data-action="open-model-guidance" opens the (now essentials-first) Model
    // Manager, the canonical place that compares models and flags the
    // recommended ones. Delegated so it works for every current/future picker.
    document.addEventListener('click', (e) => {
        const trigger = e.target.closest('[data-action="open-model-guidance"]');
        if (!trigger) return;
        e.preventDefault();
        openModelManager('models');
    });

    // Scan button
    $('#btn-scan').addEventListener('click', () => showModal('scan-modal'));
    $('#btn-browse-folder')?.addEventListener('click', () => {
        const input = $('#scan-folder-path');
        if (input && typeof window.showFolderBrowser === 'function') {
            window.showFolderBrowser(input);
        }
    });

    $('#btn-reconnect-missing')?.addEventListener('click', () => showModal('reconnect-modal'));
    $('#btn-browse-reconnect-folder')?.addEventListener('click', () => {
        const input = $('#reconnect-folder-path');
        if (input && typeof window.showFolderBrowser === 'function') {
            window.showFolderBrowser(input);
        }
    });

    // Tag button
    $('#btn-tag').addEventListener('click', () => showModal('tag-modal'));
    $('#btn-score-aesthetic')?.addEventListener('click', async () => {
        await refreshAestheticStatus();
        await startAestheticScoring(false);
    });
    $('#btn-cancel-aesthetic')?.addEventListener('click', async () => {
        try {
            await API.cancelAesthetic();
            // Don't wait ~1.2s for the next poll tick to clear local state.
            // Without this, the busy guard on #btn-clear-db (and related
            // "is something running" checks elsewhere) will keep blocking
            // user input for the full polling interval after cancel returns.
            clearAestheticProgressTimer();
            updateAestheticUi({ running: false, completed: 0, total: 0 });
            showToast(appT('gallery.aestheticCancelled', 'Aesthetic scoring is being stopped...'), 'info');
        } catch (error) {
            showToast(formatUserError(error, 'Failed to cancel'), 'error');
        }
    });
    $('#btn-app-update')?.addEventListener('click', () => {
        void handleAppUpdateButtonClick();
    });
    $('#mobile-btn-app-update')?.addEventListener('click', () => {
        closeMobileMenu();
        void handleAppUpdateButtonClick();
    });

    // Modal backdrops
    $$('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('click', () => {
            const modal = backdrop.parentElement;
            // For tag-modal, use cancelTagging logic to minimize to background
            if (modal && modal.id === 'tag-modal') {
                minimizeTaggingToBackground();
                return;
            }
            if (modal && modal.id === 'filter-modal') {
                closeFilterModal();
                return;
            }
            if (modal && modal.id === 'tags-library-modal') {
                finishTagsLibraryInteraction();
                return;
            }
            if (modal) hideModal(modal.id);
        });
    });

    // Scan modal
    $('#btn-cancel-scan').addEventListener('click', requestStopScan);
    $('#btn-start-scan').addEventListener('click', startScan);
    $('#btn-copy-scan-diagnostics')?.addEventListener('click', copyScanDiagnostics);
    $('#btn-open-scan-log')?.addEventListener('click', openScanLogFile);
    $('#btn-copy-scan-log-path')?.addEventListener('click', copyScanLogPath);
    $('#btn-stop-scan-from-diagnostics')?.addEventListener('click', requestStopScan);
    $('#btn-cancel-reconnect')?.addEventListener('click', requestStopReconnectMissing);
    $('#btn-start-reconnect')?.addEventListener('click', startReconnectMissing);

    // Tag modal X close button — minimize to background if tagging
    $('#btn-close-tag-modal')?.addEventListener('click', () => minimizeTaggingToBackground());
    // UI-02: Inline validation for scan folder path
    const scanFolderPathInput = $('#scan-folder-path');
    if (scanFolderPathInput) {
        const debouncedValidation = debounce(validateScanFolderPath, 300);
        scanFolderPathInput.addEventListener('input', debouncedValidation);
        scanFolderPathInput.addEventListener('blur', validateScanFolderPath);
    }
    const reconnectFolderPathInput = $('#reconnect-folder-path');
    if (reconnectFolderPathInput) {
        const debouncedReconnectValidation = debounce(validateReconnectFolderPath, 300);
        reconnectFolderPathInput.addEventListener('input', debouncedReconnectValidation);
        reconnectFolderPathInput.addEventListener('blur', validateReconnectFolderPath);
    }

    // Tag modal
    $('#btn-cancel-tag').addEventListener('click', minimizeTaggingToBackground);
    $('#btn-start-tag').addEventListener('click', startTagging);
    $('#btn-export-tags-json')?.addEventListener('click', exportTagLibraryJson);

    // Tag threshold sliders
    $('#tag-threshold').addEventListener('input', (e) => {
        e.target.dataset.userChosen = '1';
        $('#tag-threshold-value').textContent = e.target.value;
        syncTagAdvancedUi();
        persistTaggerDefaultsFromDom();
    });
    $('#tag-character-threshold').addEventListener('input', (e) => {
        e.target.dataset.userChosen = '1';
        $('#tag-character-threshold-value').textContent = e.target.value;
        syncTagAdvancedUi();
        persistTaggerDefaultsFromDom();
    });
    $('#tag-retag-all')?.addEventListener('change', () => syncTagAdvancedUi());

    // Model selection toggle for custom model
    $('#tag-model-select').addEventListener('change', () => {
        delete $('#tag-use-gpu')?.dataset.userChosen;
        syncTaggerModelUi({ applyModelDefaults: true, toastOnAutoSafe: true });
        persistTaggerDefaultsFromDom();
    });
    $('#tag-custom-profile-select')?.addEventListener('change', () => {
        delete $('#tag-use-gpu')?.dataset.userChosen;
        syncTaggerModelUi({ applyModelDefaults: true, toastOnAutoSafe: true });
        syncTagAdvancedUi();
        persistTaggerDefaultsFromDom();
    });
    ['tag-model-path', 'tag-tags-path'].forEach((id) => {
        document.getElementById(id)?.addEventListener('input', () => persistTaggerDefaultsFromDom());
    });
    $('#tag-use-gpu')?.addEventListener('change', () => {
        $('#tag-use-gpu').dataset.userChosen = '1';
        syncTaggerModelUi({ applyModelDefaults: false });
        persistTaggerDefaultsFromDom();
    });
    $('#tagger-batch-size')?.addEventListener('change', (event) => {
        event.target.dataset.userChosen = '1';
        syncTaggerModelUi({ applyModelDefaults: false });
        persistTaggerDefaultsFromDom();
    });
    $('#scan-advanced-options')?.addEventListener('toggle', (event) => {
        writeStoredBoolean(SCAN_ADVANCED_OPEN_KEY, Boolean(event.currentTarget?.open));
    });
    $('#tag-advanced-options')?.addEventListener('toggle', (event) => {
        writeStoredBoolean(TAG_ADVANCED_OPEN_KEY, Boolean(event.currentTarget?.open));
    });
    ['scan-force-reparse', 'scan-cleanup-missing', 'scan-auto-tag'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', () => syncScanAdvancedUi());
    });
    syncScanAdvancedUi({ resetToPreference: true });
    syncTaggerModelUi({ applyModelDefaults: true });

    // Image modal
    $('#modal-close').addEventListener('click', () => hideModal('image-modal'));

    // Clear all filters button (sidebar)
    $('#btn-clear-filters').addEventListener('click', () => {
        resetAllFilters();
        hideModal('filter-modal');  // In case it's open
    });

    // View mode buttons
    $$('.view-btn[data-size]').forEach(btn => {
        btn.addEventListener('click', () => {
            setGalleryViewMode(btn.dataset.size);
        });
    });

    // Grid size slider control
    const gridSizeSlider = $('#grid-size-slider');
    const gridSizeDecrease = $('#grid-size-decrease');
    const gridSizeIncrease = $('#grid-size-increase');
    const galleryGrid = $('#gallery-grid');

    if (gridSizeSlider && galleryGrid) {
        // Load saved grid size from localStorage
        const GRID_SIZE_KEY = 'sd-sorter:grid-size';
        const savedSize = localStorage.getItem(GRID_SIZE_KEY);
        if (savedSize) {
            gridSizeSlider.value = savedSize;
            galleryGrid.style.setProperty('--grid-item-size', `${savedSize}px`);
            galleryGrid.style.setProperty('--waterfall-column-width', `${savedSize}px`);
        }

        // Update grid size function
        function updateGridSize(size) {
            const clampedSize = Math.max(120, Math.min(400, size));
            gridSizeSlider.value = clampedSize;
            galleryGrid.style.setProperty('--grid-item-size', `${clampedSize}px`);
            galleryGrid.style.setProperty('--waterfall-column-width', `${clampedSize}px`);
            localStorage.setItem(GRID_SIZE_KEY, clampedSize);
            // CSS vars only drive the small-gallery (non-virtual) grid; the
            // virtual list needs the same value pushed into its layout config.
            window.Gallery?.setThumbnailSize?.(clampedSize);
        }

        // Slider input event
        gridSizeSlider.addEventListener('input', (e) => {
            updateGridSize(parseInt(e.target.value, 10));
        });

        // Decrease button
        if (gridSizeDecrease) {
            gridSizeDecrease.addEventListener('click', () => {
                const currentSize = parseInt(gridSizeSlider.value, 10);
                updateGridSize(currentSize - 20);
            });
        }

        // Increase button
        if (gridSizeIncrease) {
            gridSizeIncrease.addEventListener('click', () => {
                const currentSize = parseInt(gridSizeSlider.value, 10);
                updateGridSize(currentSize + 20);
            });
        }

        // Keyboard shortcuts [ / ] step the SAME px value as the slider.
        // (Aurora Phase 3: previously these stepped a separate per-mode size
        // array with its own localStorage key, so keyboard and slider fought
        // over --grid-item-size and never agreed after a reload.)
        document.addEventListener('keydown', (e) => {
            const activeEl = document.activeElement;
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
                return;
            }
            const modalOpen = document.querySelector('.modal.show, [role="dialog"][style*="display: block"]');
            if (modalOpen) return;

            if (e.key === '[' || e.key === ']') {
                e.preventDefault();
                const currentSize = parseInt(gridSizeSlider.value, 10) || 200;
                updateGridSize(e.key === '[' ? currentSize - 20 : currentSize + 20);
                showToast(
                    e.key === '['
                        ? appT('gallery.thumbnailSizeDecreased', 'Thumbnail size decreased')
                        : appT('gallery.thumbnailSizeIncreased', 'Thumbnail size increased'),
                    'info'
                );
            }
        });
    }

    // Gallery-header aspect quick-toggle (FE-7). Drives the SAME FilterStore
    // `aspectRatio` field as the filter modal's aspect radios — no parallel
    // state. Clicking writes through updateAppFilters, then syncs the modal
    // radios, the sidebar summary, this toggle, and reloads the gallery.
    $$('.aspect-quick-btn[data-aspect]').forEach(btn => {
        btn.addEventListener('click', () => {
            const value = normalizeAspectRatioFilter(btn.dataset.aspect);
            updateAppFilters((filters) => {
                filters.aspectRatio = value;
            });
            // Keep the modal's aspect radios in sync with the quick-toggle.
            $$('input[name="aspect-ratio"]').forEach(radio => {
                radio.checked = radio.value === value;
            });
            updateFilterSummary();
            syncAspectToggleWithFilters();
            loadImages();
        });
    });

    // --- New Features ---

    // Generator quick-filter tabs
    $$('.gen-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            // Update active state
            $$('.gen-tab').forEach(t => {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            });
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');

            const gen = tab.dataset.gen;
            if (gen === 'all') {
                // Reset to show all generators
                updateAppFilters((filters) => {
                    filters.generators = [...ALL_GENERATORS];
                });
            } else if (gen === 'others') {
                // Bundle of less common generators — Fooocus, reForge,
                // Gemini, gpt-image, etc. Each is still individually
                // filterable via the Filter Criteria modal.
                updateAppFilters((filters) => {
                    filters.generators = [...OTHERS_GENERATOR_BUNDLE];
                });
            } else {
                // Filter by single generator
                updateAppFilters((filters) => {
                    filters.generators = [gen];
                });
            }

            // Update filter modal checkboxes to stay in sync
            $$('#modal-generator-filters input').forEach(cb => {
                if (gen === 'all') {
                    cb.checked = true;
                } else if (gen === 'others') {
                    cb.checked = OTHERS_GENERATOR_BUNDLE.includes(cb.value);
                } else {
                    cb.checked = cb.value === gen;
                }
            });

            updateFilterSummary();
            tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
            syncGeneratorRailOverflow();
            loadImages();
        });
    });

    const generatorScroller = document.getElementById('generator-tabs-scroll');
    if (generatorScroller && generatorScroller.dataset.overflowBound !== '1') {
        generatorScroller.dataset.overflowBound = '1';
        generatorScroller.addEventListener('scroll', syncGeneratorRailOverflow, { passive: true });
    }

    // Gallery sort dropdown
    $('#gallery-sort').addEventListener('change', (e) => {
        updateAppFilters((filters) => {
            filters.sortBy = e.target.value;
        });
        if (AppState.filters.sortBy === 'aesthetic') {
            const hasExistingScores = Number(_aestheticStatus.scored_count || 0) > 0;
            if (!_aestheticStatus.available && !hasExistingScores) {
                // Predictor missing AND no scores in DB — there is literally
                // nothing to sort by, so push the user back to newest and
                // explain why.
                showToast(_aestheticStatus.message || appT('gallery.aestheticUnavailable', 'Aesthetic scoring is unavailable — required dependencies not installed'), 'warning');
                e.target.value = 'newest';
                updateAppFilters((filters) => {
                    filters.sortBy = 'newest';
                });
            } else if (!_aestheticStatus.available && hasExistingScores) {
                // Predictor missing but scores exist from a previous run —
                // sorting still works, just no NEW scoring. Inform the user
                // so they don't think the data is gone.
                showToast(appT('gallery.aestheticViewExistingOnly', 'Showing your {count} existing aesthetic scores. New scoring is unavailable until the predictor is reinstalled.', { count: _aestheticStatus.scored_count }), 'info');
            } else if (_aestheticStatus.scored_count === 0) {
                showToast(appT('gallery.aestheticNeedScoring', 'No images have been scored yet. Open AI Tag Images and run Score Aesthetic first.'), 'info');
            }
        }
        updateSortReverseButton();
        loadImages();
    });

    $('#btn-open-model-manager')?.addEventListener('click', openModelManager);
    $('#model-manager-close')?.addEventListener('click', () => hideModal('model-manager-modal'));
    initSettingsControls();

    // Sort reverse button
    $('#sort-reverse-btn').addEventListener('click', () => {
        const current = AppState.filters.sortBy;
        const reversed = SORT_REVERSE_MAP[current];
        if (reversed && reversed !== current) {
            updateAppFilters((filters) => {
                filters.sortBy = reversed;
            });
            updateSortReverseButton();
            loadImages();
        }
    });




    // Clear DB button
    $('#btn-clear-db').addEventListener('click', async () => {
        // Belt-and-braces: check local poll-state first, then verify
        // against ALL THREE backend progress endpoints. Local state can
        // lag (e.g. if a poll callback never runs after cancel), so the
        // server is the source of truth.
        //
        // Note: scan polling does NOT use a stored timer handle — it uses
        // a `_scanProgressTracker` object plus bare `setTimeout` calls.
        // Earlier revisions of this guard referenced a `_scanProgressTimer`
        // that was never declared, so any path through this branch threw
        // `ReferenceError: _scanProgressTimer is not defined` and broke
        // the Clear DB button entirely. The local check now uses the
        // tracker's `startedAt` instead.
        const BUSY_STATUSES = new Set(['running', 'cancelling', 'starting']);
        const isProgressBusy = (value) => {
            if (!value) return false;
            if (BUSY_STATUSES.has(value.status)) return true;
            if (value.running) return true;
            return false;
        };
        let busy = Boolean(_aestheticProgressTimer || _tagProgressTimer || _scanProgressTracker?.startedAt);
        if (!busy) {
            const [scanResult, tagResult, aestheticResult] = await Promise.allSettled([
                API.getScanProgress(),
                API.getTagProgress(),
                API.getAestheticProgress(),
            ]);
            const probes = [
                ['scan', scanResult],
                ['tag', tagResult],
                ['aesthetic', aestheticResult],
            ];
            for (const [label, result] of probes) {
                if (result.status === 'fulfilled') {
                    if (isProgressBusy(result.value)) {
                        busy = true;
                    }
                } else {
                    Logger.warn(`Clear gallery: ${label} progress probe failed, assuming idle:`, result.reason);
                }
            }
        }
        if (busy) {
            Logger.warn('Clear gallery blocked: a background job is still active', {
                aestheticTimer: !!_aestheticProgressTimer,
                scanTracker: Boolean(_scanProgressTracker?.startedAt),
                tagTimer: !!_tagProgressTimer,
            });
            showToast(appT('gallery.clearBlocked', 'Cannot clear gallery while scanning, tagging, or scoring is running. Stop the operation first.'), 'warning');
            return;
        }
        showConfirm(
            appT('gallery.clearTitle', 'Clear Gallery'),
            appT('gallery.clearMessage', 'Are you sure you want to clear all images from the database? This will NOT delete your physical files.'),
            async () => {
                try {
                    await API.clearGallery();
                    showToast(appT('gallery.clearSuccess', 'Gallery cleared successfully'));
                    loadImages();
                    loadStats();
                    // The "N images can't open" banner reads a 60s-cached
                    // library-health count. Clearing emptied the library, so drop
                    // the cache and force an immediate recheck — otherwise the
                    // stale count lingers until the TTL lapses (it looked
                    // permanent because nothing re-polled after a clear).
                    window.UnreadableBanner?.invalidate?.();
                    window.UnreadableBanner?.refresh?.(true);
                } catch (e) {
                    showToast(formatUserError(e, appT('gallery.clearFailed', 'Failed to clear gallery')), "error");
                }
            }
        );
    });

}
