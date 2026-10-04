/**
 * Censor Editor - saving (split VERBATIM from censor-edit.js; god-file decomposition).
 * Save-options popup, save routing (/save-data vs /save-operations off editOperations.length), the unedited-image choice, metadata strip.
 * Shared top-level bindings (CensorState, ...) are declared in censor/state.js;
 * classic-script global lexical scoping keeps them single instances across parts.
 * Load order is pinned in index.html - see censor/state.js for the full note.
 */
function openSaveOptionsPopup() {
    if (!hasCensorQueueWork()) {
        window.App.showToast(censorT('censor.noImagesToSave', null, 'No images in queue to save'), 'error');
        return;
    }

    // Pre-fill with saved values
    const outputFolder = document.getElementById('save-output-folder');
    if (outputFolder) {
        outputFolder.value = CensorState.outputFolder || localStorage.getItem('censor_output_folder') || '';
    }

    const metadataOption = document.getElementById('save-metadata-option');
    if (metadataOption) {
        metadataOption.value = CensorState.metadataOption || localStorage.getItem('censor_metadata_option') || 'strip';
    }

    const formatOption = document.getElementById('save-format-option');
    if (formatOption) {
        formatOption.value = CensorState.outputFormat || localStorage.getItem('censor_output_format') || 'png';
    }

    const nameConflict = document.getElementById('save-name-conflict');
    if (nameConflict) {
        nameConflict.value = readCensorNameConflict();
    }

    window.hideFolderBrowser?.();
    refreshPendingFilterNotice();
    refreshUneditedSaveOption();
    refreshCensorDefaultOutputFolder();
    document.getElementById('save-options-modal')?.classList.add('visible');
}

// Adjust sliders only preview on the canvas; warn in the dialog and offer to
// write them into the shown picture before saving.
function refreshPendingFilterNotice() {
    const group = document.getElementById('save-filter-pending-group');
    if (group) group.hidden = !window.__censorHasPendingFilterPreview?.();
}

async function applyPendingFiltersBeforeSave() {
    await window.__applyCensorFilterPreviewToCurrent?.();
    refreshPendingFilterNotice();
    refreshUneditedSaveOption();
}

const CENSOR_NAME_CONFLICTS = new Set(['unique', 'overwrite', 'skip']);

// Numbering is the default: it never replaces a file and never needs a rename.
function readCensorNameConflict() {
    const stored = localStorage.getItem('censor_name_conflict');
    return CENSOR_NAME_CONFLICTS.has(stored) ? stored : 'unique';
}

// The empty folder field saves into the program's output/censor; show where.
async function refreshCensorDefaultOutputFolder() {
    const input = document.getElementById('save-output-folder');
    if (!input) return;
    try {
        const response = await window.App.API.get('/api/output-folders');
        const folder = response?.folders?.censor;
        if (folder) {
            input.placeholder = censorT('save.outputFolderDefault', { path: folder }, 'Empty = {path}');
        }
    } catch (error) {
        Logger.warn('Could not read the default output folder', error);
    }
}

function folderOfSavedPath(path) {
    return String(path || '').replace(/[\\/][^\\/]*$/, '');
}

function revealCensorSavedFile(path) {
    window.App.API.post('/api/output-folders/reveal', { path }).catch((error) => {
        window.App.showToast(error?.message || String(error), 'error');
    });
}

// Items still on the server's page cursor were never opened, so they cannot
// carry edits: everything past the censored ones is unedited.
function countUneditedQueueItems() {
    const censoredCount = CensorState.queue.filter(itemHasCensorContent).length;
    return Math.max(0, getCensorQueueWorkCount() - censoredCount);
}

// Reorder + rename is a use of its own, so unedited images are exported as
// they are unless the user leaves them out. The count is always shown first,
// so nothing uncensored goes out without the user having seen it.
function refreshUneditedSaveOption() {
    const group = document.getElementById('save-unedited-group');
    if (!group) return;

    const uneditedCount = countUneditedQueueItems();
    group.hidden = uneditedCount === 0;
    const label = document.getElementById('save-unedited-label');
    if (label) {
        label.textContent = censorT('save.uneditedCount', { count: uneditedCount },
            '{count} image(s) in the queue have no censoring');
    }
    const select = document.getElementById('save-unedited-option');
    if (select) {
        select.value = localStorage.getItem('censor_unedited_option') === 'skip' ? 'skip' : 'include';
    }
}

