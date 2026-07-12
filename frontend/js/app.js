/**
 * SD Image Sorter - Main Application
 * Core app logic and API communication
 */

// ============== Event Listeners ==============

function initEventListeners() {
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
        document.getElementById('btn-open-model-manager')?.click();
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

    // Random button
    $('#btn-random').addEventListener('click', showRandomImage);

    // Multi-select toggle
    $('#btn-toggle-select').addEventListener('click', () => {
        setSelectionMode(!AppState.selectionMode);
    });

    // Export selected
    $('#btn-export-selected').addEventListener('click', () => {
        resetSelectionDataCache();
        showExportModal();
    });

    // Clear selection
    $('#btn-clear-selection').addEventListener('click', () => {
        if (window.Gallery && typeof Gallery.clearSelection === 'function') {
            Gallery.clearSelection();
        } else {
            clearSelectedIds({ scope: 'visible' });
            updateSelectionUI();
            emitSelectionStateChanged();
        }
    });

    // Selection scope actions
    $('#btn-select-all')?.addEventListener('click', () => {
        selectAllFilteredResults();
    });

    $('#btn-invert-selection-filtered')?.addEventListener('click', () => {
        invertAllFilteredResults();
    });

    $('#btn-move-selected')?.addEventListener('click', () => moveOrCopySelectedGalleryImages('move'));
    $('#btn-copy-selected')?.addEventListener('click', () => moveOrCopySelectedGalleryImages('copy'));
    // v3.2.2 task #4: gallery selection now offers "send to Dataset Maker"
    // (the training-set workspace) instead of standalone color analysis.
    // Color analysis is still available via the Tag Images modal's Color
    // tab, where most users actually trigger it.
    $('#btn-send-selection-to-dataset-maker')?.addEventListener('click', sendSelectionToDatasetMaker);
    // v3.4.3 P4: batch "add to collection" from the selection panel. Filtered
    // "Select all matching" selections pass their token so the backend expands
    // the ids server-side instead of shipping tens of thousands of ids.
    $('#btn-add-selected-to-collection')?.addEventListener('click', addSelectionToCollectionPicker);
    $('#btn-remove-selected-gallery')?.addEventListener('click', removeSelectedGalleryImages);
    $('#btn-delete-selected-files')?.addEventListener('click', deleteSelectedGalleryImages);
    // v3.5.0 Tier 1: publish-set workbench. Explicit ids only — a filtered
    // "select all matching" token can span tens of thousands of images, which
    // is never a hand-curated publish set.
    $('#btn-publish-selected')?.addEventListener('click', () => {
        const ids = getSelectedGalleryIds();
        if (!ids || ids.length === 0) {
            showToast(
                appT('pub.needExplicitSelection',
                     'Select the images for the set first (explicit picks, not "all matching")'),
                'info'
            );
            return;
        }
        if (window.PublishSet && typeof window.PublishSet.open === 'function') {
            window.PublishSet.open(ids);
        }
    });


    // Confirm modal
    $('#btn-confirm-cancel').addEventListener('click', () => hideModal('confirm-modal'));

    // Note: #btn-select-checkpoints and #btn-select-loras removed - now handled in filter modal
    // Model selection modal handlers (for when opened from filter modal)
    $('#btn-cancel-model-select')?.addEventListener('click', () => hideModal('model-select-modal'));
    $('#btn-close-model-select')?.addEventListener('click', () => hideModal('model-select-modal'));
    $('#btn-confirm-model-select')?.addEventListener('click', confirmModelSelection);
    $('#model-select-search')?.addEventListener('input', (e) => {
        AppState.modalSelection.search = e.target.value.toLowerCase();
        renderModelSelectList();
    });

    // --- Export Modal ---
    $('#btn-close-export')?.addEventListener('click', () => hideModal('export-modal'));
    $('#btn-copy-export')?.addEventListener('click', () => {
        const text = $('#export-text')?.value || '';
        copyTextToClipboard(text, appT('export.copied', 'Copied to clipboard!')).catch(() => {
            showToast(appT('export.copyFailed', 'Failed to copy'), 'error');
        });
    });
    $('#export-format')?.addEventListener('change', (event) => {
        renderExportModalText(event.target.value);
    });
    $('#btn-download-export')?.addEventListener('click', downloadCurrentExportText);
    // --- Export Tags from legacy direct button, if present ---
    $('#btn-export-tags-selected')?.addEventListener('click', () => {
        resetSelectionDataCache();
        showExportTagsModal();
    });

    // --- Alt export button in modal ---
    const exportTagsAlt = $('#btn-export-tags-alt');
    if (exportTagsAlt) {
        exportTagsAlt.addEventListener('click', () => {
            if (exportTagsAlt.dataset.exportView === 'prompts') {
                showExportTagsModal();
            } else {
                showExportModal();
            }
        });
    }

    // --- Unified Filter Modal ---
    $('#btn-open-filters').addEventListener('click', openFilterModal);

    // Filter presets (FIX 2026-06-12): the preset functions (saveFilterPreset /
    // loadFilterPreset / deleteFilterPreset / renderFilterPresets) existed and
    // were exposed on window, but NOTHING in the UI ever called them and
    // #filter-presets-list did not exist in the DOM. These bindings + the
    // .filter-presets-bar markup in the filter modal are the missing entry point.
    const savePresetFromInput = () => {
        const input = $('#filter-preset-name');
        if (!input) return;
        if (saveFilterPreset(input.value)) {
            input.value = '';
            renderFilterPresets();
        }
    };
    $('#btn-save-filter-preset')?.addEventListener('click', savePresetFromInput);
    $('#filter-preset-name')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            savePresetFromInput();
        }
    });

    // --- UI Desktop Sidebar Toggle ---
    const btnCollapseDesktop = $('#btn-collapse-desktop-sidebar');
    const btnRestoreDesktop = $('#btn-restore-desktop-sidebar');
    const sidebarDesktop = $('.filter-sidebar');
    const galleryDesktop = $('.gallery-container');

    const toggleDesktopSidebar = (collapse) => {
        if(collapse) {
            sidebarDesktop?.classList.add('desktop-collapsed');
            galleryDesktop?.classList.add('desktop-collapsed');
            if(btnRestoreDesktop) btnRestoreDesktop.style.display = 'block';
            localStorage.setItem('desktop-sidebar-collapsed', 'true');
        } else {
            sidebarDesktop?.classList.remove('desktop-collapsed');
            galleryDesktop?.classList.remove('desktop-collapsed');
            if(btnRestoreDesktop) btnRestoreDesktop.style.display = 'none';
            localStorage.setItem('desktop-sidebar-collapsed', 'false');
        }
        // Trigger gallery layout recalculation after sidebar width change
        requestAnimationFrame(() => {
            if (window.Gallery?.virtualList) {
                window.Gallery.virtualList.refresh?.();
            }
        });
    };

    if (localStorage.getItem('desktop-sidebar-collapsed') === 'true') {
        toggleDesktopSidebar(true);
    }

    btnCollapseDesktop?.addEventListener('click', () => toggleDesktopSidebar(true));
    btnRestoreDesktop?.addEventListener('click', () => toggleDesktopSidebar(false));
    $('#btn-close-filter-modal').addEventListener('click', closeFilterModal);
    $('#btn-apply-modal-filters').addEventListener('click', applyModalFilters);
    $('#btn-reset-filters').addEventListener('click', resetAllFilters);
    $('#btn-clear-artist')?.addEventListener('click', clearArtistFilter);
    $('#filter-modal')?.addEventListener('change', () => updateFilterModalSummary());
    $('#filter-modal')?.addEventListener('input', () => updateFilterModalSummary());

    // v3.3.0 USR-3: per-group select-all / clear / invert for checkbox groups
    // (generators, ratings, and the dynamic checkpoint/lora lists). One
    // delegated listener keyed by data-group + data-action — no FilterStore
    // change is needed because updateFiltersFromUI reads :checked on Apply.
    $('#filter-modal')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-group-action[data-group][data-action]');
        if (!btn) return;
        e.preventDefault();
        const group = document.getElementById(btn.dataset.group);
        if (!group) return;
        const inputs = group.querySelectorAll('input[type="checkbox"]');
        const action = btn.dataset.action;
        inputs.forEach((cb) => {
            if (action === 'select-all') cb.checked = true;
            else if (action === 'clear') cb.checked = false;
            else if (action === 'invert') cb.checked = !cb.checked;
        });
        // Reset the shift-range anchor so the next range starts fresh.
        delete group.dataset.rangeAnchor;
        updateFilterModalSummary();
    });

    // v3.3.0 USR-3: shift-click range select within a checkbox group so the
    // user can sweep many options without an autoclicker ("用连点器" fix).
    $('#filter-modal')?.addEventListener('click', (e) => {
        const label = e.target.closest('.checkbox-label');
        if (!label) return;
        // Covers both the static toggle grids (generators/ratings) and the
        // dynamic .filter-list groups (checkpoints/loras).
        const group = label.closest('.filter-toggle-grid[role="group"], .filter-list');
        if (!group) return;
        const cb = label.querySelector('input[type="checkbox"]');
        if (!cb) return;
        const labels = Array.from(group.querySelectorAll('.checkbox-label'));
        const index = labels.indexOf(label);
        const anchor = group.dataset.rangeAnchor !== undefined
            ? Number(group.dataset.rangeAnchor)
            : -1;
        if (e.shiftKey && anchor >= 0 && index >= 0) {
            // The browser will toggle cb on this click; mirror its resulting
            // state across the whole range.
            const targetState = cb.checked;
            const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor];
            for (let i = lo; i <= hi; i++) {
                const rangeCb = labels[i].querySelector('input[type="checkbox"]');
                if (rangeCb) rangeCb.checked = targetState;
            }
            updateFilterModalSummary();
        }
        group.dataset.rangeAnchor = String(index);
    });

    // Aesthetic quick filter buttons
    $$('.aesthetic-quick').forEach(btn => {
        btn.addEventListener('click', () => {
            const minInput = $('#filter-aesthetic-min');
            const maxInput = $('#filter-aesthetic-max');
            if (minInput) minInput.value = btn.dataset.min || '';
            if (maxInput) maxInput.value = btn.dataset.max || '';
            // Aurora Phase 3 (24d): "Unscored" is a REAL aesthetic-IS-NULL
            // filter now, carried as a flag on the tier group (it has no
            // min/max representation). Any other tier clears it.
            const group = btn.closest('.aesthetic-quick-filters');
            if (group) group.dataset.unscored = btn.dataset.unscored === '1' ? '1' : '';
            $$('.aesthetic-quick').forEach(b => b.classList.toggle('is-active', b === btn));
            updateFilterModalSummary();
        });
    });
    // Typing a manual aesthetic bound is a scored-range intent — drop Unscored.
    ['#filter-aesthetic-min', '#filter-aesthetic-max'].forEach((selector) => {
        $(selector)?.addEventListener('input', () => {
            const group = $('.aesthetic-quick-filters');
            if (group) group.dataset.unscored = '';
            $$('.aesthetic-quick').forEach(b => b.classList.remove('is-active'));
        });
    });

    // Modal tag search (debounced)
    const debouncedTagSearch = debounce((value) => searchModalTags(value), 300);
    $('#modal-tag-search')?.addEventListener('input', (e) => debouncedTagSearch(e.target.value));

    // Tag input Enter key - add comma-separated tags
    $('#modal-tag-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const input = e.target.value.trim();
            if (input) {
                const filterState = getFilterModalState();
                const tags = input.split(',').map(t => t.trim()).filter(t => t.length > 0);
                const newTags = tags.filter(tag => !filterState.tags.includes(tag));
                if (newTags.length > 0) {
                    filterState.tags = [...filterState.tags, ...newTags];
                }
                renderModalActiveTags();
                e.target.value = '';
                $('#modal-tag-suggestions').innerHTML = '';
            }
        }
    });

    // Prompt input Enter key - add comma-separated prompts
    const promptSearchEl = $('#modal-prompt-search');
    if (promptSearchEl) {
        // Autocomplete suggestions on input (debounced)
        const debouncedPromptSearch = debounce((value) => searchModalPrompts(value), 300);
        promptSearchEl.addEventListener('input', (e) => {
            debouncedPromptSearch(e.target.value);
        });

        promptSearchEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const input = e.target.value.trim();
                if (input) {
                    const filterState = getFilterModalState();
                    // Normalize: lowercase + underscore→space, then dedup against existing
                    const normalize = s => s.toLowerCase().replace(/_/g, ' ').trim();
                    const prompts = input.split(',').map(p => normalize(p)).filter(p => p.length > 0);
                    const existingNormalized = filterState.prompts.map(normalize);
                    const newPrompts = prompts.filter(prompt => !existingNormalized.includes(prompt));
                    if (newPrompts.length > 0) {
                        filterState.prompts = [...filterState.prompts, ...newPrompts];
                    }
                    renderModalActivePrompts();
                    e.target.value = '';
                    $('#modal-prompt-suggestions').innerHTML = '';
                }
            }
        });
    }

    // Library buttons
    $('#btn-tags-library')?.addEventListener('click', openTagsLibrary);
    $('#btn-open-library-from-filter')?.addEventListener('click', () => {
        const returnFilterOptions = {
            mode: FilterModalController.mode || 'gallery',
            titleText: FilterModalController.titleText || null,
            filterState: getFilterModalState(),
            onApply: FilterModalController.onApply,
            onReset: FilterModalController.onReset,
            applyButtonText: FilterModalController.applyButtonText,
            resetButtonText: FilterModalController.resetButtonText,
            optionData: FilterModalController.optionData,
        };
        hideModal('filter-modal');
        openTagsLibrary({
            filterState: getFilterModalState(),
            returnFilterOptions,
            optionData: FilterModalController.optionData,
        });
    });
    $('#btn-close-tags-library')?.addEventListener('click', finishTagsLibraryInteraction);
    $('#btn-close-tags-library-2')?.addEventListener('click', finishTagsLibraryInteraction);
    $('#library-search')?.addEventListener('input', filterLibraryContent);
    $('#library-sort')?.addEventListener('change', loadLibraryContent);
    // Library tab switching
    $('#library-tab-tags')?.addEventListener('click', () => switchLibraryTab('tags'));
    $('#library-tab-prompts')?.addEventListener('click', () => switchLibraryTab('prompts'));
    $('#library-tab-loras')?.addEventListener('click', () => switchLibraryTab('loras'));
    $('#library-tab-checkpoints')?.addEventListener('click', () => switchLibraryTab('checkpoints'));

    // Checkpoint search in filter modal - query backend facets, not just loaded rows
    const debouncedCheckpointSearch = debounce((value) => searchModalFilterFacet('checkpoints', value), 200);
    $('#modal-checkpoint-search')?.addEventListener('input', (e) => {
        debouncedCheckpointSearch(e.target.value);
    });

    // LoRA search in filter modal - query backend facets, not just loaded rows
    const debouncedLoraSearch = debounce((value) => searchModalFilterFacet('loras', value), 200);
    $('#modal-lora-search')?.addEventListener('input', (e) => {
        debouncedLoraSearch(e.target.value);
    });

    // --- Batch Tag Export Modal ---
    $('#btn-batch-export-tags')?.addEventListener('click', showBatchExportModal);
    $('#btn-close-batch-export')?.addEventListener('click', () => hideModal('batch-export-modal'));
    $('#btn-cancel-batch-export')?.addEventListener('click', () => hideModal('batch-export-modal'));
    $('#btn-start-batch-export')?.addEventListener('click', executeBatchExport);
    $('#batch-export-content-mode')?.addEventListener('change', (event) => {
        updateBatchExportContentDescription(event.target.value);
    });
    document.querySelectorAll('input[name="batch-export-output-mode"]').forEach((input) => {
        input.addEventListener('change', syncBatchExportOutputModeUi);
    });

    // --- Import Tags (from Tag Modal) ---
    $('#btn-import-tags')?.addEventListener('click', () => {
        $('#import-tags-file').click();
    });
    $('#import-tags-file')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();

            // Parse and shape-validate as separate steps so the user gets a
            // precise reason: a syntactically broken file is reported as
            // invalid JSON, while a well-formed file with the wrong layout
            // is reported as a structure mismatch.
            let data;
            try {
                data = JSON.parse(text);
            } catch (_parseErr) {
                showToast(appT('tag.importNotJson', 'File is not valid JSON.'), 'error');
                e.target.value = '';
                return;
            }

            // Validate the data structure
            if (!data || typeof data !== 'object' || !Array.isArray(data.images)) {
                showToast(appT('tag.importBadShape', 'Wrong structure: expected { images: [...] }.'), 'error');
                e.target.value = '';
                return;
            }

            // Ask user about overwrite preference using custom modal
            showConfirm(
                appT('tag.importTitle', 'Import Tags'),
                appT(
                    'tag.importMessage',
                    'Found {count} images in the file.\n\nOverwrite existing tags?\nOK = overwrite existing tags\nCancel = keep existing tags',
                    { count: data.images.length }
                ),
                async () => {
                    // Overwrite = true
                    const result = await API.importTags(data.images, true);
                    showToast(appT('tag.importSuccess', 'Imported tags for {imported} images ({skipped} skipped)', {
                        imported: result.imported,
                        skipped: result.skipped,
                    }), 'success');
                    loadImages();
                },
                async () => {
                    // Overwrite = false (skip already-tagged)
                    const result = await API.importTags(data.images, false);
                    showToast(appT('tag.importSuccess', 'Imported tags for {imported} images ({skipped} skipped)', {
                        imported: result.imported,
                        skipped: result.skipped,
                    }), 'success');
                    loadImages();
                }
            );
        } catch (err) {
            showToast(formatUserError(err, appT('tag.importFailed', 'Failed to import tags')), 'error');
        }
        e.target.value = ''; // Reset file input
    });

    // --- Censored Edit ---
    $('#btn-send-to-censor')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (getSelectedGalleryCount() > 0) {
            const token = getActiveSelectionTokenForActions();
            if (token) {
                addToCensorQueue({
                    selectionToken: token,
                    total: getSelectedGalleryCount(),
                    filterKey: AppState.selectionFilterKey || null,
                    visibleImageIds: normalizeSelectionImageIds((AppState.images || []).map((image) => image?.id)),
                });
                clearGallerySelectionAfterBulkAction(); // FLOW-08: don't leave a stale selection behind
                return;
            }
            addToCensorQueue(getSelectedGalleryIds());
            clearGallerySelectionAfterBulkAction(); // FLOW-08: don't leave a stale selection behind
            return;
        }
        switchView('censor');
        if (typeof window.initCensorEdit === 'function') window.initCensorEdit();
    });

    // Metadata editor modal
    $('#btn-edit-metadata')?.addEventListener('click', () => {
        if (window.Gallery && typeof window.Gallery.openMetadataEditor === 'function') {
            window.Gallery.openMetadataEditor();
        }
    });
    $('#meta-editor-close')?.addEventListener('click', () => hideModal('metadata-editor-modal'));
    $('#btn-meta-edit-cancel')?.addEventListener('click', () => hideModal('metadata-editor-modal'));
    $('#btn-meta-edit-save')?.addEventListener('click', () => {
        if (window.Gallery && typeof window.Gallery.saveMetadataEdit === 'function') {
            window.Gallery.saveMetadataEdit();
        }
    });

    // --- Mobile Navigation ---
    initMobileNavigation();
}

