/**
 * App boot listeners, part 2 (gallery): random button, grid size,
 * generator rail, tags library + filter presets, desktop sidebar
 * collapse, and the filter-modal facet searches. Body moved VERBATIM
 * from app.js initEventListeners (lines 481-940 of the post-stage-5
 * file). Runs after the shell binder — original top-to-bottom order.
 */
function initBootListenersGallery() {
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
