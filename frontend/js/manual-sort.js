/**
 * SD Image Sorter - Manual Sort Module
 * Rhythm-game style keyboard-driven image sorting
 */

const ManualSortState = {
    active: false,
    isProcessing: false,  // Lock to prevent race conditions during rapid keypresses
    currentImage: null,
    currentTags: [],
    folders: { w: '', a: '', s: '', d: '' },
    index: 0,
    total: 0,
    combo: 0,
    lastActionTime: 0,
    history: [],
    images: [],  // For gallery preview
    // Enhanced tracking
    sortedCount: 0,
    skippedCount: 0,
    undoAvailable: false,
    redoAvailable: false,
    startTime: null,
    actionTimestamps: []  // For speed calculation
};

// Key mappings
const KEY_MAP = {
    'w': 'w', 'W': 'w', 'ArrowUp': 'w',
    'a': 'a', 'A': 'a', 'ArrowLeft': 'a',
    's': 's', 'S': 's', 'ArrowDown': 's',
    'd': 'd', 'D': 'd', 'ArrowRight': 'd',
    ' ': 'skip',
    'z': 'undo', 'Z': 'undo',
    'y': 'redo', 'Y': 'redo',
    'Escape': 'exit'
};

const DIRECTION_MAP = {
    'w': 'up',
    'a': 'left',
    's': 'down',
    'd': 'right'
};

const DEFAULT_FOLDER_LABELS = {
    w: 'Top',
    a: 'Keep',
    s: 'Delete',
    d: 'Best'
};

// ============== Initialization ==============

async function initManualSort() {
    // Use direct selectors to avoid timing issues with window.App
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // Folder path inputs
    $$('.folder-path-input').forEach(input => {
        input.addEventListener('change', () => {
            ManualSortState.folders[input.dataset.key] = input.value;
        });
    });

    // Browse folder buttons
    $$('.browse-folder').forEach(btn => {
        btn.addEventListener('click', async () => {
            // Find the input in the same folder-slot as this button
            const folderSlot = btn.closest('.folder-slot');
            const input = folderSlot?.querySelector('.folder-path-input');
            if (input) {
                const key = input.dataset.key?.toUpperCase() || '';
                const currentValue = input.value || '';
                const path = await window.App.showInputModal(
                    `Folder Path for ${key}`,
                    `Enter the destination folder path.\nExample: D:\\sorted\\folder-name`,
                    currentValue
                );
                if (path !== null) {
                    input.value = path;
                    ManualSortState.folders[input.dataset.key] = path;
                }
            }
        });
    });

    // Edit Filters button - open unified filter modal
    const filterBtn = $('#btn-manual-sort-filters');
    if (filterBtn) {
        filterBtn.addEventListener('click', () => {
            if (window.App && window.App.openFilterModal) {
                window.App.openFilterModal();
            }
        });
    }

    // Start sorting button
    const startBtn = $('#btn-start-sorting');
    if (startBtn) {
        startBtn.addEventListener('click', startSorting);
    }

    // Exit sorting button
    const exitBtn = $('#btn-exit-sorting');
    if (exitBtn) {
        exitBtn.addEventListener('click', exitSorting);
    }

    // Resume session button
    const resumeBtn = $('#btn-resume-sorting');
    if (resumeBtn) {
        resumeBtn.addEventListener('click', resumeSavedSession);
    }

    // Discard saved session button
    const discardBtn = $('#btn-discard-session');
    if (discardBtn) {
        discardBtn.addEventListener('click', () => {
            window.App.showConfirm(
                'Discard Saved Session',
                'Delete the saved manual-sort session and lose the remaining progress? This cannot be undone.',
                async () => {
                    try {
                        await window.App.API.delete('/api/sort/session');
                        const banner = $('#sort-resume-banner');
                        if (banner) banner.style.display = 'none';
                        window.App.showToast('Saved session discarded', 'success');
                    } catch (e) {
                        if (window.Logger) Logger.warn('Failed to discard session:', e);
                        window.App.showToast(formatUserError(e, 'Failed to discard saved session'), 'error');
                    }
                }
            );
        });
    }

    // Keyboard listener (added when sorting starts)

    // Update filter summary display initially
    setTimeout(() => {
        if (window.App && window.App.AppState) {
            updateManualSortFilterSummary();
        }
    }, 100);

    // Check for saved session on the server
    try {
        const session = await window.App.API.get('/api/sort/current').catch(e => {
            console.warn('Operation failed:', e);
            return null;
        });
        if (session && !session.done && session.image) {
            const banner = document.querySelector('#sort-resume-banner');
            if (banner) {
                banner.style.display = 'flex';
                const countEl = banner.querySelector('.resume-count');
                if (countEl) countEl.textContent = `${session.remaining} images remaining`;
            }
        }
    } catch(e) {
        if (window.Logger) Logger.warn('Failed to check sort session:', e);
    }
}

