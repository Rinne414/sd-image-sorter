'use strict';

/**
 * Native drag-out: the gallery asks for a drag of the real picture files, so
 * Explorer, Photoshop, ComfyUI and browser upload fields receive files, not a
 * URL. The page sends image ids; paths come from the backend and only
 * absolute paths to existing files are dragged.
 */

const fs = require('node:fs');
const { nativeImage } = require('electron');

const { cleanDragPaths } = require('./paths');
const { resolveImagePaths, fetchImagesByIds } = require('./drag-resolver');

const DRAG_ICON_SIZE = 96;

function isFile(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** A small picture of the first file under the cursor; the app icon when that fails. */
async function dragIcon(file, fallbackIcon) {
    try {
        if (process.platform === 'win32' || process.platform === 'darwin') {
            const thumb = await nativeImage.createThumbnailFromPath(file, { width: DRAG_ICON_SIZE, height: DRAG_ICON_SIZE });
            if (!thumb.isEmpty()) return thumb;
        }
        const image = nativeImage.createFromPath(file);
        if (!image.isEmpty()) return image.resize({ width: DRAG_ICON_SIZE });
    } catch {
        // Fall back to the app icon below.
    }
    return nativeImage.createFromPath(fallbackIcon);
}

/**
 * Start the OS drag. On Windows this returns once the drop finished.
 * `request` = { imageIds, libraryId, port }: the paths come from the backend.
 */
async function startNativeDrag(webContents, request, fallbackIcon) {
    const { imageIds, libraryId, port } = request;
    const paths = await resolveImagePaths(imageIds, (chunk) => fetchImagesByIds(port, libraryId, chunk));
    const files = cleanDragPaths(paths, isFile);
    if (!files.length) return { ok: false, count: 0, reason: 'no-files' };
    const icon = await dragIcon(files[0], fallbackIcon);
    webContents.startDrag(files.length === 1 ? { file: files[0], icon } : { file: files[0], files, icon });
    return { ok: true, count: files.length, skipped: paths.length - files.length };
}

module.exports = { startNativeDrag };
