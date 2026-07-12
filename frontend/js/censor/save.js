/**
 * Censor Editor - saving (split VERBATIM from censor-edit.js; god-file decomposition).
 * Save-options popup, save routing (/save-data vs /save-operations off editOperations.length), saveAllProcessed invariant, metadata strip.
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
        metadataOption.value = CensorState.metadataOption || 'strip';
    }

    const formatOption = document.getElementById('save-format-option');
    if (formatOption) {
        formatOption.value = CensorState.outputFormat || 'png';
    }

    const allowOverwrite = document.getElementById('save-allow-overwrite');
    if (allowOverwrite) {
        allowOverwrite.checked = false;
    }

    document.getElementById('save-options-modal')?.classList.add('visible');
}

async function confirmAndSaveAll() {
    // Read options from popup
    const folder = document.getElementById('save-output-folder')?.value;
    const metadataOption = document.getElementById('save-metadata-option')?.value || 'strip';
    const formatOption = document.getElementById('save-format-option')?.value || 'png';
    const allowOverwrite = Boolean(document.getElementById('save-allow-overwrite')?.checked);

    if (!folder) {
        window.App.showToast(
            censorT('censor.outputFolderRequired', null, 'Please specify an output folder'),
            'error'
        );
        return;
    }

    // Save settings
    CensorState.outputFolder = folder;
    CensorState.metadataOption = metadataOption;
    CensorState.outputFormat = formatOption;
    localStorage.setItem('censor_output_folder', folder);

    // Close popup and start saving
    document.getElementById('save-options-modal')?.classList.remove('visible');

    await saveAllProcessed(formatOption, metadataOption, allowOverwrite);
}

function markGalleryRefreshAfterCensorSave(result) {
    if (!result?.overwrote_indexed_path && !result?.reconciled_image_id) return;

    if (window.App?.markGalleryNeedsRefresh) {
        window.App.markGalleryNeedsRefresh();
    }
}

async function saveCensorQueueItem(item, formatOption = 'png', metadataOption = 'strip', allowOverwrite = false) {
    const folder = CensorState.outputFolder;
    const baseName = item.outputFilename.replace(/\.[^/.]+$/, '');
    const finalFilename = `${baseName}.${formatOption}`;

    if (shouldUseProxyEditMode(item) || (Array.isArray(item.editOperations) && item.editOperations.length > 0)) {
        const result = await window.App.API.post('/api/censor/save-operations', {
            original_image_id: item.id,
            operations: item.editOperations || [],
            filename: finalFilename,
            output_folder: folder,
            metadata_option: metadataOption,
            output_format: formatOption,
            allow_overwrite: allowOverwrite,
        });
        markGalleryRefreshAfterCensorSave(result);
        return result;
    }

    let dataUrl;

    if (item.currentDataUrl) {
        // Already edited - canvas data has no metadata
        dataUrl = item.currentDataUrl;
    } else if (metadataOption === 'strip') {
        // No edits but stripping metadata - draw through canvas to remove all metadata
        dataUrl = await stripMetadataViaCanvas(item.originalUrl);
    } else {
        // Keep metadata - use original blob (metadata preserved in blob)
        dataUrl = await urlToDataUrl(item.originalUrl);
    }

    const result = await window.App.API.post('/api/censor/save-data', {
        image_data: dataUrl,
        filename: finalFilename,
        output_folder: folder,
        metadata_option: metadataOption,
        output_format: formatOption,
        original_image_id: item.id,
        allow_overwrite: allowOverwrite,
    });
    markGalleryRefreshAfterCensorSave(result);
    return result;
}

async function saveAllProcessed(formatOption = 'png', metadataOption = 'strip', allowOverwrite = false) {
    const folder = CensorState.outputFolder;
    if (!folder) {
        window.App.showToast(
            censorT('censor.outputFolderSetupFirst', null, 'Set output folder in Rename or Setup first'),
            'error'
        );
        return;
    }

    _resetBatchStatus();
    const tracker = window.App.createProgressTracker();
    showLoading(true, censorT('censor.loadingSavePreparing', null, 'Save · preparing files...'));

    let count = 0;
    let failedCount = 0;
    let skippedCount = 0;
    await processCensorBatchItems(async (item, { index, total }) => {
        // "Save All Processed" must never write an un-censored original as if it
        // were done — that would violate the never-fallback-to-uncensored
        // invariant (an item can reach the original-bytes save path in
        // saveCensorQueueItem when it has no edits, or via proxy mode with empty
        // operations). Items with no applied censoring are skipped, not exported.
        // NOTE: proxy-mode strokes leave isProcessed=false but carry real
        // editOperations — itemHasCensorContent() covers that so large-image
        // edits are saved, not silently skipped.
        if (!itemHasCensorContent(item)) {
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

            await saveCensorQueueItem(item, formatOption, metadataOption, allowOverwrite);
            item.batchStatus = 'saved';
            count++;
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
                'Nothing saved — none of the {skipped} queued image(s) are censored yet. Run auto-detect or draw a region first.'),
            'warning'
        );
    } else if (skippedCount > 0) {
        window.App.showToast(
            censorT('censor.saveSkippedUnprocessed', { count, skipped: skippedCount },
                'Saved {count} censored · skipped {skipped} un-censored image(s) (not exported).'),
            'warning'
        );
    } else {
        window.App.showToast(
            censorT('censor.saveSuccess', { count, folder }, 'Saved {count} images to {folder}'),
            'success'
        );
    }
}

/**
 * Strips all metadata from an image by drawing it through a canvas.
 * Canvas toDataURL() produces a clean image with no embedded metadata.
 */
async function stripMetadataViaCanvas(url) {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // toDataURL creates a clean PNG with no metadata
    return canvas.toDataURL('image/png');
}

