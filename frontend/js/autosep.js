/**
 * SD Image Sorter - Auto-Separate Module
 * Handles batch filtering and moving of images
 */

const AutoSepState = {
    matchCount: 0,
    previewImages: [],
    previewSignature: null
};

// ============== Initialization ==============

function initAutoSeparate() {
    // Use direct selectors to avoid timing issues with window.App
    const $ = (sel) => document.querySelector(sel);

    // Edit Filters button - opens unified filter modal
    const filterBtn = $('#btn-autosep-filters');
    if (filterBtn) {
        filterBtn.addEventListener('click', () => {
            if (window.App && window.App.openFilterModal) {
                window.App.openFilterModal();
            } else {
                Logger.error('openFilterModal not available');
            }
        });
    }

    // Preview button
    const previewBtn = $('#btn-preview-autosep');
    if (previewBtn) {
        previewBtn.addEventListener('click', updateAutoSepPreview);
    }

    // Execute button
    const executeBtn = $('#btn-execute-autosep');
    if (executeBtn) {
        executeBtn.addEventListener('click', executeAutoSeparateWithProgress);
    }

    // Browse button for destination folder
    const browseBtn = $('#btn-browse-destination');
    if (browseBtn) {
        browseBtn.addEventListener('click', async () => {
            const input = $('#autosep-destination');
            // Browser can't access filesystem directly, prompt user for path
            const currentPath = input ? input.value : '';
            const path = await window.App.showInputModal(
                'Destination Folder',
                'Enter the destination folder path.\nExample: D:\\sorted\\my-folder',
                currentPath
            );
            if (path !== null && input) {
                input.value = path;
            }
        });
    }

    resumeAutosepMoveProgress();
}

// ============== Update Summary Display ==============

function updateAutoSepSummary() {
    const { $, AppState } = window.App;
    if (!AppState || !AppState.filters) return;

    // Use shared filter summary formatter
    const summary = window.formatFilterSummary(AppState.filters);

    // Generators
    const genEl = $('#autosep-summary-generators');
    if (genEl) genEl.textContent = summary.generators;

    // Tags
    const tagEl = $('#autosep-summary-tags');
    if (tagEl) tagEl.textContent = summary.tags;

    // Ratings
    const ratingEl = $('#autosep-summary-ratings');
    if (ratingEl) ratingEl.textContent = summary.ratings;

    // Checkpoints
    const cpEl = $('#autosep-summary-checkpoints');
    if (cpEl) cpEl.textContent = summary.checkpoints;

    // Loras
    const loraEl = $('#autosep-summary-loras');
    if (loraEl) loraEl.textContent = summary.loras;

    // Prompts
    const promptEl = $('#autosep-summary-prompts');
    if (promptEl) promptEl.textContent = summary.prompts;

    // Dimensions
    const dimEl = $('#autosep-summary-dimensions');
    if (dimEl) dimEl.textContent = summary.dimensions;
}

function getAutoSepFilterSignature(filters) {
    return JSON.stringify({
        generators: filters.generators || [],
        tags: filters.tags || [],
        ratings: filters.ratings || [],
        checkpoints: filters.checkpoints || [],
        loras: filters.loras || [],
        prompts: filters.prompts || [],
        minWidth: filters.minWidth || null,
        maxWidth: filters.maxWidth || null,
        minHeight: filters.minHeight || null,
        maxHeight: filters.maxHeight || null,
        aspectRatio: filters.aspectRatio || null
    });
}

function renderAutoSepPreviewList(images = [], totalCount = 0) {
    const { $, API, openGalleryPreview } = window.App;
    const container = $('#autosep-preview-list');
    if (!container) return;

    container.innerHTML = '';

    if (!images.length) {
        const empty = document.createElement('div');
        empty.className = 'autosep-preview-empty';
        empty.textContent = 'No preview yet. Click "Preview Results" to inspect matching images.';
        container.appendChild(empty);
        return;
    }

    images.slice(0, 8).forEach((image) => {
        const button = document.createElement('button');
        button.className = 'autosep-preview-item';
        button.type = 'button';
        button.dataset.imageId = String(image.id);
        button.title = `Open ${image.filename}`;

        const img = document.createElement('img');
        img.className = 'autosep-preview-thumb';
        img.src = API.getThumbnailUrl(image.id, 256);
        img.alt = image.filename;

        const name = document.createElement('span');
        name.className = 'autosep-preview-name';
        name.textContent = image.filename;

        button.append(img, name);
        button.addEventListener('click', () => {
            const imageId = parseInt(button.dataset.imageId, 10);
            if (typeof openGalleryPreview === 'function') {
                openGalleryPreview(imageId);
            }
        });

        container.appendChild(button);
    });

    const remaining = totalCount - Math.min(images.length, 8);
    if (remaining > 0) {
        const more = document.createElement('div');
        more.className = 'autosep-preview-more';
        more.textContent = `+${remaining} more matches`;
        container.appendChild(more);
    }
}


