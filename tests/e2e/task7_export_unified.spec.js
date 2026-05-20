const { chromium } = require('playwright');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8488';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function solidPng(width, height, rgb) {
    const [r, g, b] = rgb;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 2;   // truecolor RGB
    ihdr[10] = 0;  // compression
    ihdr[11] = 0;  // filter
    ihdr[12] = 0;  // interlace

    const stride = 1 + width * 3;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
        const row = y * stride;
        raw[row] = 0;
        for (let x = 0; x < width; x += 1) {
            const offset = row + 1 + x * 3;
            raw[offset] = r;
            raw[offset + 1] = g;
            raw[offset + 2] = b;
        }
    }

    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND'),
    ]);
}

async function apiJson(request, method, endpoint, data = undefined) {
    const response = await request.fetch(`${BASE}${endpoint}`, {
        method,
        data,
        timeout: 30000,
    });
    if (!response.ok()) {
        throw new Error(`${method} ${endpoint} failed: HTTP ${response.status()} ${await response.text()}`);
    }
    return response.json();
}

async function waitForScanDone(request) {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        const progress = await apiJson(request, 'GET', '/api/scan/progress');
        if (progress.status === 'done') return progress;
        if (['error', 'cancelled'].includes(progress.status)) {
            throw new Error(`scan failed: ${JSON.stringify(progress)}`);
        }
        await delay(250);
    }
    throw new Error('scan did not finish in time');
}