document.addEventListener('DOMContentLoaded', () => {
    initMissingFilterMarkup();
    initEventListeners();
    initInputModal();

    // Add pulse indicator to Setup button if user has never clicked it
    if (!localStorage.getItem('sd-image-sorter-setup-clicked')) {
        const setupBtn = $('#btn-open-model-manager');
        if (setupBtn) setupBtn.classList.add('setup-pulse');
    }
    initGlobalKeyboardShortcuts();
    initGalleryDropZone();
    loadTaggerModels();
    setTaggingUiState(false);
    setGalleryViewMode(AppState.viewMode);
    updateSortReverseButton();
    syncGallerySortLabels();
    switchView('gallery');
    loadStats();
    const aestheticStatusReady = refreshAestheticStatus();
    updateFilterSummary();
    syncAspectToggleWithFilters();
    updateSelectionUI();
    resumeScanProgress();
    resumeReconnectProgress();
    resumeTaggingProgress();
    // v3.3.0 FEAT-COLLECTIONS: hydrate favorite hearts once on load.
    window.Gallery?.hydrateFavorites?.();
    // v3.3.1 FEAT-COLLECTIONS: render the sidebar Collections section.
    window.CollectionsUI?.init?.();
    // v3.3.2 Library Navigation: render the sidebar Folders tree.
    window.FolderTreeUI?.init?.();
    // Smart Folders v1: render pinned filter presets with live counts.
    window.SmartFoldersUI?.init?.();
    // v3.3.2 Library Navigation: wire the library-roots management modal (Phase D).
    window.LibraryRootsUI?.init?.();
    _initBgTagProgressButtons();
    _initBgScanProgressButtons();
    _initBgReconnectProgressButtons();
    document.addEventListener('languageChanged', refreshLocalizedDynamicUi);
    document.addEventListener('languageChanged', () => setUpdateButtonState(AppState.update.status, AppState.update.checking));
    setUpdateButtonState();

    // Initialize gallery keyboard navigation for accessibility
    if (window.Gallery && typeof window.Gallery.initKeyboardNavigation === 'function') {
        window.Gallery.initKeyboardNavigation();
    }

    // Initialize Censor Edit module so addToCensorQueue is available from Gallery
    // Note: do NOT init here - initCensorEdit is called when user switches to censor view
    // to prevent mousemove/keydown listeners being attached while another view is active

    // Load More button — visible fallback for infinite scroll
    const loadMoreBtn = document.getElementById('load-more-btn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => loadMoreImages());
    }

    // Setup event listeners for buttons that previously had inline onclick
    const returnToGalleryBtn = document.getElementById('return-to-gallery-btn');
    if (returnToGalleryBtn) {
        returnToGalleryBtn.addEventListener('click', () => switchView('gallery'));
    }

    window.addEventListener('resize', () => {
        _onGalleryScroll();
        updateNavigationOverflowState();
        syncGeneratorRailOverflow();
    }, { passive: true });
    document.addEventListener('languageChanged', () => {
        updateNavigationOverflowState();
        syncGeneratorRailOverflow();
    });
    updateNavigationOverflowState();
    syncGeneratorRailOverflow();
    window.addEventListener('load', updateNavigationOverflowState, { once: true });
    window.addEventListener('load', syncGeneratorRailOverflow, { once: true });
    document.fonts?.ready?.then?.(() => {
        updateNavigationOverflowState();
        syncGeneratorRailOverflow();
    }).catch?.(() => {});
    Promise.resolve(aestheticStatusReady).finally(() => {
        document.documentElement.dataset.appReady = '1';
        window.dispatchEvent(new Event('sd-image-sorter-ready'));
    });
});