// ============== Preview ==============

async function updateAutoSepPreview() {
    const { $, API, AppState } = window.App;

    // Update summary display
    updateAutoSepSummary();

    const f = AppState.filters;
    const currentSignature = getAutoSepFilterSignature(f);

    // Check if any meaningful filters are set
    const hasFilters =
        (f.generators?.length > 0 && f.generators.length < 5) ||
        (f.tags?.length > 0) ||
        (f.ratings?.length > 0 && f.ratings.length < 4) ||
        (f.checkpoints?.length > 0) ||
        (f.loras?.length > 0) ||
        (f.prompts?.length > 0) ||
        f.minWidth || f.maxWidth || f.minHeight || f.maxHeight || f.aspectRatio;

    if (!hasFilters) {
        $('#autosep-preview .stat-number').textContent = '0';
        AutoSepState.matchCount = 0;
        AutoSepState.previewImages = [];
        AutoSepState.previewSignature = currentSignature;
        renderAutoSepPreviewList([], 0);
        return;
    }

    try {
        const firstPage = await API.getImages({
            generators: f.generators?.length > 0 ? f.generators : null,
            tags: f.tags?.length > 0 ? f.tags : null,
            ratings: f.ratings?.length < 4 ? f.ratings : null,
            checkpoints: f.checkpoints?.length > 0 ? f.checkpoints : null,
            loras: f.loras?.length > 0 ? f.loras : null,
            prompts: f.prompts?.length > 0 ? f.prompts : null,
            minWidth: f.minWidth,
            maxWidth: f.maxWidth,
            minHeight: f.minHeight,
            maxHeight: f.maxHeight,
            aspectRatio: f.aspectRatio,
            limit: 1000
        });

        AutoSepState.matchCount = firstPage.total || 0;
        AutoSepState.previewImages = firstPage.images || [];
        AutoSepState.previewSignature = currentSignature;
        $('#autosep-preview .stat-number').textContent = AutoSepState.matchCount;
        renderAutoSepPreviewList(AutoSepState.previewImages, AutoSepState.matchCount);

    } catch (error) {
        Logger.error('Failed to preview:', error);
    }
}

// ============== Execute ==============

async function executeAutoSeparate() {
    const { $, API, showToast, AppState, showGlobalLoading, hideGlobalLoading, showConfirm } = window.App;

    const destEl = $('#autosep-destination');
    const destination = destEl ? destEl.value.trim() : '';

    if (!destination) {
        showToast('Please enter a destination folder', 'error');
        return;
    }

    const currentSignature = getAutoSepFilterSignature(AppState.filters);
    if (AutoSepState.previewSignature !== currentSignature) {
        showToast('Please preview the current filter results before moving images', 'info');
        await updateAutoSepPreview();
        return;
    }

    if (AutoSepState.matchCount === 0) {
        showToast('No images match the current filters', 'error');
        return;
    }

    const f = AppState.filters;

    showConfirm(
        'Confirm Auto-Separate',
        `Move ${AutoSepState.matchCount} matching images to:\n${destination}\n\nReview the preview list above before continuing.`,
        async () => {
            showGlobalLoading(`Moving ${AutoSepState.matchCount} images...`);

            try {
                const dimensions = {
                    minWidth: f.minWidth,
                    maxWidth: f.maxWidth,
                    minHeight: f.minHeight,
                    maxHeight: f.maxHeight,
                    aspectRatio: f.aspectRatio
                };

                const result = await API.batchMove(
                    f.generators?.length > 0 ? f.generators : null,
                    f.tags?.length > 0 ? f.tags : null,
                    f.ratings?.length < 4 ? f.ratings : null,
                    destination,
                    f.checkpoints?.length > 0 ? f.checkpoints : null,
                    f.loras?.length > 0 ? f.loras : null,
                    f.prompts?.length > 0 ? f.prompts : null,
                    dimensions
                );

                if (result.count === 0) {
                    showToast('No images were moved. Check that the destination path exists and filters match images.', 'error');
                    return;
                }

                showToast(`Moved ${result.count} images to ${destination}`, 'success');

                AutoSepState.matchCount = 0;
                AutoSepState.previewImages = [];
                AutoSepState.previewSignature = null;
                $('#autosep-preview .stat-number').textContent = '0';
                renderAutoSepPreviewList([], 0);

                if (window.App && window.App.loadImages) {
                    window.App.loadImages();
                }

            } catch (error) {
                showToast(formatUserError(error, "Failed to move images"), "error");
            } finally {
                hideGlobalLoading();
            }
        }
    );
}

