// Standalone Playwright screenshot script for v3.2.1 task #35 (Auto-Separate
// 3-pane workbench). Verifies the redesigned page renders correctly and that
// every locked element ID still exists in the DOM (so existing autosep.js
// keeps working).
//
// Run with:
//   node scripts/screenshot-autosep-workbench.js

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8502';
const OUT_DIR = path.resolve(__dirname, '../.tmp/screenshots/c35-autosep-workbench');

// Element IDs that the existing autosep.js depends on. If any of these go
// missing the redesign has broken the contract.
const LOCKED_IDS = [
    'view-autosep',
    'btn-autosep-settings',
    'btn-autosep-new-config',
    'autosep-config-select',
    'btn-autosep-load-config',
    'btn-autosep-save-config',
    'btn-autosep-rename-config',
    'btn-autosep-delete-config',
    'autosep-config-summary',
    'btn-autosep-filters',
    'autosep-scope-note',
    'autosep-scope-status',
    'autosep-scope-badge',
    'autosep-scope-meta',
    'autosep-scope-detail',
    'btn-autosep-use-gallery-scope',
    'btn-autosep-resync-scope',
    'btn-autosep-keep-scope',
    'autosep-filter-summary',
    'autosep-summary-generators',
    'autosep-summary-tags',
    'autosep-summary-ratings',
    'autosep-summary-checkpoints',
    'autosep-summary-loras',
    'autosep-summary-prompts',
    'autosep-summary-search',
    'autosep-summary-dimensions',
    'autosep-destination',
    'btn-browse-destination',
    'autosep-settings-summary',
    'autosep-preview',
    'autosep-preview-list',
    'autosep-preview-scope-summary',
    'btn-preview-autosep',
    'autosep-action-mode-panel',
    'autosep-action-settings-title',
    'autosep-confirm-move-main',
    'autosep-remember-destination-main',
    'btn-execute-autosep',
];