function buildAppContext() {
    return {
        API,
        Prefs: AppPreferences,
        AppState,
        showToast,
        createGuideOverlay,
        copyTextToClipboard,
        showModal,
        hideModal,
        showInputModal,
        showGlobalLoading,
        hideGlobalLoading,
        createProgressTracker,
        resetProgressTracker,
        updateProgressTracker,
        buildProgressText,
        formatDurationCompact,
        formatSize,
        loadImages,
        loadStats,
        // Attach the shared tagging progress UI (modal container + floating
        // top bar) to a tagging job started by another module (e.g. Dataset
        // Maker "Tag all"). Probes /api/tag/progress and re-uses the exact
        // same poll loop as the gallery Start-Tag button.
        beginTaggingProgress: resumeTaggingProgress,
        refreshAestheticStatus,
        updateSelectionUI,
        emitSelectionStateChanged,
        getSelectedGalleryCount,
        isFilteredSelectionActiveForCurrentFilters,
        showConfirm,
        showRandomImage,
        showAnalytics,
        showExportModal,
        showExportTagsModal,
        moveOrCopyGalleryImages,
        updateCollapsibleFilterUI,
        openModelSelect,
        renderModelSelectList,
        confirmModelSelection,
        updateModelSelectionSummaries,
        openFilterModal,
        applyModalFilters,
        resetAllFilters,
        updateFilterSummary,
        syncGenTabsWithFilters,
        normalizePromptMatchMode,
        createDefaultFilterState,
        cloneFilterState,
        copyFilterState,
        buildSelectionFilterRequest,
        getSelectionFilterCacheKey,
        buildAdvancedFilterContract,
        getAdvancedFilterContractSignature,
        normalizeCheckpointFilterValue,
        FilterStore: AppFilterStore,
        setFilters: setAppFilters,
        updateFilters: updateAppFilters,
        createDefaultSelectionState,
        cloneSelectionState,
        SelectionStore: AppSelectionStore,
        setSelectionState,
        updateSelectionState,
        mutateSelectedIds,
        clearSelectedIds,
        setSelectionMode,
        updateSortReverseButton,
        syncGallerySortLabels,
        formatGeneratorLabel,
        loadSelectionData,
        loadSelectionDataByToken,
        resetSelectionDataCache,
        markGalleryNeedsRefresh,
        openTagsLibrary,
        switchLibraryTab,
        filterLibraryContent,
        switchView,
        openVlmSettings,
        openColorAnalysis,
        openGalleryPreview,
        applyPromptFilter,
        applyTagFiltersFromExternal,
        // Expose the canonical modal closer so cross-module callers (gallery.js
        // checkpoint/LoRA click-to-filter, FLOW-03 preview handoffs) can close
        // #image-modal. Previously these called window.App.closeModal, which was
        // undefined — a latent no-op. `closeModal` is an alias of hideModal.
        closeModal: hideModal,
        hideModal,
        showPipelineNextStep,
        hidePipelineNextStep,
        addToCensorQueue,
        sendToCensor: addToCensorQueue,
        addToDatasetMaker,
        openPromptBuildFromImage,
        openReaderFromImage,
        openSimilarFromImage,
        deleteGalleryImagesByIds,
        removeGalleryImagesByIds,
        addRecentFolder,
        getRecentFolders,
        updateScanDiagnosticsCard,
        copyScanDiagnostics,
        openScanLogFile,
        clampTaggerChunkToAvailableOption,
        syncSettingsPreferenceStatus,
        persistArtistDefaultsFromDom,
        $,
        $$
    };
}

// Export for other modules
window.App = buildAppContext();
Object.seal(window.App);
window.clampTaggerChunkToAvailableOption = clampTaggerChunkToAvailableOption;


// ============== Empty State CTA Handlers ==============

// Connect empty state scan button
document.addEventListener('DOMContentLoaded', () => {
    const emptyStateScanBtn = document.getElementById('empty-state-scan-btn');
    if (emptyStateScanBtn) {
        emptyStateScanBtn.addEventListener('click', () => {
            showModal('scan-modal');
        });
    }
});