function invalidateAutoSepPreview() {
    const statNumber = document.querySelector('#autosep-preview .stat-number');
    AutoSepState.matchCount = 0;
    AutoSepState.previewImages = [];
    AutoSepState.previewSignature = null;
    if (statNumber) statNumber.textContent = '0';
    renderAutoSepPreviewList([], 0);
}

// ============== Initialize ==============

document.addEventListener('DOMContentLoaded', () => {
    initAutoSeparate();
});

// Export for use by app.js filter modal
window.updateAutoSepSummary = updateAutoSepSummary;
window.invalidateAutoSepPreview = invalidateAutoSepPreview;


// ============== Enhanced Execute with Progress ==============

// State for move operation
let autosepMoveController = null;

function showAutosepMoveProgress(total) {
    const container = document.querySelector('.preview-section');
    if (!container) return;
    
    // Check if progress element already exists
    let progressEl = document.getElementById('autosep-move-progress');
    if (!progressEl) {
        progressEl = document.createElement('div');
        progressEl.id = 'autosep-move-progress';
        progressEl.className = 'autosep-move-progress';
        progressEl.innerHTML = `
            <div class="progress-bar">
                <div class="progress-fill" id="autosep-move-fill" style="width: 0%"></div>
            </div>
            <div class="progress-text" id="autosep-move-text">Moving images...</div>
            <div class="operation-controls">
                <button class="btn-cancel-operation" id="btn-cancel-autosep-move">Hide</button>
            </div>
        `;
        container.appendChild(progressEl);
    }
    
    progressEl.classList.add('visible');
    document.getElementById('autosep-move-fill').style.width = '0%';
    document.getElementById('autosep-move-text').textContent = `Preparing to move ${total} images in the background...`;
    
    // The backend move runs in the background; the UI can only dismiss progress.
    const cancelBtn = document.getElementById('btn-cancel-autosep-move');
    if (cancelBtn) {
        cancelBtn.onclick = () => {
            hideAutosepMoveProgress();
        };
    }
}

function hideAutosepMoveProgress() {
    const progressEl = document.getElementById('autosep-move-progress');
    if (progressEl) {
        progressEl.classList.remove('visible');
    }
    autosepMoveController = null;
}

function updateAutosepMoveProgress(progress = {}, fallbackTotal = 0) {
    const fillEl = document.getElementById('autosep-move-fill');
    const textEl = document.getElementById('autosep-move-text');
    
    if (fillEl && textEl) {
        const current = Number(progress.current || 0);
        const total = Number(progress.total || fallbackTotal || 0);
        const moved = Number(progress.moved || 0);
        const errors = Number(progress.errors || 0);
        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        fillEl.style.width = percent + '%';
        const details = [`${moved} moved`];
        if (errors > 0) {
            details.push(`${errors} error(s)`);
        }
        textEl.textContent = `Processed ${current} of ${total} images (${details.join(', ')})`;
    }
}