// ============== Start Sorting ==============

async function startSorting() {
    const { $, $$, API, showToast, AppState } = window.App;

    // Collect folder paths
    const folders = {};
    $$('.folder-path-input').forEach(input => {
        if (input.value.trim()) {
            folders[input.dataset.key] = input.value.trim();
        }
    });

    // Validate at least one folder
    if (Object.keys(folders).length === 0) {
        showToast('Please configure at least one destination folder', 'error');
        return;
    }

    ManualSortState.folders = folders;

    // Save destination folders for quick access later
    Object.values(folders).forEach(path => {
        if (window.App && window.App.addRecentFolder) {
            window.App.addRecentFolder(path);
        }
    });

    // Get filters from unified AppState
    const f = AppState.filters;
    const generators = f.generators?.length > 0 ? f.generators : null;
    const ratings = f.ratings?.length > 0 ? f.ratings : null;
    const tags = f.tags?.length > 0 ? f.tags : null;
    const checkpoints = f.checkpoints?.length > 0 ? f.checkpoints : null;
    const loras = f.loras?.length > 0 ? f.loras : null;
    const prompts = f.prompts?.length > 0 ? f.prompts : null;
    const search = f.search?.trim() || null;
    const dimensions = {
        minWidth: f.minWidth,
        maxWidth: f.maxWidth,
        minHeight: f.minHeight,
        maxHeight: f.maxHeight,
        aspectRatio: f.aspectRatio
    };

    try {
        // Set folders on server
        await API.setSortFolders(folders);

        // Start session with unified filters including prompts and dimensions
        const result = await API.startSortSession(
            generators,
            tags,
            ratings,
            folders,
            checkpoints,
            loras,
            prompts,
            dimensions,
            search
        );

        if (result.total_images === 0) {
            showToast('No images to sort with current filters', 'error');
            return;
        }

        // Fetch images for gallery preview with paginated requests.
        const previewImages = [];
        let previewCursor = null;

        while (previewImages.length < result.total_images) {
            const imagesResult = await API.getImages({
                generators: generators,
                tags: tags,
                ratings: ratings,
                checkpoints: checkpoints,
                loras: loras,
                prompts: prompts,
                search: search,
                minWidth: f.minWidth,
                maxWidth: f.maxWidth,
                minHeight: f.minHeight,
                maxHeight: f.maxHeight,
                aspectRatio: f.aspectRatio,
                limit: 1000,
                cursor: previewCursor
            });

            if (!imagesResult?.images?.length) {
                break;
            }

            previewImages.push(...imagesResult.images);

            if (!imagesResult.has_more || !imagesResult.next_cursor) {
                break;
            }

            previewCursor = imagesResult.next_cursor;
        }

        ManualSortState.total = result.total_images;
        ManualSortState.index = 0;
        ManualSortState.combo = 0;
        ManualSortState.history = [];
        RedoStack.clear();
        ManualSortState.images = previewImages;
        ManualSortState.sortedCount = 0;
        ManualSortState.skippedCount = 0;
        ManualSortState.undoAvailable = false;
        ManualSortState.redoAvailable = false;
        ManualSortState.startTime = Date.now();
        ManualSortState.actionTimestamps = [];
        ManualSortState.currentImage = null;
        ManualSortState.currentTags = [];

        // Update folder names in UI
        updateFolderNames();

        activateSortingUi();

        try {
            await loadCurrentImage();
        } catch (error) {
            rollbackSortingUi();
            throw error;
        }

        // Play start sound
        window.AudioManager?.play('start');

    } catch (error) {
        showToast(formatUserError(error, "Failed to start sorting"), "error");
    }
}