async function confirmAndSaveAll() {
    // Read options from popup
    const folder = document.getElementById('save-output-folder')?.value;
    const metadataOption = document.getElementById('save-metadata-option')?.value || 'strip';
    const formatOption = document.getElementById('save-format-option')?.value || 'png';
    const selectedConflict = document.getElementById('save-name-conflict')?.value;
    const nameConflict = CENSOR_NAME_CONFLICTS.has(selectedConflict) ? selectedConflict : 'unique';
    const includeUnedited = document.getElementById('save-unedited-option')?.value !== 'skip';

    // An empty folder is allowed: the server saves into output/censor.
    CensorState.outputFolder = folder;
    CensorState.metadataOption = metadataOption;
    CensorState.outputFormat = formatOption;
    localStorage.setItem('censor_output_format', formatOption);
    localStorage.setItem('censor_output_folder', folder);
    localStorage.setItem('censor_metadata_option', metadataOption);
    localStorage.setItem('censor_name_conflict', nameConflict);
    localStorage.setItem('censor_unedited_option', includeUnedited ? 'include' : 'skip');

    // Close popup and start saving
    document.getElementById('save-options-modal')?.classList.remove('visible');

    await saveAllProcessed(formatOption, metadataOption, nameConflict, { includeUnedited });
}

function markGalleryRefreshAfterCensorSave(result) {
    if (!result?.overwrote_indexed_path && !result?.reconciled_image_id) return;

    if (window.App?.markGalleryNeedsRefresh) {
        window.App.markGalleryNeedsRefresh();
    }
}

function readCensorSaveWarnings(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new TypeError('Censor save response must be an object');
    }
    if (!Array.isArray(result.warnings)) {
        throw new TypeError('Censor save response requires a warnings array');
    }

    return result.warnings.map((warning) => {
        if (typeof warning !== 'string' || !warning.trim()) {
            throw new TypeError('Censor save warnings must be non-empty strings');
        }
        return warning.trim();
    });
}

const CENSOR_SOURCE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp']);

// "Same as the original" resolves per image; anything else is a fixed format.
function resolveCensorOutputFormat(item, formatOption) {
    if (formatOption !== 'original') return formatOption;
    const ext = String(item?.originalFilename || '').split('.').pop().toLowerCase();
    return CENSOR_SOURCE_FORMATS.has(ext) ? ext : 'png';
}

// `target` redirects one save (the Publish Set hand-over writes into its
// staging folder under a name of its own); Save uses the chosen folder.
// nameConflict: 'unique' (name_2, name_3...), 'overwrite', 'skip', or
// 'error' (refuse an existing name; the hand-over needs its exact names).
async function saveCensorQueueItem(item, formatOption = 'png', metadataOption = 'strip', nameConflict = 'error', target = {}) {
    const folder = target.folder || CensorState.outputFolder || '';
    const baseName = target.baseName || item.outputFilename.replace(/\.[^/.]+$/, '');
    const outputFormat = resolveCensorOutputFormat(item, formatOption);
    const finalFilename = `${baseName}.${outputFormat}`;
    const allowOverwrite = nameConflict === 'overwrite';
    const conflictPolicy = nameConflict === 'unique' || nameConflict === 'skip' ? nameConflict : 'error';

    if (shouldUseProxyEditMode(item) || (Array.isArray(item.editOperations) && item.editOperations.length > 0)) {
        const result = await window.App.API.post('/api/censor/save-operations', {
            original_image_id: item.id,
            operations: item.editOperations || [],
            filename: finalFilename,
            output_folder: folder,
            metadata_option: metadataOption,
            output_format: outputFormat,
            allow_overwrite: allowOverwrite,
            name_conflict: conflictPolicy,
        });
        markGalleryRefreshAfterCensorSave(result);
        return result;
    }

    // Unedited: the server saves straight from the source file (a byte copy
    // when the format and metadata are kept), so the pixels never go through
    // a browser canvas and a JPG does not come back as a large PNG.
    if (!item.currentDataUrl) {
        const result = await window.App.API.post('/api/censor/save-original', {
            original_image_id: item.id,
            filename: finalFilename,
            output_folder: folder,
            metadata_option: metadataOption,
            output_format: formatOption,
            allow_overwrite: allowOverwrite,
            name_conflict: conflictPolicy,
        });
        markGalleryRefreshAfterCensorSave(result);
        return result;
    }

    const result = await window.App.API.post('/api/censor/save-data', {
        image_data: item.currentDataUrl,
        filename: finalFilename,
        output_folder: folder,
        metadata_option: metadataOption,
        output_format: outputFormat,
        original_image_id: item.id,
        allow_overwrite: allowOverwrite,
        name_conflict: conflictPolicy,
    });
    markGalleryRefreshAfterCensorSave(result);
    return result;
}

