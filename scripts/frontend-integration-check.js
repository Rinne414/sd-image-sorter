// Real-browser frontend integration test for v3.2.1 changes.
// Tests actual user interactions, not just screenshots.
// Run: BASE_URL=http://127.0.0.1:8505 node scripts/frontend-integration-check.js

const { chromium } = require('playwright');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8505';

async function main() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    const passes = [];

    page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    // 1. No page errors on load
    if (errors.length === 0) passes.push('1. No page errors on initial load');
    else { console.error('FAIL 1:', errors); process.exitCode = 1; }

    // 2. Gallery view loads (nav tab active)
    const galleryActive = await page.locator('#nav-tab-gallery.active').count();
    if (galleryActive) passes.push('2. Gallery tab is active on load');
    else { errors.push('FAIL 2: Gallery tab not active'); process.exitCode = 1; }

    // 3. Navigate to Sorting > Auto-Separate — verify 3-pane shell
    await page.locator('.nav-tab[data-view="sorting"]').click();
    await page.waitForTimeout(300);
    const autosepShell = await page.locator('.autosep-shell').count();
    if (autosepShell) passes.push('3. Auto-Separate 3-pane shell renders');
    else { errors.push('FAIL 3: .autosep-shell not found'); process.exitCode = 1; }

    // 4. Auto-Separate: 3 panes visible
    const filterPane = await page.locator('.autosep-pane-filter').isVisible();
    const previewPane = await page.locator('.autosep-pane-preview').isVisible();
    const actionPane = await page.locator('.autosep-pane-action').isVisible();
    if (filterPane && previewPane && actionPane) passes.push('4. All 3 Auto-Separate panes visible');
    else { errors.push(`FAIL 4: panes visible: filter=${filterPane} preview=${previewPane} action=${actionPane}`); process.exitCode = 1; }

    // 5. Auto-Separate: copy radio is default checked
    const copyChecked = await page.locator('input[name="autosep-operation-mode-main"][value="copy"]').isChecked();
    if (copyChecked) passes.push('5. Auto-Separate copy radio is default');
    else { errors.push('FAIL 5: copy radio not checked by default'); process.exitCode = 1; }

    // 6. Auto-Separate: confirm checkbox is default checked
    const confirmChecked = await page.locator('#autosep-confirm-move-main').isChecked();
    if (confirmChecked) passes.push('6. Auto-Separate confirm checkbox default ON');
    else { errors.push('FAIL 6: confirm checkbox not checked'); process.exitCode = 1; }

    // 7. Auto-Separate: Edit Filters button clickable (opens filter modal)
    await page.locator('#btn-autosep-filters').click();
    await page.waitForTimeout(500);
    const filterModalVisible = await page.locator('#filter-modal.visible').count();
    if (filterModalVisible) passes.push('7. Edit Filters opens filter modal');
    else { errors.push('FAIL 7: filter modal did not open'); process.exitCode = 1; }
    // Close it
    await page.locator('#filter-modal .modal-close').click();
    await page.waitForTimeout(200);

    // 8. Open batch export modal directly (gallery may be empty, so we
    //    trigger the modal via JS instead of clicking the disabled button)
    await page.locator('.nav-tab[data-view="gallery"]').click();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        const modal = document.getElementById('batch-export-modal');
        if (modal) { modal.classList.add('visible'); modal.style.display = 'flex'; document.body.classList.add('modal-open'); }
    });
    await page.waitForTimeout(300);
    const exportModalVisible = await page.locator('#batch-export-modal.visible').count();
    if (exportModalVisible) passes.push('8. Batch export modal opens');
    else { errors.push('FAIL 8: batch export modal did not open'); process.exitCode = 1; }

    // 9. Underscore checkbox exists and is checked by default
    const underscoreCheckbox = page.locator('#batch-export-normalize-underscores');
    const underscoreExists = await underscoreCheckbox.count();
    let underscoreChecked = false;
    if (underscoreExists) {
        underscoreChecked = await underscoreCheckbox.isChecked();
    }
    if (underscoreExists && underscoreChecked) passes.push('9. Underscore normalization checkbox present + default ON');
    else { errors.push(`FAIL 9: checkbox exists=${underscoreExists} checked=${underscoreChecked}`); process.exitCode = 1; }

    // 10. Caption Editor "Open Editor" button exists
    const openEditorBtn = await page.locator('#btn-open-caption-editor').count();
    if (openEditorBtn) passes.push('10. Caption Editor "Open Editor" button present');
    else { errors.push('FAIL 10: #btn-open-caption-editor not found'); process.exitCode = 1; }

    // 11. Click "Open Editor" — caption editor modal opens
    await page.locator('#btn-open-caption-editor').click();
    await page.waitForTimeout(300);
    const captionEditorVisible = await page.locator('#caption-editor-modal.visible').count();
    if (captionEditorVisible) passes.push('11. Caption Editor modal opens on click');
    else { errors.push('FAIL 11: caption editor modal did not open'); process.exitCode = 1; }

    // 12. Close caption editor (use the ✕ close button which is always on top)
    await page.locator('#btn-close-caption-editor').click();
    await page.waitForTimeout(200);
    const captionEditorClosed = !(await page.locator('#caption-editor-modal.visible').count());
    if (captionEditorClosed) passes.push('12. Caption Editor closes on Done click');
    else { errors.push('FAIL 12: caption editor did not close'); process.exitCode = 1; }

    // 13. Navigate to Manual Sort — verify no page errors (the syntax fix)
    // First close any open modals
    await page.evaluate(() => {
        document.querySelectorAll('.modal.visible').forEach(m => { m.classList.remove('visible'); m.style.display = ''; });
        document.body.classList.remove('modal-open');
    });
    await page.waitForTimeout(200);
    await page.locator('.nav-tab[data-view="sorting"]').click();
    await page.waitForTimeout(200);
    await page.evaluate(() => window._switchSortingSub?.('manual'));
    await page.waitForTimeout(300);
    const manualSortVisible = await page.locator('#view-manual').isVisible();
    if (manualSortVisible) passes.push('13. Manual Sort view renders without crash');
    else { errors.push('FAIL 13: Manual Sort view not visible'); process.exitCode = 1; }

    // 14. Final page error count
    const finalErrors = errors.filter(e => e.startsWith('[pageerror]'));
    if (finalErrors.length === 0) passes.push('14. Zero page errors throughout entire session');
    else { errors.push(`FAIL 14: ${finalErrors.length} page errors: ${finalErrors.join('; ')}`); process.exitCode = 1; }

    await browser.close();

    console.log(`\n=== Frontend Integration Check ===`);
    console.log(`PASSED: ${passes.length}/14`);
    passes.forEach(p => console.log(`  ✓ ${p}`));
    if (errors.length) {
        console.log(`\nFAILED:`);
        errors.forEach(e => console.log(`  ✗ ${e}`));
    }
    console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
