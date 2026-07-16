/**
 * Censor Editor - edit-operation engine (split VERBATIM from censor-edit.js; god-file decomposition).
 * Operation replay onto canvases, stroke/geometry/mask ops, mask normalization, bounds math, proxy preview rendering, region/mask bake onto canvas.
 * Shared top-level bindings (CensorState, ...) are declared in censor/state.js;
 * classic-script global lexical scoping keeps them single instances across parts.
 * Load order is pinned in index.html - see censor/state.js for the full note.
 */
function buildFilterCssParts(values = {}) {
    const brightness = 100 + Number(values.brightness || 0);
    const contrast = 100 + Number(values.contrast || 0);
    const saturation = 100 + Number(values.saturation || 0);
    const hue = Number(values.hue || 0);
    const blur = Number(values.blur || 0);
    const temperature = Number(values.temperature || 0);
    const filters = [
        `brightness(${brightness}%)`,
        `contrast(${contrast}%)`,
        `saturate(${saturation}%)`,
        `hue-rotate(${hue}deg)`,
    ];
    if (blur > 0) filters.push(`blur(${blur}px)`);
    if (temperature !== 0) {
        if (temperature > 0) {
            filters.push(`sepia(${Math.abs(temperature)}%)`);
        } else {
            filters.push(`sepia(${Math.abs(temperature) * 0.3}%)`);
            filters.push(`hue-rotate(${180 + hue}deg)`);
        }
    }
    return filters;
}

function applySharpenToCanvasPixels(canvas, amount) {
    if (!(canvas instanceof HTMLCanvasElement) || amount <= 0) return;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const width = canvas.width;
    const height = canvas.height;
    const copy = new Uint8ClampedArray(data);
    const kernel = [0, -amount, 0, -amount, 1 + 4 * amount, -amount, 0, -amount, 0];

    for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
            for (let channel = 0; channel < 3; channel += 1) {
                let value = 0;
                for (let ky = -1; ky <= 1; ky += 1) {
                    for (let kx = -1; kx <= 1; kx += 1) {
                        value += copy[((y + ky) * width + (x + kx)) * 4 + channel] * kernel[(ky + 1) * 3 + (kx + 1)];
                    }
                }
                data[(y * width + x) * 4 + channel] = Math.max(0, Math.min(255, value));
            }
        }
    }
    ctx.putImageData(imageData, 0, 0);
}

