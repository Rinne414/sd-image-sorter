/**
 * app/handoffs.js — app.js decomposition, stage 2 (leaf sections).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js,
 * pre-split lines 14045-14145. Classic script: shares ONE global lexical
 * environment with app.js and the other app/ parts; index.html loads
 * every app/ file BEFORE app.js, so these top-level declarations stay
 * visible there. No behavior change intended.
 */
function normalizeCensorQueueSource(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return null;
    }

    const selectionToken = String(source.selectionToken || source.selection_token || '').trim();
    if (!selectionToken) return null;

    return {
        selectionToken,
        total: Math.max(0, Number(source.total ?? source.selectionTotal ?? source.selection_total ?? 0) || 0),
        exactTotal: source.exactTotal !== false && source.exact_total !== false,
        filterKey: typeof source.filterKey === 'string' ? source.filterKey : null,
        visibleImageIds: normalizeSelectionImageIds(source.visibleImageIds || source.visible_image_ids || []),
    };
}

function addToCensorQueue(imageIds = [], options = {}) {
    const tokenSource = normalizeCensorQueueSource(imageIds);
    const queuePayload = tokenSource || Array.from(
        new Set(
            (Array.isArray(imageIds) ? imageIds : [imageIds])
                .map((value) => Number(value))
                .filter((value) => Number.isFinite(value) && value > 0)
        )
    );

    if (typeof window.initCensorEdit === 'function') {
        window.initCensorEdit();
    }

    const runtimeHandler = window.CensorEdit?.addToQueue;
    if (typeof runtimeHandler === 'function') {
        return runtimeHandler(queuePayload, options);
    }

    switchView('censor');
    return false;
}

function openPromptBuildFromImage(imageId) {
    const normalizedId = Number(imageId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
        return false;
    }

    switchView('promptlab');
    if (typeof window.initPromptLab === 'function') {
        window.initPromptLab();
    }

    const buildTab = document.querySelector('.promptlab-tab[data-mode="build"]');
    buildTab?.click();
    const buildSource = document.getElementById('pl-build-source');
    if (buildSource) {
        // The Build catalog only lists the newest 200 images; a handoff can
        // target one outside it. Insert the option first, or `value = id`
        // silently resets to '' and loadBuildSource just hides the editor.
        window.PromptLab?.ensureBuildSourceOption?.(normalizedId);
        buildSource.value = String(normalizedId);
        buildSource.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    return false;
}

async function openReaderFromImage(imageId, filename = '') {
    const normalizedId = Number(imageId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
        return false;
    }

    switchView('reader');
    if (window.ImageReader?.openLibraryImage) {
        return window.ImageReader.openLibraryImage(normalizedId, filename);
    }
    return false;
}


async function openSimilarFromImage(imageId) {
    const normalizedId = Number(imageId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
        return false;
    }

    switchView('similar');
    if (typeof window.initSimilar === 'function') {
        window.initSimilar();
    }
    const input = $('#similar-search-id');
    if (input) input.value = String(normalizedId);
    if (window.SimilarImages?.searchByImage) {
        window.SimilarImages.searchByImage(normalizedId);
        return true;
    }
    return false;
}