function updateFolderNames() {
    const { $ } = window.App;

    Object.keys(DEFAULT_FOLDER_LABELS).forEach((key) => {
        const path = ManualSortState.folders[key];
        const nameEl = $(`#folder-name-${key}`);
        if (!nameEl) return;

        if (path) {
            const parts = path.split(/[/\\]/);
            nameEl.textContent = parts[parts.length - 1] || path;
        } else {
            nameEl.textContent = DEFAULT_FOLDER_LABELS[key] || key.toUpperCase();
        }
    });
}

function restoreFolderInputs() {
    document.querySelectorAll('.folder-path-input').forEach(input => {
        const key = input.dataset.key;
        input.value = key ? (ManualSortState.folders[key] || '') : '';
    });
    updateFolderNames();
}

function syncPreviewImages(imageIds = [], currentImage = null) {
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
        ManualSortState.images = [];
        return;
    }

    const existingById = new Map((ManualSortState.images || []).map(image => [image.id, image]));
    ManualSortState.images = imageIds.map(id => existingById.get(id) || { id });

    if (currentImage?.id) {
        const currentIndex = imageIds.indexOf(currentImage.id);
        if (currentIndex >= 0) {
            ManualSortState.images[currentIndex] = currentImage;
        }
    }
}

function updateHistoryControlState(state = {}) {
    if (typeof state.undo_available === 'boolean') {
        ManualSortState.undoAvailable = state.undo_available;
    }
    if (typeof state.redo_available === 'boolean') {
        ManualSortState.redoAvailable = state.redo_available;
    }

    document.querySelectorAll('[data-action="undo"]').forEach(btn => {
        const disabled = !ManualSortState.active || !ManualSortState.undoAvailable;
        btn.disabled = disabled;
        btn.setAttribute('aria-disabled', String(disabled));
    });

    document.querySelectorAll('[data-action="redo"]').forEach(btn => {
        const disabled = !ManualSortState.active || !ManualSortState.redoAvailable;
        btn.disabled = disabled;
        btn.setAttribute('aria-disabled', String(disabled));
    });
}

function activateSortingUi() {
    const { $ } = window.App;
    ManualSortState.active = true;
    document.removeEventListener('keydown', handleSortKeypress);
    document.addEventListener('keydown', handleSortKeypress);
    $('#sort-setup').style.display = 'none';
    $('#sort-interface').style.display = 'flex';
    updateHistoryControlState();
}

function rollbackSortingUi() {
    const { $ } = window.App;
    ManualSortState.active = false;
    document.removeEventListener('keydown', handleSortKeypress);
    $('#sort-interface').style.display = 'none';
    $('#sort-setup').style.display = 'block';
    updateHistoryControlState({ undo_available: false, redo_available: false });
}

