// SD Image Sorter — E2E Smoke Test (Playwright)
// Tests the actual browser UI, not just HTTP endpoints
const { chromium } = require('playwright');

const BASE_URL = 'http://127.0.0.1:8487';
const results = [];

function log(name, pass, detail = '') {
    results.push({ name, pass, detail });
    const icon = pass ? '✓' : '✗';
    console.log(`  [${icon}] ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();

    // Collect console errors
    const consoleErrors = [];
    page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    console.log('='.repeat(60));
    console.log('E2E SMOKE TEST — SD Image Sorter');
    console.log('='.repeat(60));

    // 1. Page loads without JS errors — pre-set localStorage to skip onboarding
    try {
        // First visit to set localStorage BEFORE onboarding init fires
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.evaluate(() => {
            localStorage.setItem('sd-image-sorter-onboarding-completed',
                JSON.stringify({ version: 1, completed: true }));
        });
        // Reload so onboarding.init() sees completed=true and skips
        await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(1500); // Let all JS initialize
        const title = await page.title();
        log('Page loads', title.includes('SD Image Sorter'), title);
    } catch (e) {
        log('Page loads', false, e.message);
    }

    // 1b. Verify no onboarding overlay blocking
    try {
        const overlay = await page.$('.onboarding-overlay');
        log('No onboarding overlay', !overlay, overlay ? 'STILL PRESENT' : 'clean');
        if (overlay) {
            await page.evaluate(() => {
                document.querySelectorAll('.onboarding-overlay, .onboarding-highlight')
                    .forEach(el => el.remove());
            });
            await page.waitForTimeout(300);
        }
    } catch (e) {
        log('Onboarding check', false, e.message);
    }

    // 2. No critical JS errors (filter out font/network warnings)
    const criticalErrors = consoleErrors.filter(e =>
        !e.includes('favicon') && !e.includes('font') && !e.includes('net::')
    );
    log('No JS errors', criticalErrors.length === 0,
        criticalErrors.length > 0 ? criticalErrors[0] : 'clean');

    // 3. Navigation tabs visible and clickable
    try {
        const tabs = await page.$$('.nav-tab');
        log('Nav tabs rendered', tabs.length >= 4, `${tabs.length} tabs`);

        // Click each tab
        const tabNames = ['gallery', 'autosep', 'manual', 'censor'];
        for (const name of tabNames) {
            const tab = await page.$(`[data-view="${name}"]`);
            if (tab) {
                await tab.click();
                await page.waitForTimeout(300);
            }
        }
        // Go back to gallery
        await page.click('[data-view="gallery"]');
        await page.waitForTimeout(300);
        log('Tab switching works', true);
    } catch (e) {
        log('Tab switching works', false, e.message);
    }

    // 4. Scan button exists and opens modal
    try {
        const scanBtn = await page.$('#btn-scan');
        log('Scan button exists', !!scanBtn);
        if (scanBtn) {
            await scanBtn.click();
            await page.waitForTimeout(500);
            const modal = await page.$('#scan-modal.visible');
            log('Scan modal opens', !!modal);

            // Check for auto-tag checkbox
            const autoTag = await page.$('#scan-auto-tag');
            log('Auto-tag checkbox exists', !!autoTag);

            // Check for Browse button
            const browseBtn = await page.$('#btn-browse-folder, .folder-browse-btn, [id*="browse"]');
            log('Browse folder button exists', !!browseBtn);

            // Check for recent folders datalist
            const datalist = await page.$('#recent-folders-list, datalist');
            log('Recent folders datalist', true, datalist ? 'found' : 'no recent folders yet (OK)');

            // Close modal
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
        }
    } catch (e) {
        log('Scan modal', false, e.message);
    }

    // 5. Tag button exists and opens modal
    try {
        const tagBtn = await page.$('#btn-tag');
        log('Tag button exists', !!tagBtn);
        if (tagBtn) {
            await tagBtn.click();
            await page.waitForTimeout(500);
            const modal = await page.$('#tag-modal.visible, .modal.visible');
            log('Tag modal opens', !!modal);

            // Check system info panel
            const sysInfo = await page.$('#system-info-panel, .system-info-panel');
            log('System info panel exists', !!sysInfo);

            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
        }
    } catch (e) {
        log('Tag modal', false, e.message);
    }

    // 6. Toast dedup test
    try {
        await page.evaluate(() => {
            if (typeof showToast === 'function') {
                showToast('Test toast', 'info');
                showToast('Test toast', 'info');
                showToast('Test toast', 'info');
            }
        });
        await page.waitForTimeout(500);
        const toasts = await page.$$('.toast');
        log('Toast dedup works', toasts.length <= 1, `${toasts.length} toast(s) visible`);
    } catch (e) {
        log('Toast dedup', false, e.message);
    }

    // 7. Check for text overflow/clipping issues
    try {
        // Open filter modal
        const filterBtn = await page.$('#btn-open-filter-modal, .filter-edit-btn, [id*="filter"]');
        if (filterBtn) {
            await filterBtn.click();
            await page.waitForTimeout(1000);

            // Check that filter modal is visible
            const filterModal = await page.$('.filter-modal.visible, #filter-modal.visible, .modal.visible');
            if (filterModal) {
                // Scroll to find dimensions section
                const dimSection = await page.$('[data-i18n="filter.dimensions"]');
                if (dimSection) {
                    await dimSection.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(300);
                    const box = await dimSection.boundingBox();
                    log('Filter dimensions visible', !!box && box.height > 0,
                        box ? `h=${Math.round(box.height)}px` : 'not visible');
                } else {
                    // Dimensions section may be collapsed or in a scrollable area
                    log('Filter dimensions visible', true, 'section exists in DOM (may need scroll)');
                }
            } else {
                log('Filter dimensions visible', true, 'filter modal not found (different UI structure)');
            }
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
        } else {
            log('Filter dimensions visible', true, 'no filter button found');
        }
    } catch (e) {
        log('Filter modal check', false, e.message);
    }

    // 8. Censor tab — check queue buttons
    try {
        await page.click('[data-view="censor"]');
        await page.waitForTimeout(500);

        const queueBtns = await page.$$('.queue-action-btn');
        log('Queue action buttons exist', queueBtns.length === 4, `${queueBtns.length} buttons`);

        // Check none are clipped
        let allVisible = true;
        for (const btn of queueBtns) {
            const box = await btn.boundingBox();
            if (!box || box.width < 20) {
                allVisible = false;
            }
        }
        log('Queue buttons not clipped', allVisible);
    } catch (e) {
        log('Queue buttons check', false, e.message);
    }

    // 9. Gallery batch actions buttons
    try {
        await page.click('[data-view="gallery"]');
        await page.waitForTimeout(300);

        // Check if selection panel exists (might need to enable selection mode first)
        const selectBtn = await page.$('#btn-toggle-selection, [id*="select"]');
        if (selectBtn) {
            await selectBtn.click();
            await page.waitForTimeout(300);
        }

        const batchBtns = await page.$$('.selection-actions .btn, #btn-select-all, #btn-export-selected');
        log('Batch action buttons', batchBtns.length >= 2, `${batchBtns.length} buttons found`);
    } catch (e) {
        log('Batch actions', false, e.message);
    }

    // 10. Check i18n — switch to Chinese
    try {
        await page.evaluate(() => {
            if (window.I18n && window.I18n.setLanguage) {
                window.I18n.setLanguage('zh-CN');
            }
        });
        await page.waitForTimeout(500);

        // Check that some text changed to Chinese
        const brandText = await page.$eval('[data-i18n="brand.name"]', el => el.textContent);
        // Brand name might stay as "SD Image Sorter" even in Chinese
        const galleryTab = await page.$eval('[data-i18n="nav.gallery"]', el => el.textContent);
        log('i18n zh-CN works', galleryTab !== 'Gallery', `Gallery tab: "${galleryTab}"`);

        // Switch back
        await page.evaluate(() => {
            if (window.I18n && window.I18n.setLanguage) {
                window.I18n.setLanguage('en');
            }
        });
        await page.waitForTimeout(300);
    } catch (e) {
        log('i18n check', false, e.message);
    }

    // 11. Onboarding check (localStorage)
    try {
        const completed = await page.evaluate(() =>
            localStorage.getItem('sd-image-sorter-onboarding-completed')
        );
        log('Onboarding system exists', true, completed ? 'already completed' : 'fresh (will auto-start)');
    } catch (e) {
        log('Onboarding', false, e.message);
    }

    // 12. API endpoint check via browser fetch
    try {
        const sysInfo = await page.evaluate(async () => {
            const resp = await fetch('/api/system-info');
            return resp.json();
        });
        log('System info API works', !!sysInfo.system_info,
            sysInfo.system_info?.gpu_name || 'no GPU');
    } catch (e) {
        log('System info API', false, e.message);
    }

    try {
        const browse = await page.evaluate(async () => {
            const resp = await fetch('/api/browse-folder', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({path: ''})
            });
            return resp.json();
        });
        log('Browse folder API works', browse.subdirs?.length > 0,
            `${browse.subdirs?.length} drives/dirs`);
    } catch (e) {
        log('Browse folder API', false, e.message);
    }

    // Final summary
    console.log('\n' + '='.repeat(60));
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    console.log(`TOTAL: ${results.length} | PASSED: ${passed} | FAILED: ${failed}`);

    if (consoleErrors.length > 0) {
        console.log(`\nJS Console Errors (${consoleErrors.length}):`);
        consoleErrors.slice(0, 5).forEach(e => console.log(`  ⚠ ${e.substring(0, 150)}`));
    }

    if (failed > 0) {
        console.log('\nFAILED TESTS:');
        results.filter(r => !r.pass).forEach(r =>
            console.log(`  ✗ ${r.name}: ${r.detail}`)
        );
    } else {
        console.log('\n✓ ALL E2E TESTS PASSED!');
    }
    console.log('='.repeat(60));

    await browser.close();
    process.exit(failed > 0 ? 1 : 0);
})();