async function showAutosepView(page) {
    await page.evaluate(() => {
        // The Auto-Separate panel lives inside #view-sorting (the "Sort" mega
        // tab). It is shown via switchView('sorting') + _switchSortingSub('autosep').
        if (typeof window.switchView === 'function') {
            window.switchView('sorting');
        }
        if (typeof window._switchSortingSub === 'function') {
            window._switchSortingSub('autosep');
        }
    });
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    const pageErrors = [];
    page.on('pageerror', (err) => {
        pageErrors.push(err.message);
        console.error('[pageerror]', err.message);
    });
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.error('[browser]', msg.text());
    });

    console.log(`Loading ${BASE_URL}/ ...`);
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    await showAutosepView(page);
    // Give i18n + lazy module init time to attach data-i18n strings
    await page.waitForTimeout(700);

    await page.screenshot({
        path: path.join(OUT_DIR, '01-workbench-1440.png'),
        fullPage: false,
    });
    console.log('Screenshot 01 (workbench @ 1440x900) saved');

    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForTimeout(150);
    await page.screenshot({
        path: path.join(OUT_DIR, '02-workbench-1366.png'),
        fullPage: false,
    });
    console.log('Screenshot 02 (workbench @ 1366x768) saved');

    await page.setViewportSize({ width: 1080, height: 720 });
    await page.waitForTimeout(150);
    await page.screenshot({
        path: path.join(OUT_DIR, '03-workbench-1080.png'),
        fullPage: false,
    });
    console.log('Screenshot 03 (workbench @ 1080x720) saved');

    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForTimeout(150);
    await page.screenshot({
        path: path.join(OUT_DIR, '04-workbench-720.png'),
        fullPage: true,
    });
    console.log('Screenshot 04 (workbench @ 720x900 single column, full page) saved');

    // Re-set to wide viewport for assertion phase
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);

    const idStatus = await page.evaluate((ids) => {
        return ids.map((id) => ({ id, present: !!document.getElementById(id) }));
    }, LOCKED_IDS);
    const missing = idStatus.filter((s) => !s.present).map((s) => s.id);

    // Also verify the locked default contract: copy radio is checked, move is not.
    const radioState = await page.evaluate(() => {
        const move = document.querySelector('input[name="autosep-operation-mode-main"][value="move"]');
        const copy = document.querySelector('input[name="autosep-operation-mode-main"][value="copy"]');
        const confirm = document.getElementById('autosep-confirm-move-main');
        return {
            moveExists: !!move,
            copyExists: !!copy,
            moveChecked: !!(move && move.checked),
            copyChecked: !!(copy && copy.checked),
            confirmChecked: !!(confirm && confirm.checked),
        };
    });

    // Diagnostic: dump the rendered structure of the configs card to detect
    // any rendering regression where the card-head text is hidden.
    const configsCardDump = await page.evaluate(() => {
        const card = document.getElementById('autosep-configs-card');
        if (!card) return null;
        const head = card.querySelector('.autosep-card-head');
        const summary = head?.querySelector('.autosep-card-summary-text');
        const summaryRect = summary?.getBoundingClientRect();
        const headRect = head?.getBoundingClientRect();
        const summaryStyle = summary ? window.getComputedStyle(summary) : null;
        const headStyle = head ? window.getComputedStyle(head) : null;
        const cardStyle = card ? window.getComputedStyle(card) : null;
        const cardRect = card.getBoundingClientRect();
        const paneBody = card.closest('.autosep-pane-body');
        const paneBodyRect = paneBody?.getBoundingClientRect();
        const paneBodyStyle = paneBody ? window.getComputedStyle(paneBody) : null;
        return {
            cardOuterHTML: card.outerHTML.slice(0, 400),
            headExists: !!head,
            summaryExists: !!summary,
            summaryText: summary?.textContent || null,
            summaryWidth: summaryRect ? summaryRect.width : null,
            summaryHeight: summaryRect ? summaryRect.height : null,
            headWidth: headRect ? headRect.width : null,
            headHeight: headRect ? headRect.height : null,
            cardWidth: cardRect.width,
            cardHeight: cardRect.height,
            cardOverflow: cardStyle?.overflow,
            cardDisplay: cardStyle?.display,
            paneBodyHeight: paneBodyRect?.height,
            paneBodyOverflow: paneBodyStyle?.overflow,
            paneBodyOverflowY: paneBodyStyle?.overflowY,
            summaryColor: summaryStyle?.color,
            summaryDisplay: summaryStyle?.display,
            summaryVisibility: summaryStyle?.visibility,
            summaryOpacity: summaryStyle?.opacity,
            summaryFontSize: summaryStyle?.fontSize,
            headBg: headStyle?.backgroundColor,
            headColor: headStyle?.color,
        };
    });
    console.log('Configs card diagnostic:', JSON.stringify(configsCardDump, null, 2));

    // Take one more screenshot AFTER the diagnostic to compare with the earlier one.
    await page.screenshot({
        path: path.join(OUT_DIR, '05-after-diagnostic-1440.png'),
        fullPage: false,
    });
    console.log('Screenshot 05 (post-diagnostic @ 1440x900) saved');

    // Element-level screenshot of just the configs card. This bypasses any
    // viewport/scroll quirks and shows exactly what the card renders as.
    const configsCard = await page.$('#autosep-configs-card');
    if (configsCard) {
        await configsCard.screenshot({
            path: path.join(OUT_DIR, '06-configs-card-only.png'),
        });
        console.log('Screenshot 06 (configs card only) saved');
    }
    const filterPane = await page.$('.autosep-pane-filter');
    if (filterPane) {
        await filterPane.screenshot({
            path: path.join(OUT_DIR, '07-filter-pane-only.png'),
        });
        console.log('Screenshot 07 (filter pane only) saved');
    }

    // Functional smoke test: verify all key handler-bearing elements exist
    // and have visible/clickable state. We avoid actually clicking the buttons
    // because some scope handlers trigger backend calls that can race with
    // the screenshot session.
    const behavior = await page.evaluate(() => {
        const visibleAndEnabled = (id) => {
            const el = document.getElementById(id);
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                !el.disabled
            );
        };
        // Load / rename / delete config buttons are correctly disabled by
        // autosep.js when no saved config exists, so we only assert they
        // are present + visible (not their enabled state).
        const visibleOnly = (id) => {
            const el = document.getElementById(id);
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden'
            );
        };
        return {
            editFiltersClickable: visibleAndEnabled('btn-autosep-filters'),
            settingsGearClickable: visibleAndEnabled('btn-autosep-settings'),
            scopeUseGalleryClickable: visibleAndEnabled('btn-autosep-use-gallery-scope'),
            scopeResyncClickable: visibleAndEnabled('btn-autosep-resync-scope'),
            scopeKeepSavedClickable: visibleAndEnabled('btn-autosep-keep-scope'),
            previewBtnClickable: visibleAndEnabled('btn-preview-autosep'),
            executeBtnClickable: visibleAndEnabled('btn-execute-autosep'),
            destinationInputUsable: visibleAndEnabled('autosep-destination'),
            saveConfigClickable: visibleAndEnabled('btn-autosep-save-config'),
            // Load/rename/delete may be disabled when no saved config; only
            // assert visibility.
            loadConfigVisible: visibleOnly('btn-autosep-load-config'),
            renameConfigVisible: visibleOnly('btn-autosep-rename-config'),
            deleteConfigVisible: visibleOnly('btn-autosep-delete-config'),
        };
    });
    const broken = Object.entries(behavior).filter(([_, ok]) => !ok).map(([k]) => k);

    await browser.close();

    console.log(`Locked IDs: ${idStatus.length - missing.length}/${idStatus.length} present`);
    console.log('Radio/checkbox defaults:', JSON.stringify(radioState));
    console.log(`pageerrors captured: ${pageErrors.length}`);
    console.log('Behavior smoke:', JSON.stringify(behavior));
    if (broken.length) {
        console.error(`FAIL: behavior elements not visible/enabled: ${broken.join(', ')}`);
    }

    let failed = false;
    if (missing.length) {
        console.error(`FAIL: missing locked IDs:\n  ${missing.join('\n  ')}`);
        failed = true;
    }
    if (!radioState.moveExists || !radioState.copyExists) {
        console.error('FAIL: move/copy radios missing');
        failed = true;
    }
    if (radioState.moveChecked || !radioState.copyChecked) {
        console.error(
            `FAIL: copy radio must be the default checked one (move=${radioState.moveChecked}, copy=${radioState.copyChecked})`
        );
        failed = true;
    }
    if (!radioState.confirmChecked) {
        console.error('FAIL: confirmBeforeMove default must be checked');
        failed = true;
    }
    if (failed) {
        process.exit(1);
    }
    console.log('PASS: all locked IDs present, copy default + confirm default contracts hold.');
}

main().catch((err) => {
    console.error('Screenshot script failed:', err);
    process.exit(1);
});