function applyCurrentSortPayload(result, options = {}) {
    const { $, API } = window.App;
    const { cacheBust = false } = options;

    if (result?.folders && typeof result.folders === 'object') {
        ManualSortState.folders = { ...ManualSortState.folders, ...result.folders };
        restoreFolderInputs();
    }

    if (Array.isArray(result?.image_ids)) {
        syncPreviewImages(result.image_ids, result.image || null);
    }

    if (Number.isFinite(result?.sorted_count)) {
        ManualSortState.sortedCount = result.sorted_count;
    }
    if (Number.isFinite(result?.skipped_count)) {
        ManualSortState.skippedCount = result.skipped_count;
    }

    updateHistoryControlState(result || {});

    if (result?.done) {
        finishSorting();
        return false;
    }

    ManualSortState.currentImage = result.image;
    ManualSortState.currentTags = result.tags || [];
    ManualSortState.index = result.index;
    ManualSortState.total = result.total;

    if (ManualSortState.currentImage?.id && ManualSortState.images?.length > ManualSortState.index) {
        ManualSortState.images[ManualSortState.index] = ManualSortState.currentImage;
    }

    const imgWrapper = $('.current-image-wrapper');
    imgWrapper.classList.remove('fly-up', 'fly-down', 'fly-left', 'fly-right', 'skip');
    imgWrapper.classList.add('slide-in');

    const img = $('#current-image');
    const cacheSuffix = cacheBust ? `?t=${Date.now()}` : '';
    img.src = ManualSortState.currentImage?.id ? API.getImageUrl(ManualSortState.currentImage.id) + cacheSuffix : '';

    const tagsEl = $('#current-image-tags');
    const topTags = ManualSortState.currentTags.slice(0, 5);
    tagsEl.innerHTML = topTags
        .map(t => `<span class="image-tag">${escapeHtml(t.tag)}</span>`)
        .join('');

    updateProgress();

    setTimeout(() => {
        imgWrapper.classList.remove('slide-in');
    }, 300);

    return true;
}

async function resumeSavedSession() {
    const { $, API, showToast } = window.App;

    try {
        const session = await API.getCurrentSortImage();

        if (!session || session.done || !session.image) {
            const banner = $('#sort-resume-banner');
            if (banner) banner.style.display = 'none';
            showToast('No saved sorting session to resume', 'info');
            return;
        }

        ManualSortState.folders = session.folders || {};
        ManualSortState.startTime = Date.now();
        ManualSortState.combo = 0;
        ManualSortState.lastActionTime = 0;
        ManualSortState.history = [];
        ManualSortState.images = [];
        ManualSortState.currentImage = null;
        ManualSortState.currentTags = [];
        ManualSortState.actionTimestamps = [];
        ManualSortState.sortedCount = 0;
        ManualSortState.skippedCount = 0;
        ManualSortState.undoAvailable = false;
        ManualSortState.redoAvailable = false;
        RedoStack.clear();

        if (!Object.keys(ManualSortState.folders).length) {
            const folderResult = await API.get('/api/sort/folders');
            ManualSortState.folders = folderResult?.folders || {};
        }

        restoreFolderInputs();
        activateSortingUi();
        applyCurrentSortPayload(session);

        const banner = $('#sort-resume-banner');
        if (banner) banner.style.display = 'none';
    } catch (error) {
        rollbackSortingUi();
        const banner = $('#sort-resume-banner');
        if (banner) banner.style.display = 'flex';
        Logger.error('Failed to resume saved session:', error);
        showToast(formatUserError(error, 'Failed to resume saved session'), 'error');
    }
}

// ============== Load Current Image ==============

async function loadCurrentImage(prefetchedResult = null) {
    const { API } = window.App;

    try {
        const result = prefetchedResult || await API.getCurrentSortImage();
        applyCurrentSortPayload(result, { cacheBust: !!prefetchedResult });
    } catch (error) {
        Logger.error('Failed to load current image:', error);
        throw error;
    }
}

