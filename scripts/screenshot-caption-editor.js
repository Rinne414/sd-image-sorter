// Standalone Playwright screenshot script for v3.2.1 task #33
// Verifies the new dedicated Caption Editor full-screen modal renders
// against a running backend on port 8501.
//
// Run with:
//   node scripts/screenshot-caption-editor.js
//
// Requires: node_modules/playwright (already in package.json).

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8501';
const OUT_DIR = path.resolve(__dirname, '../.tmp/screenshots/c33-caption-editor');

// Mock preview rows we will inject into V321Integration so the workbench
// has actual data to render without needing real images / scan / DB state.
function buildMockPreviewResults(count) {
    const baseTags = [
        '1girl, solo, looking at viewer, masterpiece, best quality, detailed background',
        '1girl, blue hair, blue eyes, school uniform, classroom, sunlight, masterpiece',
        '1boy, casual, urban background, photorealistic, detailed, sharp focus',
        'fantasy, castle, mountains, dramatic sky, cinematic lighting, masterpiece',
        '1girl, twintails, magical girl, sparkles, vivid colors, dynamic pose',
    ];
    const rows = [];
    for (let i = 0; i < count; i++) {
        const tagSrc = baseTags[i % baseTags.length];
        rows.push({
            image_id: 1000 + i,
            // Use a 1x1 transparent png data URL so we don't depend on
            // actual files in the gallery.
            thumbnail_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
            filename: `mock_${i + 1}.png`,
            rendered: tagSrc,
            content_kind: 'tags',
            metadata_kind: 'tags',
        });
    }
    return rows;
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    page.on('pageerror', (err) => console.error('[pageerror]', err.message, '\n', err.stack || ''));
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.error('[browser]', msg.text());
    });

    console.log(`Loading ${BASE_URL}/ ...`);
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });

    // Wait until V321Integration is registered (it's loaded via the
    // batch-export modal flow normally, so we kick it manually here).
    await page.waitForFunction(() => !!window.V321Integration, undefined, { timeout: 15000 });

    // Open the batch-export modal first so we get its DOM (the
    // caption-editor modal is a sibling that needs the existing
    // export-preview-list element to exist when re-render runs).
    await page.evaluate(() => {
        const modal = document.getElementById('batch-export-modal');
        if (modal) {
            modal.classList.add('visible');
            modal.style.display = 'flex';
            document.body.classList.add('modal-open');
        }
    });
    await page.waitForTimeout(150);

    // Inject the mock preview results so the workbench has rows to render.
    await page.evaluate((rows) => {
        const V = window.V321Integration;
        V.previewResults = rows;
        V.previewCache = new Map(rows.map((r) => [Number(r.image_id), r.rendered]));
        V.editedCaptions = new Map();
        V.activePreviewImageId = Number(rows[0].image_id);
    }, buildMockPreviewResults(8));

    // Render the inline workbench so we can take a "before" screenshot.
    await page.evaluate(() => window.V321Integration._renderPreviewWorkbench());
    await page.waitForTimeout(200);

    await page.screenshot({
        path: path.join(OUT_DIR, '01-inline-1440.png'),
        fullPage: false,
    });
    console.log('Screenshot 01 (inline @ 1440x900) saved');

    // Now open the dedicated Caption Editor modal.
    await page.evaluate(() => window.V321Integration.openCaptionEditor());
    await page.waitForTimeout(300);

    await page.screenshot({
        path: path.join(OUT_DIR, '02-fullscreen-1440.png'),
        fullPage: false,
    });
    console.log('Screenshot 02 (caption editor @ 1440x900) saved');

    // Repeat at smaller laptop size to verify responsive behaviour.
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForTimeout(150);
    await page.screenshot({
        path: path.join(OUT_DIR, '03-fullscreen-1366.png'),
        fullPage: false,
    });
    console.log('Screenshot 03 (caption editor @ 1366x768) saved');

    // Verify presence of all 3 panels (queue / editor / tools) in BOTH the
    // inline pane (after close) AND the fullscreen modal (before close).
    // The fullscreen check has to happen before closeCaptionEditor() blanks it.
    await page.evaluate(() => window.V321Integration.openCaptionEditor());
    await page.waitForTimeout(200);
    const fullscreenPanels = await page.evaluate(() => {
        const fullscreen = document.getElementById('caption-editor-list');
        const fullscreenWb = fullscreen?.querySelector('.export-preview-workbench');
        return fullscreenWb
            ? Array.from(fullscreenWb.children).map((c) => c.className.split(' ')[0])
            : [];
    });

    // Close + reopen sequence to ensure state survives.
    await page.evaluate(() => window.V321Integration.closeCaptionEditor());
    await page.waitForTimeout(150);
    await page.screenshot({
        path: path.join(OUT_DIR, '04-after-close-1366.png'),
        fullPage: false,
    });
    console.log('Screenshot 04 (after close, back to inline @ 1366x768) saved');

    const inlinePanels = await page.evaluate(() => {
        const inline = document.getElementById('export-preview-list');
        const inlineWb = inline?.querySelector('.export-preview-workbench');
        return inlineWb
            ? Array.from(inlineWb.children).map((c) => c.className.split(' ')[0])
            : [];
    });
    console.log('Panels detected:', JSON.stringify({ inlinePanels, fullscreenPanels }));

    await browser.close();

    // Quick sanity: assert all 3 columns rendered in BOTH modes.
    const required = ['export-preview-queue', 'export-preview-editor', 'export-preview-tools'];
    const missingInline = required.filter((c) => !inlinePanels.includes(c));
    const missingFullscreen = required.filter((c) => !fullscreenPanels.includes(c));
    if (missingInline.length || missingFullscreen.length) {
        console.error(
            `FAIL: missing panels — inline=[${missingInline.join(', ')}] fullscreen=[${missingFullscreen.join(', ')}]`
        );
        process.exit(1);
    }
    console.log('PASS: 3-column workbench rendered in both inline and fullscreen modes.');
}

main().catch((err) => {
    console.error('Screenshot script failed:', err);
    process.exit(1);
});
