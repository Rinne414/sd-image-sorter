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
        executeBtn.addEventListener('click', executeAutoSeparate);
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
        const result = await API.getImages({
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
            limit: 10000
        });

        AutoSepState.matchCount = result.count;
        AutoSepState.previewImages = result.images || [];
        AutoSepState.previewSignature = currentSignature;
        $('#autosep-preview .stat-number').textContent = result.count;
        renderAutoSepPreviewList(AutoSepState.previewImages, result.count);

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
                <button class="btn-cancel-operation" id="btn-cancel-autosep-move">Cancel</button>
            </div>
        `;
        container.appendChild(progressEl);
    }
    
    progressEl.classList.add('visible');
    document.getElementById('autosep-move-fill').style.width = '0%';
    document.getElementById('autosep-move-text').textContent = `Preparing to move ${total} images...`;
    
    // Setup cancel button
    const cancelBtn = document.getElementById('btn-cancel-autosep-move');
    if (cancelBtn) {
        cancelBtn.onclick = () => {
            if (autosepMoveController) {
                autosepMoveController.abort();
                showToast('Move operation cancelled', 'info');
            }
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

function updateAutosepMoveProgress(current, total) {
    const fillEl = document.getElementById('autosep-move-fill');
    const textEl = document.getElementById('autosep-move-text');
    
    if (fillEl && textEl) {
        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        fillEl.style.width = percent + '%';
        textEl.textContent = `Moving image ${current} of ${total}...`;
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
            
            // Create abort controller for cancellation
            autosepMoveController = new AbortController();

            try {
                const dimensions = {
                    minWidth: f.minWidth,
                    maxWidth: f.maxWidth,
                    minHeight: f.minHeight,
                    maxHeight: f.maxHeight,
                    aspectRatio: f.aspectRatio
                };

                // Simulate progress for now (backend doesn't support streaming progress)
                // In a real implementation, this would use Server-Sent Events or polling
                let progressInterval;
                let simulatedProgress = 0;
                
                progressInterval = setInterval(() => {
                    simulatedProgress = Math.min(simulatedProgress + Math.ceil(total * 0.1), total - 1);
                    updateAutosepMoveProgress(simulatedProgress, total);
                }, 200);

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

                clearInterval(progressInterval);

                if (result.count === 0) {
                    showToast('No images were moved. Check that the destination path exists and filters match images.', 'error');
                    hideAutosepMoveProgress();
                    return;
                }

                // Show completion
                updateAutosepMoveProgress(result.count, result.count);
                
                setTimeout(() => {
                    hideAutosepMoveProgress();
                    showToast(`Successfully moved ${result.count} images to ${destination}`, 'success');

                    AutoSepState.matchCount = 0;
                    AutoSepState.previewImages = [];
                    AutoSepState.previewSignature = null;
                    $('#autosep-preview .stat-number').textContent = '0';
                    renderAutoSepPreviewList([], 0);

                    if (window.App && window.App.loadImages) {
                        window.App.loadImages();
                    }
                }, 500);

            } catch (error) {
                hideAutosepMoveProgress();
                if (error.name !== 'AbortError') {
                    showToast(formatUserError(error, "Failed to move images"), "error");
                }
            }
        }
    );
}

// Replace the original function
window.executeAutoSeparateWithProgress = executeAutoSeparateWithProgress;