function updateProgress() {
    const { $ } = window.App;
    const percent = ManualSortState.total > 0
        ? (ManualSortState.index / ManualSortState.total) * 100
        : 0;

    $('#sort-progress-fill').style.width = percent + '%';
    $('#sort-progress-text').textContent = `${ManualSortState.index} / ${ManualSortState.total}`;

    // Enhanced progress stats
    const percentEl = $('#sort-percent');
    if (percentEl) percentEl.textContent = Math.round(percent) + '%';

    const sortedEl = $('#sort-sorted-count');
    if (sortedEl) sortedEl.textContent = ManualSortState.sortedCount;

    const skippedEl = $('#sort-skipped-count');
    if (skippedEl) skippedEl.textContent = ManualSortState.skippedCount;

    const remainingEl = $('#sort-remaining-count');
    if (remainingEl) remainingEl.textContent = Math.max(0, ManualSortState.total - ManualSortState.index);

    // Speed calculation (actions per second, rolling 10-second window)
    const speedEl = $('#sort-speed');
    if (speedEl) {
        const now = Date.now();
        const recentActions = ManualSortState.actionTimestamps.filter(t => now - t < 10000);
        const speed = recentActions.length > 1
            ? (recentActions.length / ((now - recentActions[0]) / 1000)).toFixed(1)
            : '0.0';
        speedEl.textContent = speed + '/s';
    }

    // Segmented progress bar
    const sortedFill = $('#sort-progress-sorted');
    const skippedFill = $('#sort-progress-skipped');
    if (sortedFill && skippedFill && ManualSortState.total > 0) {
        const sortedPct = (ManualSortState.sortedCount / ManualSortState.total) * 100;
        const skippedPct = (ManualSortState.skippedCount / ManualSortState.total) * 100;
        sortedFill.style.width = sortedPct + '%';
        skippedFill.style.width = skippedPct + '%';
    }

    // Minimap position
    const minimapPos = $('#minimap-position');
    if (minimapPos) minimapPos.textContent = `${ManualSortState.index + 1}/${ManualSortState.total}`;

    // Also update gallery preview
    updateGalleryPreview();
}

function updateGalleryPreview() {
    const { $, API } = window.App;
    const container = $('#preview-scroll');
    if (!container) return;

    // Get surrounding images (5 before, current, 10 after)
    const startIdx = Math.max(0, ManualSortState.index - 5);
    const endIdx = Math.min(ManualSortState.images?.length || 0, ManualSortState.index + 11);

    if (!ManualSortState.images || ManualSortState.images.length === 0) {
        container.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">No images loaded</span>';
        return;
    }

    const thumbsHTML = [];
    for (let i = startIdx; i < endIdx; i++) {
        const img = ManualSortState.images[i];
        if (!img) continue;

        let className = 'preview-thumb';
        if (i === ManualSortState.index) {
            className += ' current';
        } else if (i < ManualSortState.index) {
            className += ' processed';
        }

        thumbsHTML.push(`
            <div class="${className}" data-index="${i}" title="Image ${i + 1}">
                <img src="${API?.getThumbnailUrl?.(img.id) ?? `/api/image-thumbnail/${img.id}?size=256`}" alt="" loading="lazy">
            </div>
        `);
    }

    container.innerHTML = thumbsHTML.join('');

    // Scroll to keep current image centered
    const currentThumb = container.querySelector('.current');
    if (currentThumb) {
        currentThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
}

// ============== Handle Keypress ==============

function handleSortKeypress(e) {
    if (!ManualSortState.active) return;

    // Handle Ctrl+Z (undo) and Ctrl+Y / Ctrl+Shift+Z (redo) explicitly
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || e.key === 'Z') {
            e.preventDefault();
            if (e.shiftKey) {
                redoLastAction();
            } else {
                undoLastAction();
            }
            return;
        }
        if (e.key === 'y' || e.key === 'Y') {
            e.preventDefault();
            redoLastAction();
            return;
        }
        return; // Ignore other Ctrl+key combos
    }

    const action = KEY_MAP[e.key];
    if (!action) return;

    e.preventDefault();

    if (action === 'undo') {
        undoLastAction();
    } else if (action === 'redo') {
        redoLastAction();
    } else if (action === 'skip') {
        performSkip();
    } else if (action === 'exit') {
        exitSorting();
    } else {
        performMove(action);
    }
}