async function saveAllProcessed(formatOption = 'png', metadataOption = 'strip', nameConflict = 'unique', { includeUnedited = true } = {}) {
    _resetBatchStatus();
    const tracker = window.App.createProgressTracker();
    showLoading(true, censorT('censor.loadingSavePreparing', null, 'Save · preparing files...'));

    let count = 0;
    let asIsCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let existingSkippedCount = 0;
    let lastSavedPath = '';
    const saveWarnings = new Set();
    await processCensorBatchItems(async (item, { index, total }) => {
        // Unedited items go out as they are only when the save dialog, which
        // showed their count, was left on "export them as they are". Proxy-mode
        // strokes leave isProcessed=false but carry real editOperations;
        // itemHasCensorContent() counts those as censored.
        const isUnedited = !itemHasCensorContent(item);
        if (isUnedited && !includeUnedited) {
            item.batchStatus = 'skipped';
            skippedCount += 1;
            return;
        }
        try {
            showLoading(true, window.App.buildProgressText({
                progress: { message: item.outputFilename || item.originalFilename || `Image ${item.id}` },
                completed: index,
                total,
                tracker,
                defaultMessage: censorT('censor.loadingSaveDefault', null, 'Saving processed images...'),
                primaryLabel: censorT('censor.loadingSavePrimary', null, 'Save')
            }));

            const result = await saveCensorQueueItem(item, formatOption, metadataOption, nameConflict);
            readCensorSaveWarnings(result).forEach((warning) => saveWarnings.add(warning));
            if (result.output_path) lastSavedPath = result.output_path;
            if (result.skipped) {
                item.batchStatus = 'skipped';
                existingSkippedCount += 1;
                return;
            }
            item.batchStatus = 'saved';
            item.savedSignature = censorItemSaveSignature(item);
            count++;
            if (isUnedited) asIsCount += 1;
        } catch (e) {
            Logger.error(e);
            item.batchStatus = 'failed';
            item.batchError = `${censorT('censor.saveFailed', null, 'Save failed')}: ${e?.message || e || ''}`.trim();
            failedCount += 1;
        }
    });

    showLoading(false);
    renderQueue();
    failedCount = Math.max(failedCount, _summarizeBatchFailures().failedCount);
    const folder = folderOfSavedPath(lastSavedPath) || CensorState.outputFolder || '';
    const openFolder = lastSavedPath ? {
        actionLabel: censorT('censor.openOutputFolder', null, 'Open folder'),
        onAction: () => revealCensorSavedFile(lastSavedPath),
        duration: 8000,
    } : {};
    if (failedCount > 0) {
        window.App.showToast(
            censorT('censor.savePartial', {
                count,
                failedCount,
            }, 'Saved {count} images · {failedCount} failed (red-outlined thumbnails)'),
            'warning'
        );
    } else if (count === 0 && skippedCount > 0) {
        // Nothing was censored — say so plainly instead of a green "Saved 0".
        window.App.showToast(
            censorT('censor.saveNothingProcessed', { skipped: skippedCount },
                'Nothing saved: none of the {skipped} image(s) are censored, and the save options leave uncensored images out.'),
            'warning'
        );
    } else if (skippedCount > 0) {
        window.App.showToast(
            censorT('censor.saveSkippedUnprocessed', { count, skipped: skippedCount },
                'Saved {count} censored image(s); {skipped} uncensored image(s) were not exported.'),
            'warning'
        );
    } else if (asIsCount > 0) {
        window.App.showToast(
            censorT('censor.saveSuccessAsIs', { count, folder, asIs: asIsCount },
                'Saved {count} images to {folder}. {asIs} had no censoring and went out as they are.'),
            'success',
            openFolder
        );
    } else if (count > 0) {
        window.App.showToast(
            censorT('censor.saveSuccess', { count, folder }, 'Saved {count} images to {folder}'),
            'success',
            openFolder
        );
    }

    if (existingSkippedCount > 0) {
        window.App.showToast(
            censorT('censor.saveSkippedExisting', { count: existingSkippedCount },
                '{count} image(s) skipped: a file with the same name is already there.'),
            'warning',
            openFolder
        );
    }

    if (saveWarnings.size > 0) {
        window.App.showToast(Array.from(saveWarnings).join(' '), 'warning');
    }
}

