/**
 * smart-tag/sources.js — smart-tag.js decomposition.
 * Extracted VERBATIM from frontend/js/smart-tag.js pre-split lines 59-174:
 * getDatasetSources() kept WHOLE — the six prioritized source branches
 * (explicit Gallery-armed scope -> Dataset Maker ids/paths/scan-token +
 * large-selection token swap -> dataset DOM scrape -> gallery filter
 * token -> gallery selection). The branch ORDER is load-bearing
 * (smart-tag-pins.spec.ts pin 3). Classic script: loads after
 * smart-tag/state.js; family renames applied ($$ -> smartTag$$).
 */
'use strict';
    function getDatasetSources() {
        // Aurora Phase 3 (#25b): an explicit Gallery-armed scope wins outright.
        if (pendingExplicitScope && Array.isArray(pendingExplicitScope.imageIds) && pendingExplicitScope.imageIds.length) {
            const ids = pendingExplicitScope.imageIds.slice();
            return {
                imageIds: ids,
                imagePaths: [],
                selectionToken: null,
                selectionTotal: 0,
                datasetScanToken: null,
                datasetScanTotal: 0,
                total: ids.length,
                source: 'gallery-armed',
            };
        }
        const imageIds = [];
        const imagePaths = [];
        let selectionToken = null;
        let selectionTotal = 0;
        let datasetScanToken = null;
        let datasetScanTotal = 0;
        if (window.DatasetMaker && Array.isArray(window.DatasetMaker.imageIds)) {
            let localCount = 0;
            for (const rawId of window.DatasetMaker.imageIds) {
                const id = Number(rawId);
                if (!Number.isFinite(id)) continue;
                if (window.DatasetMaker.isLocalId?.(id)) {
                    localCount += 1;
                    const path = window.DatasetMaker.localItemPaths?.get?.(id);
                    if (path) imagePaths.push(path);
                } else if (id > 0) {
                    imageIds.push(id);
                }
            }
            datasetScanToken = String(window.DatasetMaker._folderScanToken || '').trim() || null;
            datasetScanTotal = Number(window.DatasetMaker._folderScanTotal || 0);
            if (datasetScanToken && datasetScanTotal > 0 && localCount === datasetScanTotal) {
                imagePaths.length = 0;
            } else {
                datasetScanToken = null;
                datasetScanTotal = 0;
            }

            const activeSelectionToken = window.AppFilterAccess?.getActiveSelectionToken?.() || null;
            const activeSelectionTotal = Number(window.AppFilterAccess?.getSelectionTotal?.() || 0);
            if (
                activeSelectionToken
                && activeSelectionTotal === imageIds.length
                && imageIds.length > LARGE_EXPLICIT_SOURCE_LIMIT
                && imagePaths.length === 0
                && !datasetScanToken
            ) {
                imageIds.length = 0;
                selectionToken = activeSelectionToken;
                selectionTotal = activeSelectionTotal;
            }
            const datasetTotal = imageIds.length + imagePaths.length + datasetScanTotal;
            const sourceTotal = datasetTotal + selectionTotal;
            if (sourceTotal > 0) {
                return {
                    imageIds,
                    imagePaths,
                    selectionToken,
                    selectionTotal,
                    datasetScanToken,
                    datasetScanTotal,
                    total: sourceTotal,
                    source: 'dataset',
                };
            }
        }
        const fromDom = smartTag$$('#dataset-queue-list [data-image-id]')
            .map((el) => parseInt(el.dataset.imageId, 10))
            .filter((n) => Number.isFinite(n) && n > 0);
        if (fromDom.length > 0) {
            return {
                imageIds: fromDom,
                imagePaths: [],
                selectionToken: null,
                selectionTotal: 0,
                datasetScanToken: null,
                datasetScanTotal: 0,
                total: fromDom.length,
                source: 'dataset-dom',
            };
        }

        selectionToken = window.AppFilterAccess?.getActiveSelectionToken?.() || null;
        if (selectionToken) {
            selectionTotal = Number(window.AppFilterAccess?.getSelectionTotal?.() || 0);
            return {
                imageIds: [],
                imagePaths: [],
                selectionToken,
                selectionTotal,
                datasetScanToken: null,
                datasetScanTotal: 0,
                total: selectionTotal,
                source: 'gallery-filter',
            };
        }
        const selectedIds = (window.AppFilterAccess?.getSelectedImageIds?.() || [])
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0);
        return {
            imageIds: selectedIds,
            imagePaths: [],
            selectionToken: null,
            selectionTotal: 0,
            datasetScanToken: null,
            datasetScanTotal: 0,
            total: selectedIds.length,
            source: 'gallery-selection',
        };
    }