async function performMove(folderKey) {
    const { $, API, showToast } = window.App;

    // Prevent race condition from rapid keypresses
    if (ManualSortState.isProcessing) return;
    ManualSortState.isProcessing = true;

    try {
        // Check if folder is configured
        if (!ManualSortState.folders[folderKey]) {
            showToast(`Folder ${folderKey.toUpperCase()} not configured`, 'error');
            return;
        }

        // Animate folder highlight
        const folderEl = $(`.sort-folder[data-key="${folderKey}"]`);
        folderEl?.classList.add('active');
        setTimeout(() => folderEl?.classList.remove('active'), 300);

        // Animate image flying away
        const direction = DIRECTION_MAP[folderKey];
        const imgWrapper = $('.current-image-wrapper');
        imgWrapper.classList.add(`fly-${direction}`);

        // Play sound
        window.AudioManager?.play('move', folderKey);

        // Wait for animation
        await sleep(300);

        // Send action to server
        const result = await API.sortAction('move', folderKey);

        if (result.error) {
            updateHistoryControlState(result);
            showToast('Failed to move image: ' + result.error, 'error');
            return;
        }

        // Update combo/stats only after successful move
        updateCombo();
        ManualSortState.actionTimestamps.push(Date.now());
        const cutoff = Date.now() - 30000;
        ManualSortState.actionTimestamps = ManualSortState.actionTimestamps.filter(t => t > cutoff);
        await loadCurrentImage(result);

    } catch (error) {
        Logger.error('Failed to move image:', error);
        showToast('Failed to move image', 'error');
    } finally {
        ManualSortState.isProcessing = false;
    }
}

async function performSkip() {
    const { $, API, showToast } = window.App;

    // Prevent race condition from rapid keypresses
    if (ManualSortState.isProcessing) return;
    ManualSortState.isProcessing = true;

    try {
        // Animate skip
        const imgWrapper = $('.current-image-wrapper');
        imgWrapper.classList.add('skip');

        // Play skip sound
        window.AudioManager?.play('skip');

        // Reset combo
        ManualSortState.combo = 0;
        updateComboDisplay();

        await sleep(300);

        const result = await API.sortAction('skip');
        if (result.error) {
            updateHistoryControlState(result);
            showToast('Failed to skip image: ' + result.error, 'error');
            return;
        }

        ManualSortState.actionTimestamps.push(Date.now());
        const cutoff = Date.now() - 30000;
        ManualSortState.actionTimestamps = ManualSortState.actionTimestamps.filter(t => t > cutoff);

        await loadCurrentImage(result);

    } catch (error) {
        Logger.error('Failed to skip:', error);
        showToast('Failed to skip image', 'error');
    } finally {
        ManualSortState.isProcessing = false;
    }
}

async function undoLastAction() {
    const { $, API, showToast } = window.App;

    // Play undo sound
    window.AudioManager?.play('undo');

    // Reset combo
    ManualSortState.combo = 0;
    updateComboDisplay();

    try {
        const result = await API.sortAction('undo');

        // Check if there was nothing to undo
        if (result.status === 'no_history') {
            updateHistoryControlState(result);
            showToast('Nothing to undo', 'info');
            return;
        }

        await loadCurrentImage(result);
        showToast('Undid last action', 'info');
    } catch (error) {
        Logger.error('Failed to undo:', error);
        showToast('Failed to undo', 'error');
    }
}

// ============== Combo System ==============

const COMBO_WINDOW_MS = 2000;
const COMBO_SOUND_MILESTONE = 5;

function updateCombo() {
    const now = Date.now();
    const timeSinceLast = now - ManualSortState.lastActionTime;

    if (timeSinceLast < COMBO_WINDOW_MS) {
        ManualSortState.combo++;
    } else {
        ManualSortState.combo = 1;
    }

    ManualSortState.lastActionTime = now;
    updateComboDisplay();

    // Play combo sound at milestones
    if (ManualSortState.combo % COMBO_SOUND_MILESTONE === 0 && ManualSortState.combo > 0) {
        window.AudioManager?.play('combo');
    }
}

function updateComboDisplay() {
    const { $ } = window.App;
    const comboEl = $('#combo-display');
    const comboNum = comboEl.querySelector('.combo-number');

    if (ManualSortState.combo >= 3) {
        comboEl.classList.add('visible');
        comboNum.textContent = ManualSortState.combo;

        // Pulse animation
        comboNum.style.transform = 'scale(1.2)';
        setTimeout(() => {
            comboNum.style.transform = 'scale(1)';
        }, 100);
    } else {
        comboEl.classList.remove('visible');
    }
}

// ============== Finish/Exit ==============

