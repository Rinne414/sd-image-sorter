/**
 * Censor Editor - image filters (adjust tab) (split VERBATIM from censor-edit.js; god-file decomposition).
 * Self-contained IIFE: filter sliders/presets/preview, histogram, bake-to-canvas/targets; exports the window.__*CensorFilterPreview hooks.
 * Shared top-level bindings (CensorState, ...) are declared in censor/state.js;
 * classic-script global lexical scoping keeps them single instances across parts.
 * Load order is pinned in index.html - see censor/state.js for the full note.
 */
// =====================================================
// Image Filters & Adjustments
// =====================================================
(function initFilterControls() {
    const FILTER_DEFAULTS = {
        brightness: 0, contrast: 0, saturation: 0,
        hue: 0, blur: 0, sharpen: 0, temperature: 0, vignette: 0
    };
    const PRESETS = {
        reset:    { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, sharpen: 0, temperature: 0, vignette: 0 },
        vivid:    { brightness: 5, contrast: 20, saturation: 40, hue: 0, blur: 0, sharpen: 30, temperature: 0, vignette: 0 },
        warm:     { brightness: 5, contrast: 10, saturation: 15, hue: 0, blur: 0, sharpen: 0, temperature: 30, vignette: 10 },
        cool:     { brightness: 0, contrast: 10, saturation: 10, hue: 0, blur: 0, sharpen: 0, temperature: -30, vignette: 10 },
        bw:       { brightness: 0, contrast: 15, saturation: -100, hue: 0, blur: 0, sharpen: 10, temperature: 0, vignette: 0 },
        dramatic: { brightness: -5, contrast: 40, saturation: 20, hue: 0, blur: 0, sharpen: 40, temperature: 5, vignette: 30 }
    };

    let currentFilters = { ...FILTER_DEFAULTS };

    function getActiveCanvas() {
        return document.getElementById(CensorState.activeCanvasId || 'censor-canvas')
            || document.getElementById('censor-canvas');
    }

    function setSliders(values) {
        Object.entries(values).forEach(([key, val]) => {
            const slider = document.getElementById(`filter-${key}`);
            const label = document.getElementById(`filter-${key}-value`);
            if (slider) slider.value = val;
            if (label) label.textContent = key === 'hue' ? `${val}°` : String(val);
            currentFilters[key] = val;
        });
    }

    // Pre-filter pixel snapshot, captured on first slider use per session.
    // Lets sharpen/vignette preview without compounding, and lets us revert when
    // the slider returns to 0.
    let preFilterSnapshot = null;
    let preFilterCanvasRef = null;
    let pixelPreviewTimer = null;

    function invalidatePreFilterSnapshot() {
        preFilterSnapshot = null;
        preFilterCanvasRef = null;
        if (pixelPreviewTimer) {
            clearTimeout(pixelPreviewTimer);
            pixelPreviewTimer = null;
        }
    }

    function ensurePreFilterSnapshot(canvas) {
        if (preFilterSnapshot && preFilterCanvasRef === canvas) return;
        try {
            const ctx = canvas.getContext('2d');
            preFilterSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
            preFilterCanvasRef = canvas;
        } catch (err) {
            preFilterSnapshot = null;
            preFilterCanvasRef = null;
        }
    }

    function runPixelPreview(canvas) {
        if (!canvas) return;
        const needsSharpen = currentFilters.sharpen > 0;
        const needsVignette = currentFilters.vignette > 0;

        if (!needsSharpen && !needsVignette) {
            if (preFilterSnapshot && preFilterCanvasRef === canvas) {
                canvas.getContext('2d').putImageData(preFilterSnapshot, 0, 0);
            }
            return;
        }

        ensurePreFilterSnapshot(canvas);
        if (!preFilterSnapshot || preFilterCanvasRef !== canvas) return;

        const ctx = canvas.getContext('2d');
        ctx.putImageData(preFilterSnapshot, 0, 0);
        if (needsSharpen) applySharpen(canvas, currentFilters.sharpen / 100);
        if (needsVignette) applyVignette(canvas, currentFilters.vignette / 100);
    }

    function schedulePixelPreview(canvas) {
        if (pixelPreviewTimer) clearTimeout(pixelPreviewTimer);
        pixelPreviewTimer = setTimeout(() => {
            pixelPreviewTimer = null;
            runPixelPreview(canvas);
            updateFilterColorPreview(canvas);
        }, 100);
    }

    function applyFilterPreview() {
        const canvas = getActiveCanvas();
        if (!canvas) return;
        const wrapper = canvas.closest('.censor-canvas-wrapper-v2') || canvas.parentElement;
        if (!wrapper) return;

        const b = 100 + currentFilters.brightness;
        const c = 100 + currentFilters.contrast;
        const s = 100 + currentFilters.saturation;
        const h = currentFilters.hue;
        const bl = currentFilters.blur;

        const filters = [
            `brightness(${b}%)`,
            `contrast(${c}%)`,
            `saturate(${s}%)`,
            `hue-rotate(${h}deg)`,
        ];
        if (bl > 0) filters.push(`blur(${bl}px)`);

        // Temperature via sepia + hue
        if (currentFilters.temperature !== 0) {
            const temp = currentFilters.temperature;
            if (temp > 0) {
                filters.push(`sepia(${Math.abs(temp)}%)`);
            } else {
                filters.push(`sepia(${Math.abs(temp) * 0.3}%)`);
                filters.push(`hue-rotate(${180 + h}deg)`);
            }
        }

        canvas.style.filter = filters.join(' ');

        // Sharpen & vignette need real pixel ops; debounce to keep slider responsive.
        schedulePixelPreview(canvas);

        updateFilterColorPreview(canvas);
    }

    function updateFilterColorPreview(canvas) {
        const histCanvas = document.getElementById('filter-histogram-canvas');
        const paletteEl = document.getElementById('filter-color-palette');
        const previewEl = document.getElementById('filter-color-preview');
        if (!histCanvas || !previewEl || !canvas) return;

        try {
            const tmpCanvas = document.createElement('canvas');
            const sampleSize = 96;
            tmpCanvas.width = sampleSize;
            tmpCanvas.height = sampleSize;
            const tmpCtx = tmpCanvas.getContext('2d');
            tmpCtx.filter = canvas.style.filter || 'none';
            tmpCtx.drawImage(canvas, 0, 0, sampleSize, sampleSize);
            const data = tmpCtx.getImageData(0, 0, sampleSize, sampleSize).data;

            // Build histograms
            const rH = new Uint32Array(256);
            const gH = new Uint32Array(256);
            const bH = new Uint32Array(256);
            const buckets = {};

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i+1], b = data[i+2];
                rH[r]++; gH[g]++; bH[b]++;
                const br = Math.round(r / 32) * 32;
                const bg = Math.round(g / 32) * 32;
                const bb = Math.round(b / 32) * 32;
                const key = `${br},${bg},${bb}`;
                if (!buckets[key]) buckets[key] = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
                buckets[key].count++;
                buckets[key].sumR += r;
                buckets[key].sumG += g;
                buckets[key].sumB += b;
            }

            // Draw histogram
            const w = 256, h = 60;
            histCanvas.width = w;
            histCanvas.height = h;
            const ctx = histCanvas.getContext('2d');
            ctx.clearRect(0, 0, w, h);

            let maxVal = 1;
            for (let i = 1; i < 255; i++) {
                maxVal = Math.max(maxVal, rH[i], gH[i], bH[i]);
            }

            const drawCh = (hist, color) => {
                ctx.beginPath();
                ctx.moveTo(0, h);
                for (let i = 0; i < 256; i++) {
                    ctx.lineTo(i, h - Math.min(h, (hist[i] / maxVal) * h * 0.9));
                }
                ctx.lineTo(w, h);
                ctx.closePath();
                ctx.fillStyle = color;
                ctx.fill();
            };
            drawCh(bH, 'rgba(66,133,244,0.35)');
            drawCh(gH, 'rgba(52,211,153,0.35)');
            drawCh(rH, 'rgba(239,68,68,0.35)');

            // Palette
            if (paletteEl) {
                const sorted = Object.values(buckets).sort((a, b) => b.count - a.count).slice(0, 6);
                const total = sorted.reduce((s, b) => s + b.count, 0);
                paletteEl.innerHTML = sorted.map(b => {
                    const ar = Math.round(b.sumR / b.count);
                    const ag = Math.round(b.sumG / b.count);
                    const ab = Math.round(b.sumB / b.count);
                    const hex = '#' + [ar, ag, ab].map(v => v.toString(16).padStart(2, '0')).join('');
                    return `<div class="modal-color-swatch" onclick="navigator.clipboard.writeText('${hex}')" title="${hex}">
                        <span class="swatch-dot" style="background:${hex}"></span>
                        <span>${hex}</span>
                    </div>`;
                }).join('');
            }

            previewEl.style.display = '';
        } catch (e) {
            previewEl.style.display = 'none';
        }
    }

    function hasFilterChanges() {
        return Object.values(currentFilters).some(v => v !== 0);
    }

    async function renderFilteredDataUrlFromUrl(url) {
        const img = await loadImage(url);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.filter = buildFilterCssParts(currentFilters).join(' ');
        ctx.drawImage(img, 0, 0);

        if (currentFilters.sharpen > 0) {
            applySharpenToCanvasPixels(canvas, currentFilters.sharpen / 100);
        }
        if (currentFilters.vignette > 0) {
            applyVignetteToCanvasPixels(canvas, currentFilters.vignette / 100);
        }

        return canvas.toDataURL('image/png');
    }

    async function bakeFiltersToTargets(targetIds) {
        if (!Array.isArray(targetIds) || targetIds.length === 0) {
            window.App?.showToast?.(censorT('censor.noTargetImagesSelected', null, 'No target images selected'), 'warning');
            return;
        }

        if (!hasFilterChanges()) {
            window.App?.showToast?.(censorT('censor.noFilterChanges', null, 'No filter changes to apply'), 'info');
            return;
        }

        showLoading(true, censorT('censor.filterApplyBatchLoading', { count: targetIds.length }, 'Filter · applying to {count} image(s)...'));
        let applied = 0;
        const historyEntry = {
            type: 'filter-batch',
            targetIds: [...targetIds],
            snapshots: [],
        };

        try {
            for (const targetId of targetIds) {
                const item = CensorState.queue.find(entry => entry.id === targetId);
                if (!item) continue;
                const beforeModified = Boolean(item.isModified);
                if (shouldUseProxyEditMode(item)) {
                    const beforeOperations = cloneEditOperations(item.editOperations || []);
                    const beforePreviewDataUrl = item.previewDataUrl || null;
                    item.editOperations = [
                        ...(item.editOperations || []),
                        {
                            kind: 'filter',
                            values: { ...currentFilters },
                        },
                    ];
                    await renderProxyPreviewDataForItem(item);
                    historyEntry.snapshots.push({
                        id: targetId,
                        beforeDataUrl: null,
                        beforePreviewDataUrl,
                        beforeOperations,
                        beforeModified,
                        afterDataUrl: null,
                        afterPreviewDataUrl: item.previewDataUrl || null,
                        afterOperations: cloneEditOperations(item.editOperations || []),
                        afterModified: Boolean(item.isModified),
                    });
                } else {
                    const sourceUrl = item.currentDataUrl || item.originalUrl;
                    const beforeDataUrl = item.currentDataUrl || null;
                    item.currentDataUrl = await renderFilteredDataUrlFromUrl(sourceUrl);
                    item.isModified = true;
                    historyEntry.snapshots.push({
                        id: targetId,
                        beforeDataUrl,
                        beforeModified,
                        afterDataUrl: item.currentDataUrl || null,
                        afterModified: Boolean(item.isModified),
                    });
                }
                applied += 1;
            }

            renderQueue();
            if (CensorState.activeId && targetIds.includes(CensorState.activeId)) {
                await loadCanvasImage(CensorState.activeId);
            }

            setSliders(FILTER_DEFAULTS);
            pushFilterActionHistory(historyEntry);
            window.App?.showToast?.(censorT('censor.filtersAppliedCount', { count: applied }, 'Applied filters to {count} image(s)'), 'success');
        } finally {
            showLoading(false);
        }
    }

    async function bakeFiltersToCanvas() {
        const canvas = getActiveCanvas();
        if (!canvas || !CensorState.activeId) {
            window.App?.showToast?.(censorT('censor.noImageLoaded', null, 'No image loaded — select an image first'), 'warning');
            return;
        }

        if (!hasFilterChanges()) {
            window.App?.showToast?.(censorT('censor.noFilterChanges', null, 'No filter changes to apply'), 'info');
            return;
        }

        // Check canvas has actual content
        if (canvas.width === 0 || canvas.height === 0) {
            window.App?.showToast?.(censorT('censor.canvasEmpty', null, 'Canvas is empty — load an image first'), 'warning');
            return;
        }

        // Restore pre-preview pixels so sharpen/vignette aren't double-applied.
        if (pixelPreviewTimer) { clearTimeout(pixelPreviewTimer); pixelPreviewTimer = null; }
        if (preFilterSnapshot && preFilterCanvasRef === canvas) {
            canvas.getContext('2d').putImageData(preFilterSnapshot, 0, 0);
        }

        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = canvas.width;
        tmpCanvas.height = canvas.height;
        const ctx = tmpCanvas.getContext('2d');
        ctx.filter = canvas.style.filter || 'none';
        ctx.drawImage(canvas, 0, 0);
        canvas.style.filter = 'none';

        const activeItem = CensorState.queue.find(i => i.id === CensorState.activeId);
        const historyEntry = {
            type: 'filter-batch',
            targetIds: [CensorState.activeId],
            snapshots: activeItem ? [{
                id: activeItem.id,
                beforeDataUrl: activeItem.currentDataUrl || null,
                beforePreviewDataUrl: activeItem.previewDataUrl || null,
                beforeOperations: cloneEditOperations(activeItem.editOperations || []),
                beforeModified: Boolean(activeItem.isModified),
                afterDataUrl: null,
                afterPreviewDataUrl: null,
                afterOperations: [],
                afterModified: true,
            }] : [],
        };

        if (isProxyEditActive() && activeItem) {
            canvas.style.filter = 'none';
            activeItem.editOperations = [
                ...(activeItem.editOperations || []),
                {
                    kind: 'filter',
                    values: { ...currentFilters },
                },
            ];
            activeItem.currentDataUrl = null;
            activeItem.isModified = true;
            CensorState.operationRedoStack = [];
            await loadCanvasImage(CensorState.activeId);
            if (historyEntry.snapshots[0]) {
                historyEntry.snapshots[0].afterPreviewDataUrl = activeItem.previewDataUrl || null;
                historyEntry.snapshots[0].afterOperations = cloneEditOperations(activeItem.editOperations || []);
                historyEntry.snapshots[0].afterModified = Boolean(activeItem.isModified);
            }
            invalidatePreFilterSnapshot();
            setSliders(FILTER_DEFAULTS);
            pushFilterActionHistory(historyEntry);
            window.App?.showToast?.(
                censorT('censor.canvasFiltersApplied', null, 'Filters applied to canvas'),
                'success'
            );
            return;
        }

        const destCtx = canvas.getContext('2d');
        destCtx.clearRect(0, 0, canvas.width, canvas.height);
        destCtx.drawImage(tmpCanvas, 0, 0);

        // Apply sharpen if needed
        if (currentFilters.sharpen > 0) {
            applySharpenToCanvasPixels(canvas, currentFilters.sharpen / 100);
        }

        // Apply vignette if needed
        if (currentFilters.vignette > 0) {
            applyVignetteToCanvasPixels(canvas, currentFilters.vignette / 100);
        }

        // Mark the active item as modified
        if (activeItem) {
            activeItem.isModified = true;
            activeItem.currentDataUrl = canvas.toDataURL('image/png');
            if (historyEntry.snapshots[0]) {
                historyEntry.snapshots[0].afterDataUrl = activeItem.currentDataUrl || null;
                historyEntry.snapshots[0].afterModified = Boolean(activeItem.isModified);
            }
        }

        // Reset sliders after applying to current
        await loadCanvasImage(CensorState.activeId);
        invalidatePreFilterSnapshot();
        setSliders(FILTER_DEFAULTS);
        pushFilterActionHistory(historyEntry);
        window.App?.showToast?.(
            censorT('censor.canvasFiltersApplied', null, 'Filters applied to canvas'),
            'success'
        );
    }

    function applySharpen(canvas, amount) {
        applySharpenToCanvasPixels(canvas, amount);
    }

    function applyVignette(canvas, amount) {
        applyVignetteToCanvasPixels(canvas, amount);
    }

    // Bind events after DOM is ready
    document.addEventListener('DOMContentLoaded', () => {
        // Slider events
        Object.keys(FILTER_DEFAULTS).forEach(key => {
            const slider = document.getElementById(`filter-${key}`);
            if (slider) {
                slider.addEventListener('input', () => {
                    const val = Number(slider.value);
                    const label = document.getElementById(`filter-${key}-value`);
                    if (label) label.textContent = key === 'hue' ? `${val}°` : String(val);
                    currentFilters[key] = val;
                    applyFilterPreview();
                });
            }
        });

        // Preset buttons
        Object.entries(PRESETS).forEach(([name, values]) => {
            const btn = document.getElementById(`btn-filter-${name}`);
            if (btn) {
                btn.addEventListener('click', () => {
                    if (name === 'reset') {
                        const canvas = getActiveCanvas();
                        if (canvas && preFilterSnapshot && preFilterCanvasRef === canvas) {
                            canvas.getContext('2d').putImageData(preFilterSnapshot, 0, 0);
                        }
                        invalidatePreFilterSnapshot();
                        setSliders(values);
                        canvas && (canvas.style.filter = '');
                        updateFilterColorPreview(canvas);
                        return;
                    }
                    setSliders(values);
                    applyFilterPreview();
                });
            }
        });

        // Apply button
        const applyBtn = document.getElementById('btn-apply-filters');
        if (applyBtn) {
            applyBtn.addEventListener('click', bakeFiltersToCanvas);
        }

        document.getElementById('btn-apply-filters-selected')?.addEventListener('click', async () => {
            await bakeFiltersToTargets(getOrderedSelectedQueueIds());
        });

        document.getElementById('btn-apply-filters-all')?.addEventListener('click', async () => {
            await bakeFiltersToTargets(CensorState.queue.map(item => item.id));
        });
    });

    window.__updateCensorFilterPreview = applyFilterPreview;
    window.__invalidateCensorFilterPreview = invalidatePreFilterSnapshot;
    window.__censorHasPendingFilterPreview = hasFilterChanges;
})();