async function pollAutosepMoveProgress(expectedTotal, destination = '') {
    if (autosepMoveController?.active) return;

    const controller = { active: true, destination };
    autosepMoveController = controller;
    const destinationLabel = destination ? ` to ${destination}` : '';

    try {
        while (autosepMoveController === controller && controller.active) {
            const progress = await window.App.API.get('/api/batch-move/progress');
            updateAutosepMoveProgress(progress, expectedTotal);

            if (progress.status === 'idle') {
                hideAutosepMoveProgress();
                window.App.showToast('Batch move stopped before any progress was reported', 'error');
                break;
            }

            if (progress.status === 'done') {
                setTimeout(() => {
                    hideAutosepMoveProgress();
                    const movedCount = Number(progress.moved || 0);
                    const errorCount = Number(progress.errors || 0);

                    if (movedCount > 0 && errorCount > 0) {
                        window.App.showToast(`Moved ${movedCount} images${destinationLabel}. ${errorCount} failed.`, 'warning');
                    } else if (movedCount > 0) {
                        window.App.showToast(`Moved ${movedCount} images${destinationLabel}`, 'success');
                    } else if (errorCount > 0) {
                        window.App.showToast(progress.message || `No images were moved. ${errorCount} failed.`, 'error');
                    } else {
                        window.App.showToast(progress.message || 'No images were moved', 'error');
                    }

                    if (movedCount > 0) {
                        AutoSepState.matchCount = 0;
                        AutoSepState.previewImages = [];
                        AutoSepState.previewSignature = null;
                        document.querySelector('#autosep-preview .stat-number').textContent = '0';
                        renderAutoSepPreviewList([], 0);

                        if (window.App && window.App.loadImages) {
                            window.App.loadImages();
                        }
                    }
                }, 300);
                break;
            }

            if (progress.status === 'error') {
                hideAutosepMoveProgress();
                window.App.showToast(progress.message || 'Failed to move images', 'error');
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 250));
        }
    } finally {
        if (autosepMoveController === controller) {
            controller.active = false;
        }
    }
}

async function resumeAutosepMoveProgress() {
    try {
        const progress = await window.App.API.get('/api/batch-move/progress');
        if (progress?.status !== 'running') {
            return;
        }

        const expectedTotal = Number(progress.total || 0);
        showAutosepMoveProgress(expectedTotal);
        updateAutosepMoveProgress(progress, expectedTotal);
        pollAutosepMoveProgress(expectedTotal);
    } catch (error) {
        Logger.warn('Failed to resume auto-separate move progress:', error);
    }
}

// Enhanced execute with progress tracking
async function executeAutoSeparateWithProgress() {
    const { $, API, showToast, AppState, showConfirm } = window.App;

    const destEl = $('#autosep-destination');
    const destination = destEl ? destEl.value.trim() : '';

    if (!destination) {
        showToast('Please enter a destination folder', 'error');
        return;
    }

    const currentSignature = getAutoSepFilterSignature(AppState.filters);
    if (AutoSepState.previewSignature !== currentSignature) {
        showToast('Please preview the current filter results before moving images', 'info');
        await updateAutoSepPreview();
        return;
    }

    if (AutoSepState.matchCount === 0) {
        showToast('No images match the current filters', 'error');
        return;
    }

    const f = AppState.filters;
    const total = AutoSepState.matchCount;

    showConfirm(
        'Confirm Auto-Separate',
        `Move ${total} matching images to:\n${destination}\n\nReview the preview list above before continuing.`,
        async () => {
            showAutosepMoveProgress(total);

            try {
                const dimensions = {
                    minWidth: f.minWidth,
                    maxWidth: f.maxWidth,
                    minHeight: f.minHeight,
                    maxHeight: f.maxHeight,
                    aspectRatio: f.aspectRatio
                };

                const startResult = await API.batchMove(
                    f.generators?.length > 0 ? f.generators : null,
                    f.tags?.length > 0 ? f.tags : null,
                    f.ratings?.length < 4 ? f.ratings : null,
                    destination,
                    f.checkpoints?.length > 0 ? f.checkpoints : null,
                    f.loras?.length > 0 ? f.loras : null,
                    f.prompts?.length > 0 ? f.prompts : null,
                    dimensions
                );

                if (startResult?.error) {
                    throw new Error(startResult.message || startResult.error);
                }
                if (startResult?.status !== 'started') {
                    throw new Error(startResult?.message || 'Batch move did not start correctly');
                }

                const expectedTotal = startResult.total || total;
                updateAutosepMoveProgress({ current: 0, total: expectedTotal, moved: 0, errors: 0 }, expectedTotal);
                await pollAutosepMoveProgress(expectedTotal, destination);

            } catch (error) {
                hideAutosepMoveProgress();
                showToast(formatUserError(error, "Failed to move images"), "error");
            }
        }
    );
}

// Replace the original function
window.executeAutoSeparateWithProgress = executeAutoSeparateWithProgress;