async function prepareRealFixture(request) {
    const unique = `task7real${Date.now()}`;
    const fixtureDir = path.join(os.tmpdir(), unique);
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await fs.mkdir(fixtureDir, { recursive: true });

    const fixtureDefs = [
        {
            filename: `${unique}_01.png`,
            rgb: [54, 117, 181],
            caption: 'a blue-haired girl smiling in a clean LoRA training caption',
            tags: ['blue_hair', 'smile', '1girl', 'shared_pose', 'newest', 'safe'],
        },
        {
            filename: `${unique}_02.png`,
            rgb: [179, 78, 102],
            caption: 'a red themed portrait with soft studio lighting',
            tags: ['red_eyes', 'portrait', '1girl', 'shared_pose', 'highres', 'score_5'],
        },
        {
            filename: `${unique}_03.png`,
            rgb: [79, 151, 111],
            caption: 'a green outdoor character image for dataset review',
            tags: ['green_background', 'outdoors', 'solo', 'shared_pose', 'normal quality'],
        },
    ];

    for (const fixture of fixtureDefs) {
        await fs.writeFile(path.join(fixtureDir, fixture.filename), solidPng(128, 128, fixture.rgb));
    }

    await apiJson(request, 'POST', '/api/scan/reset', {});
    await apiJson(request, 'DELETE', '/api/clear-gallery');
    await apiJson(request, 'POST', '/api/scan', {
        folder_path: fixtureDir,
        recursive: false,
        quick_import: false,
        force_reparse: true,
    });
    await waitForScanDone(request);

    const imagesPayload = await apiJson(
        request,
        'GET',
        `/api/images?limit=20&sort_by=name_asc&search=${encodeURIComponent(unique)}`
    );
    const images = (imagesPayload.images || [])
        .filter((image) => String(image.filename || '').startsWith(unique))
        .sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
    if (images.length < fixtureDefs.length) {
        throw new Error(`fixture scan should return ${fixtureDefs.length} real DB images, got ${images.length}`);
    }

    const byFilename = new Map(images.map((image) => [image.filename, image]));
    const importImages = fixtureDefs.map((fixture) => {
        const image = byFilename.get(fixture.filename);
        if (!image) throw new Error(`missing scanned image ${fixture.filename}`);
        return {
            path: image.path,
            filename: image.filename,
            ai_caption: fixture.caption,
            tags: fixture.tags.map((tag, index) => ({ tag, confidence: 0.99 - index * 0.03 })),
        };
    });
    const importResult = await apiJson(request, 'POST', '/api/tags/import', {
        images: importImages,
        overwrite: true,
    });
    if (importResult.imported !== importImages.length) {
        throw new Error(`tag/caption import should update all fixtures, got ${JSON.stringify(importResult)}`);
    }

    return {
        fixtureDir,
        unique,
        imageIds: importImages.map((item) => byFilename.get(item.filename).id),
    };
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    const page = await ctx.newPage();
    const fixture = await prepareRealFixture(ctx.request);

    await page.goto(BASE);
    await page.waitForLoadState('networkidle').catch(() => {});

    await page.waitForFunction((ids) => (
        ids.every((id) => document.querySelector(`.gallery-item[data-id="${id}"]`))
    ), fixture.imageIds, { timeout: 10000 });
    await page.evaluate((ids) => {
        window.App?.setSelectionState?.({
            selectionMode: true,
            selectedIds: new Set(ids),
            scope: 'visible',
            filterKey: null,
            selectionToken: null,
            selectionTotal: ids.length,
        });
    }, fixture.imageIds);

    // -- Open the batch-export-modal through the real selection-panel button.
    //    This exercises the same count/description setup a user gets. --
    await page.evaluate(() => {
        window.App?.updateSelectionUI?.();
    });
    await page.locator('#btn-batch-export-tags').click();
    await page.waitForSelector('#batch-export-modal.visible', { timeout: 5000 });
    await page.waitForFunction(() => /3/.test(document.getElementById('batch-export-count')?.textContent || ''), null, { timeout: 5000 });
    await page.waitForTimeout(700);

    // -- 1. 4 output-destination radios exist --
    const radioValues = await page.$$eval(
        'input[name="batch-export-output-mode"]',
        (els) => els.map((e) => e.value)
    );
    console.log('[info] output-mode values:', radioValues);
    for (const expect of ['beside_image', 'folder', 'clipboard', 'download']) {
        if (!radioValues.includes(expect)) {
            throw new Error(`missing output-mode option: ${expect}`);
        }
    }
    console.log('[ok] 4 output-mode radios present');

    // -- 2. Preview grid visible by default (was previously template-only) --
    const gridVisible = await page.evaluate(() => {
        const el = document.getElementById('batch-export-grid');
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none';
    });
    if (!gridVisible) throw new Error('preview grid should be visible by default');
    console.log('[ok] preview grid visible by default');
    const defaultGridState = await page.evaluate(() => {
        const grid = document.getElementById('batch-export-grid');
        const preview = document.getElementById('export-preview-group');
        const lora = document.getElementById('lora-template-section');
        const modal = document.querySelector('#batch-export-modal .modal-content');
        const gridRect = grid?.getBoundingClientRect();
        const previewRect = preview?.getBoundingClientRect();
        const modalRect = modal?.getBoundingClientRect();
        return {
            mode: grid?.dataset.contentMode,
            columns: grid ? getComputedStyle(grid).gridTemplateColumns : '',
            loraHidden: !lora || getComputedStyle(lora).display === 'none',
            gridWidth: gridRect?.width || 0,
            previewWidth: previewRect?.width || 0,
            modalWidth: modalRect?.width || 0,
        };
    });
    if (!defaultGridState.loraHidden || defaultGridState.previewWidth < defaultGridState.modalWidth * 0.75) {
        throw new Error('default non-template export preview should use the modal width, got ' + JSON.stringify(defaultGridState));
    }
    console.log('[ok] default export preview uses full-width layout');
    const defaultWorkbenchState = await page.evaluate(() => ({
        hasWorkbench: Boolean(document.querySelector('#export-preview-list .export-preview-workbench')),
        hasQueue: Boolean(document.querySelector('#export-preview-list .export-preview-queue')),
        hasEditor: Boolean(document.querySelector('#export-preview-list .export-preview-editor')),
        hasTools: Boolean(document.querySelector('#export-preview-list .export-preview-tools')),
        hasSaveNote: Boolean(document.querySelector('#export-preview-list .export-preview-save-note')),
        hasChecks: Boolean(document.querySelector('.export-preview-checks')),
        hasCleanup: Boolean(document.querySelector('.export-preview-cleanup')),
        queueItems: document.querySelectorAll('.export-preview-queue-item').length,
        helperText: document.querySelector('.export-preview-editor-helper')?.textContent || '',
        commonHelperText: document.querySelector('.export-preview-tools-helper')?.textContent || '',
    }));
    if (!defaultWorkbenchState.hasWorkbench || !defaultWorkbenchState.hasQueue || !defaultWorkbenchState.hasEditor || !defaultWorkbenchState.hasTools || !defaultWorkbenchState.hasSaveNote || !defaultWorkbenchState.hasChecks || !defaultWorkbenchState.hasCleanup || defaultWorkbenchState.queueItems < 1) {
        throw new Error('preview should render the review/edit workbench, got ' + JSON.stringify(defaultWorkbenchState));
    }
    console.log('[ok] preview workbench surfaces queue/editor/tools panels');

    await page.selectOption('#batch-export-content-mode', 'tags_nl');
    await page.waitForResponse((resp) => resp.url().includes('/api/tags/export-preview') && resp.request().method() === 'POST', { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => {
        const value = document.querySelector('.export-preview-main-textarea')?.value || '';
        return /(blue_hair|red_eyes|green_background|outdoors|shared_pose)/i.test(value)
            && /(blue-haired girl|red themed portrait|green outdoor character)/i.test(value);
    }, null, { timeout: 5000 });
    const tagsNlState = await page.evaluate(() => {
        const select = document.getElementById('batch-export-content-mode');
        const value = document.querySelector('.export-preview-main-textarea')?.value || '';
        const description = document.getElementById('batch-export-content-description')?.textContent || '';
        const renderedRows = (window.V321Integration?.previewResults || []).map((item) => item.rendered || '');
        return {
            optionText: select?.selectedOptions?.[0]?.textContent?.trim() || '',
            value,
            description,
            renderedRows,
        };
    });
    if (!/Tags.*Natural language|Tags.*自然语言/i.test(tagsNlState.optionText)) {
        throw new Error('Tags + Natural Language option should be selectable, got ' + JSON.stringify(tagsNlState));
    }
    if (!tagsNlState.value || !/Tags|Natural Language|自然语言|caption/i.test(tagsNlState.description)) {
        throw new Error('Tags + Natural Language mode should render preview and description, got ' + JSON.stringify(tagsNlState));
    }
    if (/original prompt should not appear|task7real/i.test(tagsNlState.value)) {
        throw new Error('Tags + Natural Language mode should not include original prompt/search boilerplate, got ' + JSON.stringify(tagsNlState));
    }
    const renderedJoined = tagsNlState.renderedRows.join('\n');
    for (const expected of ['blue-haired girl', 'red themed portrait', 'green outdoor character']) {
        if (!renderedJoined.includes(expected)) {
            throw new Error(`Tags + Natural Language preview should render ${expected}, got ` + JSON.stringify(tagsNlState));
        }
    }
    console.log('[ok] Tags + Natural Language caption mode is exposed and renders a preview');

    await page.selectOption('#batch-export-content-mode', 'template');
    await page.waitForResponse((resp) => resp.url().includes('/api/tags/export-preview') && resp.request().method() === 'POST', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const templateLayout = await page.evaluate(() => {
        const preview = document.getElementById('export-preview-group');
        const list = document.getElementById('export-preview-list');
        const workbench = document.querySelector('#export-preview-list .export-preview-workbench');
        const queue = document.querySelector('#export-preview-list .export-preview-queue');
        const editor = document.querySelector('#export-preview-list .export-preview-editor');
        const tools = document.querySelector('#export-preview-list .export-preview-tools');
        const modal = document.querySelector('#batch-export-modal .modal-content');
        const rect = (el) => {
            const r = el?.getBoundingClientRect?.();
            return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null;
        };
        const pr = rect(preview);
        const lr = rect(list);
        const wr = rect(workbench);
        const qr = rect(queue);
        const er = rect(editor);
        const tr = rect(tools);
        const mr = rect(modal);
        const tolerance = 2;
        return {
            mode: document.getElementById('batch-export-grid')?.dataset.contentMode,
            preview: pr,
            list: lr,
            workbench: wr,
            queue: qr,
            editor: er,
            tools: tr,
            modal: mr,
            toolsBelowEditor: Boolean(tr && er && tr.top >= er.bottom - tolerance),
            panelsInsideList: Boolean(lr && qr && er && tr
                && qr.left >= lr.left - tolerance && qr.right <= lr.right + tolerance
                && er.left >= lr.left - tolerance && er.right <= lr.right + tolerance
                && tr.left >= lr.left - tolerance && tr.right <= lr.right + tolerance),
            modalNotHorizOverflowing: Boolean(mr && mr.left >= -tolerance && mr.right <= window.innerWidth + tolerance),
            bodyScrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
        };
    });
    if (templateLayout.mode !== 'template' || !templateLayout.toolsBelowEditor || !templateLayout.panelsInsideList || !templateLayout.modalNotHorizOverflowing || templateLayout.bodyScrollWidth > templateLayout.viewportWidth + 2) {
        throw new Error('LoRA Training Template preview layout overflows/clips, got ' + JSON.stringify(templateLayout));
    }
    await page.screenshot({ path: '/tmp/sd-v321-template-preview-layout.png', fullPage: false });
    console.log('[ok] LoRA Training Template layout keeps queue/editor/tools inside the real browser viewport');

    // -- 3. Switch content mode to "tags" — preview pane stays visible,
    //       LoRA-template-section becomes hidden --
    await page.selectOption('#batch-export-content-mode', 'tags');
    await page.waitForTimeout(300);
    const gridStillVisible = await page.evaluate(() => {
        const el = document.getElementById('batch-export-grid');
        const style = window.getComputedStyle(el);
        return style.display !== 'none';
    });
    if (!gridStillVisible) {
        throw new Error('preview grid should stay visible when switching from template to tags');
    }
    const loraSectionHidden = await page.evaluate(() => {
        const el = document.getElementById('lora-template-section');
        if (!el) return true;
        return window.getComputedStyle(el).display === 'none';
    });
    if (!loraSectionHidden) {
        throw new Error('LoRA template section should be hidden when content mode is tags');
    }
    console.log('[ok] preview grid stays visible across content modes');

    // -- 4. Folder UI hidden when destination is beside_image (default) --
    const folderInitiallyHidden = await page.evaluate(() => {
        const el = document.getElementById('batch-export-folder-group');
        return !el || window.getComputedStyle(el).display === 'none';
    });
    if (!folderInitiallyHidden) {
        throw new Error('folder UI should be hidden when destination is beside_image');
    }
    console.log('[ok] folder UI hidden for beside_image');

    // -- 5. Switch to folder destination — folder UI becomes visible --
    await page.click('input[name="batch-export-output-mode"][value="folder"]', { force: true });
    await page.waitForTimeout(300);
    const folderUiVisible = await page.evaluate(() => {
        const el = document.getElementById('batch-export-folder-group');
        return el && window.getComputedStyle(el).display !== 'none';
    });
    if (!folderUiVisible) {
        throw new Error('folder UI should be visible when folder destination is chosen');
    }
    console.log('[ok] folder UI visible for folder dest');

    // -- 6. Switch to clipboard — folder UI hides again --
    await page.click('input[name="batch-export-output-mode"][value="clipboard"]', { force: true });
    await page.waitForTimeout(300);
    const folderUiHidden = await page.evaluate(() => {
        const el = document.getElementById('batch-export-folder-group');
        return !el || window.getComputedStyle(el).display === 'none';
    });
    if (!folderUiHidden) {
        throw new Error('folder UI should hide when destination is clipboard');
    }
    console.log('[ok] folder UI hidden for clipboard dest');

    // -- 7. Click Start with clipboard destination — should NOT call
    //       /api/tags/export-batch (client-side combined path). --
    let exportBatchCalls = 0;
    let previewCalls = 0;
    let previewPayloads = [];
    page.on('request', (req) => {
        if (req.url().includes('/api/tags/export-batch')) exportBatchCalls++;
        if (req.url().includes('/api/tags/export-preview')) {
            previewCalls++;
            try { previewPayloads.push(req.postDataJSON()); } catch (_e) {}
        }
    });
    await page.evaluate((ids) => {
        window.App?.setSelectionState?.({
            selectionMode: true,
            selectedIds: new Set(ids),
            scope: 'visible',
            filterKey: null,
            selectionToken: null,
            selectionTotal: ids.length,
        });
        // Stub navigator.clipboard so we don't actually write outside the
        // browser sandbox; record the value instead.
        window.__lastClipboardWrite = null;
        navigator.clipboard.writeText = async (txt) => {
            window.__lastClipboardWrite = txt;
        };
    }, fixture.imageIds);
    await page.locator('#batch-export-advanced-options summary').click();
    await page.fill('#batch-export-blacklist', 'newest, highres, normal quality, score_5, safe, 1girl');
    await page.waitForResponse((resp) => resp.url().includes('/api/tags/export-preview') && resp.request().method() === 'POST', { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => {
        const value = document.querySelector('.export-preview-main-textarea')?.value || '';
        return !/(^|,\\s*)(newest|highres|normal quality|score_5|safe|1girl)(\\s*,|$)/i.test(value);
    }, null, { timeout: 5000 }).catch(() => {});
    await page.fill('#export-preview-tag-input', 'qa_extra_tag');
    await page.click('.export-preview-tag-form button[data-i18n-key="batchExport.addToCurrent"]');
    const editedState = await page.evaluate(() => ({
        activeEdited: Boolean(document.querySelector('.export-preview-queue-item.active.edited')),
        text: document.querySelector('.export-preview-main-textarea')?.value || '',
    }));
    if (!editedState.activeEdited || !editedState.text.includes('qa_extra_tag')) {
        throw new Error('preview tag tool should edit the active caption, got ' + JSON.stringify(editedState));
    }
    console.log('[ok] preview workbench tag tool edits the active caption');
    await page.evaluate(() => {
        const textarea = document.querySelector('.export-preview-main-textarea');
        textarea.value = `${textarea.value}, newest, safe, score_5, qa_extra_tag`;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    });
    await page.click('.export-preview-cleanup button[data-preview-tool="dedupe-current"]');
    await page.click('.export-preview-cleanup button[data-preview-tool="blacklist-current"]');
    await page.click('.export-preview-cleanup button[data-preview-tool="boilerplate-current"]');
    const cleanupState = await page.evaluate(() => {
        const text = document.querySelector('.export-preview-main-textarea')?.value || '';
        const statTexts = Array.from(document.querySelectorAll('.export-preview-stat')).map((el) => el.textContent.trim());
        return { text, statTexts };
    });
    for (const blocked of ['newest', 'safe', 'score_5']) {
        if (cleanupState.text.includes(blocked)) {
            throw new Error('cleanup tools should remove blocked/boilerplate token ' + blocked + ', got ' + JSON.stringify(cleanupState));
        }
    }
    if ((cleanupState.text.match(/qa_extra_tag/g) || []).length !== 1) {
        throw new Error('dedupe should keep one qa_extra_tag, got ' + JSON.stringify(cleanupState));
    }
    console.log('[ok] preview cleanup tools dedupe and remove blacklist/quality boilerplate');
    await page.fill('#export-preview-tag-input', 'qa_global_tag');
    await page.click('.export-preview-tag-form button[data-i18n-key="batchExport.addToAllPreview"]');
    const allEditedState = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.export-preview-queue-item'));
        return {
            rows: rows.length,
            editedRows: rows.filter((row) => row.classList.contains('edited')).length,
            overrides: window.V321Integration?.collectEditedCaptionOverrides?.() || null,
        };
    });
    if (!allEditedState.rows || allEditedState.editedRows !== allEditedState.rows) {
        throw new Error('Add all should mark every preview row edited, got ' + JSON.stringify(allEditedState));
    }
    if (!allEditedState.overrides || !Object.values(allEditedState.overrides).every((text) => String(text).includes('qa_global_tag'))) {
        throw new Error('edited caption overrides should include Add all tag, got ' + JSON.stringify(allEditedState));
    }
    console.log('[ok] preview workbench Add all edits every preview caption and exposes overrides');
    await page.click('#btn-start-batch-export');
    await page.waitForTimeout(1500);

    if (exportBatchCalls > 0) {
        throw new Error(`clipboard path should not POST /api/tags/export-batch, got ${exportBatchCalls} call(s)`);
    }
    if (previewCalls === 0) {
        throw new Error('clipboard path should call /api/tags/export-preview to render content');
    }
    const lastPayload = previewPayloads[previewPayloads.length - 1] || {};
    const blacklist = Array.isArray(lastPayload.blacklist) ? lastPayload.blacklist : [];
    for (const blocked of ['newest', 'highres', 'normal quality', 'score_5', 'safe', '1girl']) {
        if (!blacklist.includes(blocked)) {
            throw new Error('preview/clipboard export did not pass blacklist token: ' + blocked + ' payload=' + JSON.stringify(lastPayload));
        }
    }
    console.log(`[ok] clipboard path: 0 export-batch calls, ${previewCalls} preview call(s)`);

    await browser.close();
    console.log('--- ALL TASK 7 CHECKS PASSED ---');
})().catch((err) => {
    console.error('TASK 7 TEST FAILED:', err.message);
    process.exit(1);
});