function applyVignetteToCanvasPixels(canvas, amount) {
    if (!(canvas instanceof HTMLCanvasElement) || amount <= 0) return;
    const ctx = canvas.getContext('2d');
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const radius = Math.max(cx, cy);
    const gradient = ctx.createRadialGradient(cx, cy, radius * (1 - amount * 0.5), cx, cy, radius);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, `rgba(0,0,0,${amount * 0.7})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

async function applyFilterValuesToCanvas(canvas, values = {}) {
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.filter = buildFilterCssParts(values).join(' ');
    tempCtx.drawImage(canvas, 0, 0);

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempCanvas, 0, 0);

    const sharpen = Number(values.sharpen || 0);
    const vignette = Number(values.vignette || 0);
    if (sharpen > 0) {
        applySharpenToCanvasPixels(canvas, sharpen / 100);
    }
    if (vignette > 0) {
        applyVignetteToCanvasPixels(canvas, vignette / 100);
    }
}

function scaleRegionGeometry(region, scaleX, scaleY) {
    const scaled = { ...region };
    if (Array.isArray(region?.box) && region.box.length === 4) {
        scaled.box = [
            Number(region.box[0] || 0) * scaleX,
            Number(region.box[1] || 0) * scaleY,
            Number(region.box[2] || 0) * scaleX,
            Number(region.box[3] || 0) * scaleY,
        ];
    }
    if (Array.isArray(region?.polygon)) {
        scaled.polygon = region.polygon
            .filter((point) => Array.isArray(point) && point.length >= 2)
            .map((point) => [Number(point[0] || 0) * scaleX, Number(point[1] || 0) * scaleY]);
    }
    return scaled;
}

function createWorkingCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(Number(width || 1)));
    canvas.height = Math.max(1, Math.round(Number(height || 1)));
    return canvas;
}

function getDrawableDimensions(source) {
    return {
        width: Number(source?.naturalWidth || source?.videoWidth || source?.width || 0),
        height: Number(source?.naturalHeight || source?.videoHeight || source?.height || 0),
    };
}

function clampCanvasBounds(bounds, width, height) {
    const x1 = Math.max(0, Math.floor(Number(bounds?.x1 ?? bounds?.[0] ?? 0)));
    const y1 = Math.max(0, Math.floor(Number(bounds?.y1 ?? bounds?.[1] ?? 0)));
    const x2 = Math.min(width, Math.ceil(Number(bounds?.x2 ?? bounds?.[2] ?? width)));
    const y2 = Math.min(height, Math.ceil(Number(bounds?.y2 ?? bounds?.[3] ?? height)));
    if (!(x2 > x1) || !(y2 > y1)) {
        return null;
    }
    return {
        x1,
        y1,
        x2,
        y2,
        width: x2 - x1,
        height: y2 - y1,
    };
}

function scaleOperationEffectValue(value, scaleX = 1, scaleY = 1) {
    return Math.max(1, Math.round(Number(value || 1) * Math.max(scaleX, scaleY)));
}

function cropCanvasRegion(canvas, bounds) {
    const regionCanvas = createWorkingCanvas(bounds.width, bounds.height);
    const regionCtx = regionCanvas.getContext('2d');
    regionCtx.drawImage(
        canvas,
        bounds.x1,
        bounds.y1,
        bounds.width,
        bounds.height,
        0,
        0,
        bounds.width,
        bounds.height
    );
    return regionCanvas;
}

function drawScaledSourceCrop(ctx, sourceImage, sourceBounds, destBounds, options = {}) {
    if (!sourceImage || !ctx) return;
    const sourceDims = getDrawableDimensions(sourceImage);
    const referenceWidth = Math.max(1, Number(options.referenceWidth || ctx.canvas?.width || destBounds?.width || 1));
    const referenceHeight = Math.max(1, Number(options.referenceHeight || ctx.canvas?.height || destBounds?.height || 1));
    const scaleX = sourceDims.width > 0 ? (sourceDims.width / referenceWidth) : 1;
    const scaleY = sourceDims.height > 0 ? (sourceDims.height / referenceHeight) : 1;
    const sx = Math.max(0, Number(sourceBounds.x || 0) * scaleX);
    const sy = Math.max(0, Number(sourceBounds.y || 0) * scaleY);
    const sw = Math.max(1, Number(sourceBounds.width || 1) * scaleX);
    const sh = Math.max(1, Number(sourceBounds.height || 1) * scaleY);
    ctx.drawImage(
        sourceImage,
        sx,
        sy,
        sw,
        sh,
        Number(destBounds.x || 0),
        Number(destBounds.y || 0),
        Number(destBounds.width || 1),
        Number(destBounds.height || 1)
    );
}

function buildPixelatedCanvas(sourceCanvas, blockSize) {
    const downscale = Math.max(1, Math.round(Number(blockSize || 1)));
    const smallW = Math.max(1, Math.floor(sourceCanvas.width / downscale));
    const smallH = Math.max(1, Math.floor(sourceCanvas.height / downscale));
    const tinyCanvas = createWorkingCanvas(smallW, smallH);
    const tinyCtx = tinyCanvas.getContext('2d');
    tinyCtx.imageSmoothingEnabled = false;
    tinyCtx.drawImage(sourceCanvas, 0, 0, smallW, smallH);

    const pixelatedCanvas = createWorkingCanvas(sourceCanvas.width, sourceCanvas.height);
    const pixelatedCtx = pixelatedCanvas.getContext('2d');
    pixelatedCtx.imageSmoothingEnabled = false;
    pixelatedCtx.drawImage(tinyCanvas, 0, 0, smallW, smallH, 0, 0, sourceCanvas.width, sourceCanvas.height);
    return pixelatedCanvas;
}

function drawStrokeMaskOnCanvas(maskCtx, points, brushSize) {
    if (!maskCtx || !Array.isArray(points) || points.length === 0) return;
    const safeBrushSize = Math.max(1, Number(brushSize || 1));
    const radius = safeBrushSize / 2;
    maskCtx.fillStyle = '#fff';
    maskCtx.strokeStyle = '#fff';
    if (points.length === 1) {
        const point = points[0];
        maskCtx.beginPath();
        maskCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        maskCtx.fill();
        return;
    }

    maskCtx.lineWidth = safeBrushSize;
    maskCtx.lineCap = 'round';
    maskCtx.lineJoin = 'round';
    maskCtx.beginPath();
    maskCtx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
        maskCtx.lineTo(points[index].x, points[index].y);
    }
    maskCtx.stroke();

    [points[0], points[points.length - 1]].forEach((point) => {
        maskCtx.beginPath();
        maskCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        maskCtx.fill();
    });
}

function getStrokeMaskBounds(points, brushSize, width, height) {
    if (!Array.isArray(points) || points.length === 0) return null;
    const radius = Math.max(1, Number(brushSize || 1)) / 2;
    const xs = points.map((point) => Number(point?.x || 0));
    const ys = points.map((point) => Number(point?.y || 0));
    return clampCanvasBounds({
        x1: Math.min(...xs) - radius,
        y1: Math.min(...ys) - radius,
        x2: Math.max(...xs) + radius,
        y2: Math.max(...ys) + radius,
    }, width, height);
}

function getRegionBounds(regions = [], width, height) {
    const xs = [];
    const ys = [];
    regions.forEach((region) => {
        if (Array.isArray(region?.box) && region.box.length === 4) {
            xs.push(Number(region.box[0] || 0), Number(region.box[2] || 0));
            ys.push(Number(region.box[1] || 0), Number(region.box[3] || 0));
        }
        if (Array.isArray(region?.polygon)) {
            region.polygon.forEach((point) => {
                if (!Array.isArray(point) || point.length < 2) return;
                xs.push(Number(point[0] || 0));
                ys.push(Number(point[1] || 0));
            });
        }
    });
    if (!xs.length || !ys.length) return null;
    return clampCanvasBounds({
        x1: Math.min(...xs),
        y1: Math.min(...ys),
        x2: Math.max(...xs),
        y2: Math.max(...ys),
    }, width, height);
}

function getMaskCanvasBounds(maskCanvas) {
    if (!(maskCanvas instanceof HTMLCanvasElement) || !maskCanvas.width || !maskCanvas.height) return null;
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    const pixels = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    let minX = maskCanvas.width;
    let minY = maskCanvas.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < maskCanvas.height; y += 1) {
        for (let x = 0; x < maskCanvas.width; x += 1) {
            const alpha = pixels[(y * maskCanvas.width + x) * 4 + 3];
            if (alpha <= 0) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }

    if (maxX < minX || maxY < minY) return null;
    return clampCanvasBounds({
        x1: minX,
        y1: minY,
        x2: maxX + 1,
        y2: maxY + 1,
    }, maskCanvas.width, maskCanvas.height);
}

function renderMaskStyleToCanvas(canvas, maskCanvas, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement) || !(maskCanvas instanceof HTMLCanvasElement)) return;
    const bounds = clampCanvasBounds(
        options.bounds || getMaskCanvasBounds(maskCanvas),
        canvas.width,
        canvas.height
    );
    if (!bounds) return;

    const style = String(options.style || 'mosaic').trim().toLowerCase();
    const blockSize = Math.max(1, Math.round(Number(options.blockSize || 16)));
    const blurRadius = Math.max(1, Math.round(Number(options.blurRadius || 20)));
    const maskCrop = cropCanvasRegion(maskCanvas, bounds);
    const sourceCrop = cropCanvasRegion(canvas, bounds);
    const effectCanvas = createWorkingCanvas(bounds.width, bounds.height);
    const effectCtx = effectCanvas.getContext('2d');

    if (style === 'pen') {
        effectCtx.globalAlpha = Math.max(0, Math.min(1, Number(options.penOpacity ?? 1)));
        effectCtx.fillStyle = options.penColor || '#ff0000';
        effectCtx.fillRect(0, 0, bounds.width, bounds.height);
        effectCtx.globalAlpha = 1;
    } else if (style === 'eraser') {
        drawScaledSourceCrop(
            effectCtx,
            options.originalImage || canvas,
            { x: bounds.x1, y: bounds.y1, width: bounds.width, height: bounds.height },
            { x: 0, y: 0, width: bounds.width, height: bounds.height },
            { referenceWidth: canvas.width, referenceHeight: canvas.height }
        );
    } else if (style === 'white_bar') {
        effectCtx.fillStyle = '#fff';
        effectCtx.fillRect(0, 0, bounds.width, bounds.height);
    } else if (style === 'black_bar' || style === 'black' || style === 'solid') {
        effectCtx.fillStyle = '#000';
        effectCtx.fillRect(0, 0, bounds.width, bounds.height);
    } else if (style === 'blur') {
        effectCtx.filter = `blur(${blurRadius}px)`;
        effectCtx.drawImage(sourceCrop, 0, 0);
        effectCtx.filter = 'none';
    } else {
        effectCtx.drawImage(buildPixelatedCanvas(sourceCrop, blockSize), 0, 0);
    }

    effectCtx.globalCompositeOperation = 'destination-in';
    effectCtx.drawImage(maskCrop, 0, 0);
    effectCtx.globalCompositeOperation = 'source-over';

    const ctx = canvas.getContext('2d');
    ctx.drawImage(effectCanvas, bounds.x1, bounds.y1);
}

function createStrokeOperationFromCurrentState(tool) {
    const operation = {
        kind: 'stroke',
        tool,
        points: [],
        brush_size: Number(CensorState.brushSize || 1),
    };
    if (tool === 'brush') {
        operation.style = CensorState.style;
        operation.block_size = Number(CensorState.blockSize || 16);
        operation.blur_radius = Math.max(8, Number(CensorState.blockSize || 16));
    } else if (tool === 'pen') {
        operation.pen_color = CensorState.penColor;
        operation.pen_opacity = Number(CensorState.penOpacity || 1);
    }
    return operation;
}

async function applyStrokeOperationToCanvas(canvas, originalImage, operation, scaleX = 1, scaleY = 1) {
    if (!(canvas instanceof HTMLCanvasElement) || !operation) return;
    const points = Array.isArray(operation.points) ? operation.points : [];
    if (!points.length) return;

    const tool = String(operation.tool || 'brush').trim().toLowerCase();
    const canvasPoints = points.map((point) => ({
        x: Number(point?.x || 0) * scaleX,
        y: Number(point?.y || 0) * scaleY,
    }));
    const scaledBrushSize = Math.max(1, Number(operation.brush_size || 1) * Math.max(scaleX, scaleY));
    const ctx = canvas.getContext('2d');

    if (tool === 'clone') {
        for (const point of canvasPoints) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(point.x, point.y, scaledBrushSize / 2, 0, Math.PI * 2);
            performClone(ctx, point.x, point.y, scaledBrushSize, {
                sourceImage: originalImage,
                cloneOffset: {
                    x: Number(operation.clone_offset?.x || 0) * scaleX,
                    y: Number(operation.clone_offset?.y || 0) * scaleY,
                },
            });
            ctx.restore();
        }
        return;
    }

    const maskCanvas = createWorkingCanvas(canvas.width, canvas.height);
    const maskCtx = maskCanvas.getContext('2d');
    drawStrokeMaskOnCanvas(maskCtx, canvasPoints, scaledBrushSize);
    renderMaskStyleToCanvas(canvas, maskCanvas, {
        bounds: getStrokeMaskBounds(canvasPoints, scaledBrushSize, canvas.width, canvas.height),
        style: tool === 'brush' ? operation.style : tool,
        blockSize: scaleOperationEffectValue(operation.block_size || 16, scaleX, scaleY),
        blurRadius: scaleOperationEffectValue(operation.blur_radius || 20, scaleX, scaleY),
        penColor: operation.pen_color,
        penOpacity: operation.pen_opacity,
        originalImage,
    });
}

async function applyGeometryOperationToCanvas(canvas, originalImage, operation, scaleX = 1, scaleY = 1) {
    if (!(canvas instanceof HTMLCanvasElement) || !operation) return;
    const sourceImage = originalImage || CensorState.originalImage;
    const regions = Array.isArray(operation.regions) ? operation.regions : [];
    if (!regions.length) return;

    const scaledRegions = regions.map((region) => scaleRegionGeometry(region, scaleX, scaleY));
    const { maskRegions, boxRegions } = splitDetectionGeometry(scaledRegions);
    if (maskRegions.length) {
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = canvas.width;
        maskCanvas.height = canvas.height;
        const maskCtx = maskCanvas.getContext('2d');
        maskCtx.fillStyle = '#fff';
        maskRegions.forEach((region) => {
            const polygon = Array.isArray(region?.polygon) ? region.polygon : [];
            const validPoints = polygon.filter((point) => Array.isArray(point) && point.length >= 2);
            if (validPoints.length < 3) return;
            maskCtx.beginPath();
            validPoints.forEach((point, index) => {
                const x = Number(point[0] || 0);
                const y = Number(point[1] || 0);
                if (index === 0) {
                    maskCtx.moveTo(x, y);
                } else {
                    maskCtx.lineTo(x, y);
                }
            });
            maskCtx.closePath();
            maskCtx.fill();
        });
        renderMaskStyleToCanvas(canvas, maskCanvas, {
            style: operation.style,
            blockSize: scaleOperationEffectValue(operation.block_size || 16, scaleX, scaleY),
            blurRadius: scaleOperationEffectValue(operation.blur_radius || 20, scaleX, scaleY),
            originalImage: sourceImage,
            bounds: getRegionBounds(maskRegions, canvas.width, canvas.height),
        });
    }
    if (boxRegions.length) {
        const maskCanvas = createWorkingCanvas(canvas.width, canvas.height);
        const maskCtx = maskCanvas.getContext('2d');
        maskCtx.fillStyle = '#fff';
        boxRegions.forEach((region) => {
            if (!Array.isArray(region?.box) || region.box.length !== 4) return;
            const [x1, y1, x2, y2] = region.box;
            maskCtx.fillRect(x1, y1, x2 - x1, y2 - y1);
        });
        renderMaskStyleToCanvas(canvas, maskCanvas, {
            style: operation.style,
            blockSize: scaleOperationEffectValue(operation.block_size || 16, scaleX, scaleY),
            blurRadius: scaleOperationEffectValue(operation.blur_radius || 20, scaleX, scaleY),
            originalImage: sourceImage,
            bounds: getRegionBounds(boxRegions, canvas.width, canvas.height),
        });
    }
}

async function applyMaskOperationToCanvas(canvas, originalImage, operation, scaleX = 1, scaleY = 1) {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const maskCanvas = createWorkingCanvas(canvas.width, canvas.height);
    const maskCtx = maskCanvas.getContext('2d');
    const rawMaskBounds = operation?.mask_bounds;
    const hasMaskBounds = rawMaskBounds !== null
        && rawMaskBounds !== undefined
        && (!Array.isArray(rawMaskBounds) || rawMaskBounds.length > 0);
    const maskBounds = getMaskOperationCanvasBounds(operation, scaleX, scaleY, canvas);
    if (operation?.mask_data && hasMaskBounds && !maskBounds) {
        throw new Error('Invalid inline mask bounds');
    }
    const maskImage = await loadMaskImageForOperation(operation, maskBounds);
    if (!maskImage) return;

    if (operation?.mask_data && maskBounds) {
        const coordinates = rawMaskBounds.map((value) => Number(value));
        const [x1, y1, x2, y2] = coordinates;
        const sourceWidth = Number(operation.mask_image_width || 0);
        const sourceHeight = Number(operation.mask_image_height || 0);
        const intrinsicWidth = maskImage.naturalWidth || maskImage.width;
        const intrinsicHeight = maskImage.naturalHeight || maskImage.height;
        const expectedSourceWidth = canvas.width / scaleX;
        const expectedSourceHeight = canvas.height / scaleY;
        const validCoordinates = coordinates.every((value) => Number.isInteger(value))
            && x1 >= 0
            && y1 >= 0
            && x2 > x1
            && y2 > y1;
        const validSourceSize = (sourceWidth === 0 && sourceHeight === 0)
            || (
                Number.isInteger(sourceWidth)
                && Number.isInteger(sourceHeight)
                && sourceWidth > 0
                && sourceHeight > 0
                && x2 <= sourceWidth
                && y2 <= sourceHeight
                && Math.abs(sourceWidth - expectedSourceWidth) < 1e-6
                && Math.abs(sourceHeight - expectedSourceHeight) < 1e-6
            );
        if (
            !validCoordinates
            || !validSourceSize
            || intrinsicWidth !== x2 - x1
            || intrinsicHeight !== y2 - y1
        ) {
            throw new Error('Invalid inline mask crop dimensions');
        }
    }

    if (maskBounds) {
        maskCtx.drawImage(maskImage, maskBounds.x, maskBounds.y, maskBounds.width, maskBounds.height);
    } else {
        maskCtx.drawImage(maskImage, 0, 0, canvas.width, canvas.height);
    }
    renderMaskStyleToCanvas(canvas, maskCanvas, {
        style: operation.style,
        blockSize: scaleOperationEffectValue(operation.block_size || 16, scaleX, scaleY),
        blurRadius: scaleOperationEffectValue(operation.blur_radius || 20, scaleX, scaleY),
        originalImage,
        bounds: maskBounds || undefined,
    });
}

async function applyEditOperationToCanvas(canvas, item, operation, originalImage = null) {
    if (!operation || typeof operation !== 'object') return;
    const kind = String(operation.kind || '').trim().toLowerCase();
    const logical = getCensorItemLogicalDimensions(item, CensorState.originalLogicalWidth, CensorState.originalLogicalHeight);
    const scaleX = logical.width > 0 ? (canvas.width / logical.width) : 1;
    const scaleY = logical.height > 0 ? (canvas.height / logical.height) : 1;

    if (kind === 'stroke') {
        await applyStrokeOperationToCanvas(canvas, originalImage || CensorState.originalImage, operation, scaleX, scaleY);
    } else if (kind === 'geometry_effect') {
        await applyGeometryOperationToCanvas(canvas, originalImage || CensorState.originalImage, operation, scaleX, scaleY);
    } else if (kind === 'mask_effect') {
        await applyMaskOperationToCanvas(canvas, originalImage || CensorState.originalImage, operation, scaleX, scaleY);
    } else if (kind === 'filter') {
        await applyFilterValuesToCanvas(canvas, operation.values || {});
    }
}

async function replayEditOperationsOntoCanvas(canvas, item, originalImage = null) {
    if (!(canvas instanceof HTMLCanvasElement) || !item?.editOperations?.length) return;
    for (const operation of item.editOperations) {
        await applyEditOperationToCanvas(canvas, item, operation, originalImage || CensorState.originalImage);
    }
}

function syncProxyItemPreviewFromCanvas(item, canvas = null) {
    if (!item) return;
    const targetCanvas = canvas || document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!item.editOperations?.length) {
        item.previewDataUrl = null;
        item.currentDataUrl = null;
        item.isModified = false;
        return;
    }
    item.previewDataUrl = captureCanvasState(targetCanvas);
    item.currentDataUrl = null;
    item.isModified = true;
}

async function redrawProxyCanvasFromOperations(item, canvas = null, baseImage = null) {
    if (!item) return null;
    const targetCanvas = canvas || document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!(targetCanvas instanceof HTMLCanvasElement) || !targetCanvas.width || !targetCanvas.height) {
        return null;
    }
    const dims = getCensorItemCanvasDimensions(item);
    const sourceImage = baseImage || CensorState.originalImage || await loadImage(getCensorPreviewBaseUrl(item, dims));
    const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    ctx.drawImage(sourceImage, 0, 0, targetCanvas.width, targetCanvas.height);
    await replayEditOperationsOntoCanvas(targetCanvas, item, sourceImage);
    syncProxyItemPreviewFromCanvas(item, targetCanvas);
    return targetCanvas;
}

async function renderProxyPreviewDataForItem(item) {
    if (!item) return null;
    const dims = getCensorItemCanvasDimensions(item);
    const previewBaseUrl = getCensorPreviewBaseUrl(item, dims);
    const baseImage = await loadImage(previewBaseUrl);
    const canvas = document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;
    await redrawProxyCanvasFromOperations(item, canvas, baseImage);
    return item.previewDataUrl;
}


function applyBoxRegionsToCanvas(canvas, baseImage, regions, options = {}) {
    const ctx = canvas.getContext('2d');
    const style = options.style || CensorState.style;
    const blockSize = Math.max(1, Number(options.blockSize || CensorState.blockSize || 16));
    const blurRadius = Math.max(1, Number(options.blurRadius || Math.max(1, Math.round(CensorState.blockSize / 2))));
    ctx.save();
    regions.forEach(r => {
        if (!Array.isArray(r?.box) || r.box.length !== 4) return;
        const [x1, y1, x2, y2] = r.box;
        const w = x2 - x1;
        const h = y2 - y1;

        if (style === 'mosaic') {
            const b = blockSize;
            for (let bx = x1; bx < x2; bx += b) {
                for (let by = y1; by < y2; by += b) {
                    const bw = Math.min(b, x2 - bx);
                    const bh = Math.min(b, y2 - by);
                    const d = ctx.getImageData(bx, by, bw, bh);
                    ctx.fillStyle = getAverageColor(d);
                    ctx.fillRect(bx, by, bw, bh);
                }
            }
        } else if (style === 'blur') {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x1, y1, w, h);
            ctx.clip();
            ctx.filter = `blur(${blurRadius}px)`;
            ctx.drawImage(baseImage, 0, 0);
            ctx.restore();
        } else if (style === 'white_bar') {
            ctx.fillStyle = '#fff';
            ctx.fillRect(x1, y1, w, h);
        } else {
            ctx.fillStyle = '#000';
            ctx.fillRect(x1, y1, w, h);
        }
    });
    ctx.restore();
}

async function normalizeMaskDataUrl(maskDataUrl) {
    const maskImage = await loadImage(maskDataUrl);
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = maskImage.naturalWidth || maskImage.width;
    maskCanvas.height = maskImage.naturalHeight || maskImage.height;
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height);

    const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const pixels = imageData.data;
    for (let index = 0; index < pixels.length; index += 4) {
        const alpha = pixels[index + 3];
        const luminance = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
        const hasVisibleAlpha = alpha > 0;
        const hasOpaqueRgbWithoutAlpha = !hasVisibleAlpha && luminance > 0;
        const nextAlpha = hasVisibleAlpha ? alpha : (hasOpaqueRgbWithoutAlpha ? luminance : 0);
        pixels[index] = 255;
        pixels[index + 1] = 255;
        pixels[index + 2] = 255;
        pixels[index + 3] = nextAlpha;
    }
    maskCtx.putImageData(imageData, 0, 0);
    return loadImage(maskCanvas.toDataURL('image/png'));
}

function splitDetectionGeometry(regions = []) {
    const maskRegions = [];
    const boxRegions = [];

    regions.forEach(region => {
        const polygon = Array.isArray(region?.polygon) ? region.polygon : [];
        const validPointCount = polygon.filter(point => Array.isArray(point) && point.length >= 2).length;
        if (validPointCount >= 3) {
            maskRegions.push(region);
        } else if (Array.isArray(region?.box) && region.box.length === 4) {
            boxRegions.push(region);
        }
    });

    return { maskRegions, boxRegions };
}

async function renderRasterMaskEffectOntoCanvas(canvas, maskDataUrl, options = {}) {
    if (!canvas || !canvas.width || !canvas.height) {
        throw new Error('No editable canvas is ready');
    }

    const maskImage = await normalizeMaskDataUrl(maskDataUrl);
    const maskCanvas = createWorkingCanvas(canvas.width, canvas.height);
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.drawImage(maskImage, 0, 0, canvas.width, canvas.height);
    renderMaskStyleToCanvas(canvas, maskCanvas, {
        style: options.style || CensorState.style,
        blockSize: Math.max(1, Number(options.blockSize || CensorState.blockSize || 16)),
        blurRadius: Math.max(1, Number(options.blurRadius || Math.max(1, Math.round(CensorState.blockSize / 2)))),
        originalImage: options.originalImage || CensorState.originalImage,
    });
}

function buildCensorMaskCacheUrl(maskRef, width = null, height = null) {
    const token = String(maskRef || '').trim();
    if (!token) return '';
    const params = new URLSearchParams();
    if (Number.isFinite(width) && width > 0) {
        params.set('width', String(Math.max(1, Math.round(width))));
    }
    if (Number.isFinite(height) && height > 0) {
        params.set('height', String(Math.max(1, Math.round(height))));
    }
    const query = params.toString();
    return `/api/censor/mask-cache/${encodeURIComponent(token)}${query ? `?${query}` : ''}`;
}

function createMaskEffectOperation(maskSource) {
    const operation = {
        kind: 'mask_effect',
        style: CensorState.style,
        block_size: Number(CensorState.blockSize || 16),
        blur_radius: Math.max(1, Math.round(CensorState.blockSize / 2)),
    };

    if (typeof maskSource === 'string') {
        operation.mask_data = maskSource;
        return operation;
    }

    if (maskSource?.mask) {
        operation.mask_data = maskSource.mask;
    }
    if (maskSource?.mask_ref) {
        operation.mask_ref = String(maskSource.mask_ref);
    }
    if (operation.mask_data || operation.mask_ref) {
        if (Array.isArray(maskSource?.mask_bounds) && maskSource.mask_bounds.length === 4) {
            operation.mask_bounds = cloneNumberArray(maskSource.mask_bounds);
        }
        const imageWidth = Number(maskSource?.image_width || 0);
        const imageHeight = Number(maskSource?.image_height || 0);
        if (Number.isFinite(imageWidth) && imageWidth > 0) {
            operation.mask_image_width = imageWidth;
        }
        if (Number.isFinite(imageHeight) && imageHeight > 0) {
            operation.mask_image_height = imageHeight;
        }
    }
    return operation;
}

function getMaskOperationCanvasBounds(operation, scaleX = 1, scaleY = 1, canvas = null) {
    if (!Array.isArray(operation?.mask_bounds) || operation.mask_bounds.length !== 4) return null;
    const targetCanvas = canvas instanceof HTMLCanvasElement ? canvas : null;
    const maxWidth = targetCanvas?.width || Number.POSITIVE_INFINITY;
    const maxHeight = targetCanvas?.height || Number.POSITIVE_INFINITY;
    const rawX1 = Number(operation.mask_bounds[0] || 0) * scaleX;
    const rawY1 = Number(operation.mask_bounds[1] || 0) * scaleY;
    const rawX2 = Number(operation.mask_bounds[2] || 0) * scaleX;
    const rawY2 = Number(operation.mask_bounds[3] || 0) * scaleY;
    const x1 = Math.max(0, Math.floor(rawX1));
    const y1 = Math.max(0, Math.floor(rawY1));
    const x2 = Math.min(maxWidth, Math.ceil(rawX2));
    const y2 = Math.min(maxHeight, Math.ceil(rawY2));
    if (!(x2 > x1) || !(y2 > y1)) return null;
    return {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
        x1,
        y1,
        x2,
        y2,
    };
}

async function loadMaskImageForOperation(operation, canvasBounds = null) {
    if (operation?.mask_data) {
        return normalizeMaskDataUrl(operation.mask_data);
    }
    if (!operation?.mask_ref) {
        return null;
    }
    const maskUrl = buildCensorMaskCacheUrl(
        operation.mask_ref,
        canvasBounds?.width || null,
        canvasBounds?.height || null
    );
    if (!maskUrl) {
        return null;
    }
    return loadImage(maskUrl);
}

async function applyRasterMaskToActiveCanvas(maskSource) {
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!canvas || !canvas.width || !canvas.height) {
        throw new Error('No editable canvas is ready');
    }

    const activeItem = CensorState.queue.find(i => i.id === CensorState.activeId);
    const operation = createMaskEffectOperation(maskSource);
    if (isProxyEditActive() && activeItem) {
        activeItem.editOperations = [
            ...(activeItem.editOperations || []),
            operation,
        ];
        activeItem.isProcessed = true;
        activeItem.isModified = true;
        CensorState.operationRedoStack = [];
        CensorState.lastHistorySource = 'operation';
        await loadCanvasImage(activeItem.id);
        renderQueue();
        return;
    }

    const logical = activeItem
        ? getCensorItemLogicalDimensions(activeItem, canvas.width, canvas.height)
        : { width: canvas.width, height: canvas.height };
    const scaleX = logical.width > 0 ? (canvas.width / logical.width) : 1;
    const scaleY = logical.height > 0 ? (canvas.height / logical.height) : 1;
    await applyMaskOperationToCanvas(canvas, CensorState.originalImage, operation, scaleX, scaleY);
    const committedState = pushUndoState();
    saveCurrentCanvasToState(committedState);

    if (activeItem) {
        activeItem.isProcessed = true;
    }
    renderQueue();
}