function finishSorting() {
    const { $, showToast } = window.App;

    ManualSortState.active = false;
    ManualSortState.history = [];
    ManualSortState.undoAvailable = false;
    ManualSortState.redoAvailable = false;
    RedoStack.clear();
    document.removeEventListener('keydown', handleSortKeypress);
    updateHistoryControlState({ undo_available: false, redo_available: false });

    // Play finish sound
    window.AudioManager?.play('finish');

    // Calculate session stats
    const elapsed = ManualSortState.startTime
        ? Math.round((Date.now() - ManualSortState.startTime) / 1000)
        : 0;
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    showToast(
        `Sorting complete! ${ManualSortState.sortedCount} sorted, ${ManualSortState.skippedCount} skipped in ${timeStr}`,
        'success'
    );

    // Return to setup
    $('#sort-interface').style.display = 'none';
    $('#sort-setup').style.display = 'block';

    fetch('/api/sort/session', {method: 'DELETE'}).catch(e => {
        console.warn('Operation failed:', e);
    });

    // Refresh gallery
    if (window.App && window.App.loadImages) {
        window.App.loadImages();
    }
}

function exitSorting() {
    const { $, showToast } = window.App;

    ManualSortState.active = false;
    ManualSortState.undoAvailable = false;
    ManualSortState.redoAvailable = false;
    RedoStack.clear();
    document.removeEventListener('keydown', handleSortKeypress);
    updateHistoryControlState({ undo_available: false, redo_available: false });

    $('#sort-interface').style.display = 'none';
    $('#sort-setup').style.display = 'block';

    const remaining = Math.max(0, ManualSortState.total - ManualSortState.index);
    const banner = $('#sort-resume-banner');
    if (banner && remaining > 0) {
        banner.style.display = 'flex';
        const countEl = banner.querySelector('.resume-count');
        if (countEl) countEl.textContent = `${remaining} images remaining`;
    }

    showToast('Sorting paused. You can resume later.', 'info');

    // Refresh gallery to show updated image locations
    if (window.App && window.App.loadImages) {
        window.App.loadImages();
    }
}

// ============== Filter Summary ==============

function updateManualSortFilterSummary() {
    const { $, AppState } = window.App;
    if (!AppState || !AppState.filters) return;

    // Use shared filter summary formatter
    const summary = window.formatFilterSummary(AppState.filters);

    // Generators
    const genEl = $('#manual-sort-summary-generators');
    if (genEl) genEl.textContent = summary.generators;

    // Tags
    const tagEl = $('#manual-sort-summary-tags');
    if (tagEl) tagEl.textContent = summary.tags;

    // Ratings
    const ratingEl = $('#manual-sort-summary-ratings');
    if (ratingEl) ratingEl.textContent = summary.ratings;

    // Checkpoints
    const cpEl = $('#manual-sort-summary-checkpoints');
    if (cpEl) cpEl.textContent = summary.checkpoints;

    // Loras
    const loraEl = $('#manual-sort-summary-loras');
    if (loraEl) loraEl.textContent = summary.loras;

    // Prompts
    const promptEl = $('#manual-sort-summary-prompts');
    if (promptEl) promptEl.textContent = summary.prompts;

    // Search
    const searchEl = $('#manual-sort-summary-search');
    if (searchEl) searchEl.textContent = summary.search;

    // Dimensions
    const dimEl = $('#manual-sort-summary-dimensions');
    if (dimEl) dimEl.textContent = summary.dimensions;
}

// ============== Utilities ==============

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============== Initialize ==============

document.addEventListener('DOMContentLoaded', () => {
    initManualSort();
});

// Export for use by app.js and filter modal
window.ManualSortState = ManualSortState;
window.updateManualSortFilterSummary = updateManualSortFilterSummary;

// ============== Touch Controls for Mobile ==============

// Redo stack for manual sort
const RedoStack = {
    stack: [],
    
    push(action) {
        this.stack.push(action);
    },
    
    pop() {
        return this.stack.pop();
    },
    
    clear() {
        this.stack = [];
    },
    
    isEmpty() {
        return this.stack.length === 0;
    }
};

