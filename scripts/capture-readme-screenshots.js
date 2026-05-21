// Capture README screenshots for all key v3.2.1 views.
// Outputs to docs/screenshots/ for direct use in README.md.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8507';
const OUT = path.resolve(__dirname, '../docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });

async function main() {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // 1. Gallery (empty state with onboarding)
    await page.screenshot({ path: path.join(OUT, 'gallery_empty_onboarding.png') });
    console.log('1. gallery_empty_onboarding.png');

    // 2. Auto-Separate 3-pane
    await page.evaluate(() => { window.switchView?.('sorting'); window._switchSortingSub?.('autosep'); });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'autosep_workbench.png') });
    console.log('2. autosep_workbench.png');

    // 3. Manual Sort
    await page.evaluate(() => window._switchSortingSub?.('manual'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'manual_sort_setup.png') });
    console.log('3. manual_sort_setup.png');

    // 4. Reader
    await page.evaluate(() => window.switchView?.('reader'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'reader_workspace.png') });
    console.log('4. reader_workspace.png');

    // 5. Censor Edit
    await page.evaluate(() => window.switchView?.('censor'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'censor_workspace.png') });
    console.log('5. censor_workspace.png');

    // 6. Similar Images
    await page.evaluate(() => window.switchView?.('similar'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'similar_search.png') });
    console.log('6. similar_search.png');

    // 7. Prompt Lab
    await page.evaluate(() => window.switchView?.('promptlab'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'prompt_lab.png') });
    console.log('7. prompt_lab.png');

    // 8. Artist ID
    await page.evaluate(() => window.switchView?.('artist'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'artist_identification.png') });
    console.log('8. artist_identification.png');

    // 9. Model Manager
    await page.evaluate(() => window.switchView?.('gallery'));
    await page.waitForTimeout(200);
    await page.locator('#btn-open-model-manager').click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'model_manager.png') });
    console.log('9. model_manager.png');
    await page.locator('#model-manager-close').click().catch(() => {});
    await page.waitForTimeout(200);

    // 10. Batch Export modal with Caption Editor button
    await page.evaluate(() => {
        const modal = document.getElementById('batch-export-modal');
        if (modal) { modal.classList.add('visible'); modal.style.display = 'flex'; document.body.classList.add('modal-open'); }
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'batch_export_modal.png') });
    console.log('10. batch_export_modal.png');

    // 11. Caption Editor full-screen
    await page.waitForFunction(() => !!window.V321Integration, { timeout: 5000 });
    await page.evaluate(() => {
        const V = window.V321Integration;
        V.previewResults = [
            { image_id: 1, filename: 'sample_1.png', rendered: '1girl, solo, looking at viewer, masterpiece, best quality, score_5', thumbnail_url: '' },
            { image_id: 2, filename: 'sample_2.png', rendered: '1boy, casual, urban background, photorealistic, score_9_up', thumbnail_url: '' },
            { image_id: 3, filename: 'sample_3.png', rendered: 'landscape, mountains, dramatic sky, cinematic lighting', thumbnail_url: '' },
        ];
        V.previewCache = new Map(V.previewResults.map(r => [r.image_id, r.rendered]));
        V.editedCaptions = new Map();
        V.activePreviewImageId = 1;
        V.openCaptionEditor();
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'caption_editor_fullscreen.png') });
    console.log('11. caption_editor_fullscreen.png');
    await page.evaluate(() => window.V321Integration?.closeCaptionEditor());
    await page.evaluate(() => {
        document.querySelectorAll('.modal.visible').forEach(m => { m.classList.remove('visible'); m.style.display = ''; });
        document.body.classList.remove('modal-open');
    });
    await page.waitForTimeout(200);

    // 12. Tagger modal (open Tag Images)
    await page.locator('#btn-tag').click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, 'tagger_modal.png') });
    console.log('12. tagger_modal.png');

    await browser.close();
    console.log(`\nDone: ${fs.readdirSync(OUT).filter(f => f.endsWith('.png')).length} screenshots in docs/screenshots/`);
}

main().catch(err => { console.error(err); process.exit(1); });