// Touch control button mapping
const TOUCH_BUTTONS = [
    { key: 'w', label: 'W', icon: '↑', action: 'move', folderKey: 'w' },
    { key: 'a', label: 'A', icon: '←', action: 'move', folderKey: 'a' },
    { key: 's', label: 'S', icon: '↓', action: 'move', folderKey: 's' },
    { key: 'd', label: 'D', icon: '→', action: 'move', folderKey: 'd' }
];

function createTouchControls() {
    const container = document.querySelector('.sort-interface');
    if (!container) return;
    
    // Check if already created
    if (document.getElementById('touch-sort-controls')) return;
    
    const touchControls = document.createElement('div');
    touchControls.id = 'touch-sort-controls';
    touchControls.className = 'touch-sort-controls';
    
    touchControls.innerHTML = `
        <button class="touch-sort-btn" data-key="w" aria-label="Move to W folder">
            <span class="key-label">W</span>
            <span>↑</span>
        </button>
        <button class="touch-sort-btn" data-key="a" aria-label="Move to A folder">
            <span class="key-label">A</span>
            <span>←</span>
        </button>
        <button class="touch-sort-btn btn-undo" data-action="undo" aria-label="Undo last action">
            <span class="key-label">Z</span>
            <span>Undo</span>
        </button>
        <button class="touch-sort-btn btn-redo" data-action="redo" aria-label="Redo last undone action">
            <span class="key-label">Y</span>
            <span>Redo</span>
        </button>
        <button class="touch-sort-btn" data-key="s" aria-label="Move to S folder">
            <span class="key-label">S</span>
            <span>↓</span>
        </button>
        <button class="touch-sort-btn" data-key="d" aria-label="Move to D folder">
            <span class="key-label">D</span>
            <span>→</span>
        </button>
        <button class="touch-sort-btn btn-skip" data-action="skip" aria-label="Skip current image">
            <span class="key-label">Space</span>
            <span>Skip</span>
        </button>
        <button class="touch-sort-btn btn-undo" data-action="exit" aria-label="Exit sorting">
            <span class="key-label">Esc</span>
            <span>Exit</span>
        </button>
    `;
    
    container.appendChild(touchControls);
    
    // Add event listeners
    touchControls.querySelectorAll('.touch-sort-btn').forEach(btn => {
        btn.addEventListener('click', handleTouchControl);
    });

    updateHistoryControlState();
}

function handleTouchControl(e) {
    if (!ManualSortState.active) return;
    
    const btn = e.currentTarget;
    const key = btn.dataset.key;
    const action = btn.dataset.action;
    
    if (key) {
        performMove(key);
    } else if (action) {
        switch (action) {
            case 'undo':
                undoLastAction();
                break;
            case 'redo':
                redoLastAction();
                break;
            case 'skip':
                performSkip();
                break;
            case 'exit':
                exitSorting();
                break;
        }
    }
}

// Redo functionality
async function redoLastAction() {
    const { API, showToast } = window.App;

    try {
        const result = await API.sortAction('redo');

        if (result.status === 'no_redo') {
            updateHistoryControlState(result);
            showToast('Nothing to redo', 'info');
            return;
        }

        if (result.error) {
            updateHistoryControlState(result);
            showToast(result.error, 'error');
            return;
        }

        window.AudioManager?.play('move');
        ManualSortState.actionTimestamps.push(Date.now());
        const cutoff = Date.now() - 30000;
        ManualSortState.actionTimestamps = ManualSortState.actionTimestamps.filter(t => t > cutoff);

        await loadCurrentImage(result);

        if (result.redone_action === 'move' && result.folder_key) {
            showToast('Redid move to ' + result.folder_key.toUpperCase(), 'info');
        } else {
            showToast('Redid skip', 'info');
        }
    } catch (error) {
        Logger.error('Failed to redo:', error);
        showToast('Failed to redo', 'error');
    }
}

// Export touch control functions
window.createTouchControls = createTouchControls;
window.RedoStack = RedoStack;
window.redoLastAction = redoLastAction;
