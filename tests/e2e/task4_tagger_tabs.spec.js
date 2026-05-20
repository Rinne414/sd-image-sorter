// Task 4 verification: Tagger modal has 3 tabs (Local / NL / Aesthetic) and
// each tab swaps the right content + filters the dropdown.

const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8488';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    const page = await ctx.newPage();
    const vlmCalls = [];

    await page.route('**/api/vlm/settings', async (route) => {
        if (route.request().method() === 'POST') {
            const body = route.request().postDataJSON();
            vlmCalls.push({ type: 'save', body });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ status: 'ok' }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                provider: 'openai_compat',
                endpoint: 'http://old.example/v1',
                model: 'old-model',
                timeout_seconds: 60,
                concurrent_requests: 2,
                include_tags_as_context: true,
            }),
        });
    });
    await page.route('**/api/vlm/models', async (route) => {
        vlmCalls.push({ type: 'models' });
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ models: ['fresh-vlm-model'] }),
        });
    });
    await page.route('**/api/vlm/test', async (route) => {
        vlmCalls.push({ type: 'test' });
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', models: ['fresh-vlm-model'] }),
        });
    });
    await page.route('**/api/vlm/local-models/recommended', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ollama_installed: true, ollama_running: false, models: [], local_models: [] }),
        });
    });
    let progressPolls = 0;
    await page.route('**/api/vlm/caption-batch', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        let body = {};
        try { body = route.request().postDataJSON(); } catch (_e) {}
        vlmCalls.push({ type: 'batch', body });
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'started', total: 2, output_format: 'nl_caption' }),
        });
    });
    await page.route('**/api/vlm/caption-batch/progress', async (route) => {
        progressPolls += 1;
        const running = progressPolls < 2;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                running,
                total: 2,
                completed: running ? 1 : 1,
                failed: running ? 0 : 1,
                tokens_used: 88,
                current_image: running ? 'api-waiting.png' : '',
                active_requests: running ? 1 : 0,
                api_status: running ? 'waiting' : 'done_with_errors',
                api_message: running ? 'Waiting for API response: api-waiting.png' : 'Finished with API or image errors',
                api_ok: 1,
                api_error: running ? 0 : 1,
                last_api_latency_ms: running ? null : 321,
                last_api_error: running ? '' : 'HTTP 401: bad key',
                errors: running ? [] : [{ image_id: 2, error: 'HTTP 401: bad key', error_type: 'auth' }],
            }),
        });
    });
    await page.route('**/api/vlm/caption-batch/debug-chat', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                running: false,
                limit: 80,
                events: [
                    {
                        id: 1,
                        phase: 'request',
                        image_id: 1,
                        image_name: 'api-waiting.png',
                        provider: 'openai_compat',
                        model: 'fresh-vlm-model',
                        system_prompt: 'You are a captioner.',
                        user_prompt: 'Describe this image.',
                        tags: ['1girl', 'blue hair'],
                        note: 'Image bytes are sent to the API but hidden here; API keys and base64 payloads are never shown.',
                    },
                    {
                        id: 2,
                        phase: 'error',
                        request_id: 1,
                        image_id: 1,
                        image_name: 'api-waiting.png',
                        latency_ms: 321,
                        tokens_used: 88,
                        error: 'HTTP 401: bad key',
                        error_type: 'auth',
                    },
                ],
            }),
        });
    });

    await page.goto(BASE);
    await page.waitForLoadState('networkidle').catch(() => {});

    // --- Open the Tag modal ---
    await page.click('#btn-tag');
    await page.waitForSelector('#tag-modal.visible', { timeout: 5000 });
    // Let app.js loadTaggerModels run.
    await page.waitForTimeout(800);

    // --- Tab buttons exist ---
    const tabs = await page.$$('#tag-modal .tagger-tab');
    if (tabs.length !== 3) throw new Error(`expected 3 tagger tabs, got ${tabs.length}`);
    console.log('[ok] 3 tagger tabs rendered');

    // --- Local tab is active by default ---
    const initial = await page.evaluate(() => {
        const active = document.querySelector('#tag-modal .tagger-tab.active');
        return active ? active.dataset.taggerTab : null;
    });
    if (initial !== 'local') throw new Error(`default tab should be local, got ${initial}`);
    console.log('[ok] Local tab active by default');

    // --- Local: dropdown should hide VLM + ToriiGate ---
    const localOptions = await page.evaluate(() => {
        const sel = document.getElementById('tag-model-select');
        if (!sel) return [];
        return Array.from(sel.querySelectorAll('option'))
            .filter((o) => !o.hidden)
            .map((o) => o.value);
    });
    console.log('[info] Local visible options:', localOptions);
    if (localOptions.includes('vlm')) throw new Error('Local tab should NOT show VLM option');
    if (localOptions.some((v) => v.includes('toriigate'))) {
        throw new Error('Local tab should NOT show ToriiGate option');
    }
    if (!localOptions.some((v) => v.startsWith('wd-'))) {
        throw new Error('Local tab is missing WD14 options');
    }
    console.log('[ok] Local tab dropdown filtered');
    const localDefaultUi = await page.evaluate(() => {
        const select = document.getElementById('tag-model-select');
        const current = document.getElementById('tagger-model-current');
        const list = document.getElementById('tag-model-choice-list');
        const selectStyle = select ? getComputedStyle(select) : null;
        return {
            currentVisible: Boolean(current && current.offsetParent !== null),
            listHidden: Boolean(list && list.hidden),
            visibleCards: Array.from(document.querySelectorAll('#tag-model-choice-list .tagger-model-choice'))
                .filter((el) => el.offsetParent !== null).length,
            selectWidth: select ? select.getBoundingClientRect().width : null,
            selectOpacity: selectStyle?.opacity,
            currentText: current ? current.textContent.trim() : '',
        };
    });
    if (!localDefaultUi.currentVisible || !localDefaultUi.listHidden || localDefaultUi.visibleCards !== 0) {
        throw new Error('Local tab should show compact current model summary by default, got ' + JSON.stringify(localDefaultUi));
    }
    if (localDefaultUi.selectWidth > 2 || localDefaultUi.selectOpacity !== '0') {
        throw new Error('native model select should remain visually hidden, got ' + JSON.stringify(localDefaultUi));
    }
    console.log('[ok] Local tab compact selector is closed by default');

    // --- Switch to Natural Language tab ---
    await page.click('#tag-modal .tagger-tab[data-tagger-tab="nl"]');
    await page.waitForTimeout(300);
    const nlOptions = await page.evaluate(() => {
        const sel = document.getElementById('tag-model-select');
        if (!sel) return [];
        return Array.from(sel.querySelectorAll('option'))
            .filter((o) => !o.hidden)
            .map((o) => o.value);
    });
    console.log('[info] NL visible options:', nlOptions);
    if (nlOptions.some((v) => v.startsWith('wd-'))) {
        throw new Error('NL tab should NOT show WD14 options');
    }
    if (!nlOptions.includes('vlm') && !nlOptions.some((v) => v.includes('toriigate'))) {
        throw new Error('NL tab missing both VLM and ToriiGate');
    }
    console.log('[ok] NL tab dropdown filtered to VLM/ToriiGate');
    const nlCards = await page.evaluate(() => {
        const values = Array.from(document.querySelectorAll('#tag-model-choice-list .tagger-model-choice'))
            .filter((el) => el.offsetParent !== null)
            .map((el) => el.dataset.modelValue);
        const hiddenStateInputs = Array.from(document.querySelectorAll('input[name="tagger-nl-source"]'))
            .every((el) => {
                const style = getComputedStyle(el.closest('.tagger-nl-source-inputs') || el);
                return style.opacity === '0' && style.pointerEvents === 'none';
            });
        const localActionsHidden = Array.from(document.querySelectorAll('#tag-modal .tagger-local-action'))
            .every((el) => el.offsetParent === null);
        return { values, hiddenStateInputs, localActionsHidden };
    });
    if (!nlCards.hiddenStateInputs) throw new Error('NL source radios should be hidden state inputs');
    if (!nlCards.localActionsHidden) throw new Error('Import/Export tag actions should hide on NL tab');
    if (!nlCards.values.includes('vlm') || !nlCards.values.some((v) => String(v).includes('toriigate'))) {
        throw new Error('NL visible cards missing VLM/ToriiGate: ' + JSON.stringify(nlCards.values));
    }
    console.log('[ok] NL tab uses visible source cards, not a second button strip');

    // VLM mode banner should be visible on NL tab.
    // After round-2 the NL tab carries a sub-toggle (ToriiGate / VLM API).
    // ToriiGate is the default. Only VLM API selection shows the banner.
    const initialBannerHidden = await page.evaluate(() => {
        const el = document.getElementById('vlm-mode-banner');
        return !el || el.offsetParent === null;
    });
    if (!initialBannerHidden) throw new Error('VLM banner should be HIDDEN by default on NL tab (ToriiGate is default sub-source)');
    console.log('[ok] NL tab default sub-source = ToriiGate; VLM banner hidden');

    await page.click('#tag-model-choice-list .tagger-model-choice[data-model-value="vlm"]');
    await page.waitForTimeout(300);
    const banner = await page.evaluate(() => {
        const el = document.getElementById('vlm-mode-banner');
        const workflow = document.getElementById('tagger-nl-workflow-card');
        const settings = document.getElementById('btn-vlm-banner-settings');
        const selected = document.querySelector('#tag-model-choice-list .tagger-model-choice.is-selected');
        return {
            legacyHidden: !el || el.offsetParent === null,
            workflowHidden: !workflow || workflow.offsetParent === null,
            settingsVisible: Boolean(settings && settings.offsetParent !== null),
            selectedText: selected ? selected.textContent.trim() : '',
        };
    });
    if (!banner.legacyHidden || !banner.workflowHidden || !banner.settingsVisible || !/VLM/i.test(banner.selectedText)) {
        throw new Error('NL tab should show compact selected VLM card, got ' + JSON.stringify(banner));
    }
    console.log('[ok] VLM API sub-source reveals compact selected-card actions');

    await page.click('#btn-vlm-banner-settings');
    await page.waitForSelector('#vlm-settings-modal.visible', { timeout: 5000 });
    await page.fill('#vlm-endpoint', 'http://fresh.example/v1');
    await page.fill('#vlm-model', 'fresh-vlm-model');
    await page.click('#btn-vlm-fetch-models');
    await page.waitForSelector('#vlm-model-list .vlm-model-item[data-model="fresh-vlm-model"]', { timeout: 5000 });
    await page.click('#btn-vlm-test');
    await page.waitForFunction(() => /Connected|连接成功/.test(document.getElementById('vlm-status')?.textContent || ''), null, { timeout: 5000 });
    const callTypes = vlmCalls.map((c) => c.type).join(',');
    const firstModelIndex = vlmCalls.findIndex((c) => c.type === 'models');
    const firstTestIndex = vlmCalls.findIndex((c) => c.type === 'test');
    const saveBeforeModels = vlmCalls.slice(0, firstModelIndex).some((c) => c.type === 'save' && c.body?.endpoint === 'http://fresh.example/v1');
    const saveBeforeTest = vlmCalls.slice(0, firstTestIndex).some((c) => c.type === 'save' && c.body?.model === 'fresh-vlm-model');
    if (!saveBeforeModels || !saveBeforeTest) {
        throw new Error('VLM Fetch/Test should save current form before action, calls=' + callTypes);
    }
    console.log('[ok] VLM Fetch Models and Test Connection auto-save current form values first');
    await page.click('#vlm-settings-modal .modal-close');
    await page.waitForTimeout(150);

    await page.evaluate(() => {
        const card = document.createElement('div');
        card.className = 'gallery-item';
        card.dataset.id = '1';
        document.body.appendChild(card);
    });
    await page.click('#btn-start-tag');
    await page.waitForSelector('#vlm-progress-container', { state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => /Done|成功/.test(document.getElementById('vlm-progress-text')?.textContent || ''), null, { timeout: 5000 });
    const vlmProgress = await page.evaluate(() => ({
        workflowVisible: Boolean(document.getElementById('tagger-nl-workflow-card')?.offsetParent),
        progressVisible: Boolean(document.getElementById('vlm-progress-container')?.offsetParent),
        progressText: document.getElementById('vlm-progress-text')?.textContent || '',
        statusText: document.getElementById('vlm-batch-status')?.textContent || '',
        retryVisible: Boolean(document.getElementById('btn-vlm-retry-failed')?.offsetParent),
        retryText: document.getElementById('btn-vlm-retry-failed')?.textContent || '',
        errorVisible: Boolean(document.getElementById('vlm-error-list')?.offsetParent),
        errorText: document.getElementById('vlm-error-list')?.textContent || '',
    }));
    if (!vlmProgress.workflowVisible || !vlmProgress.progressVisible) {
        throw new Error('VLM progress should be visible while running: ' + JSON.stringify(vlmProgress));
    }
    if (!/Done 1\/2|成功 1\/2/.test(vlmProgress.progressText) || !/Failed 0|失败 0/.test(vlmProgress.progressText) || !/API/.test(vlmProgress.progressText) || !/waiting response|等待响应/.test(vlmProgress.progressText)) {
        throw new Error('VLM progress should show success/failed/API response status: ' + JSON.stringify(vlmProgress));
    }
    await page.waitForFunction(() => /HTTP 401|bad key|done with errors|完成但有错误/.test((document.getElementById('vlm-batch-status')?.textContent || '') + (document.getElementById('vlm-error-list')?.textContent || '')), null, { timeout: 5000 });
    await page.waitForFunction(() => document.getElementById('btn-vlm-retry-failed')?.offsetParent !== null, null, { timeout: 5000 });
    console.log('[ok] VLM progress shows success/error counts plus API responding/error status');

    const postFailureUi = await page.evaluate(() => ({
        retryText: document.getElementById('btn-vlm-retry-failed')?.textContent || '',
        errorText: document.getElementById('vlm-error-list')?.textContent || '',
    }));
    if (!/Retry failed|重试失败/.test(postFailureUi.retryText) || !/Image #2/.test(postFailureUi.errorText)) {
        throw new Error('Failed VLM run should expose retry button and failed image list, got ' + JSON.stringify(postFailureUi));
    }

    progressPolls = 0;
    const beforeRetryBatchCalls = vlmCalls.filter((c) => c.type === 'batch').length;
    await page.click('#btn-vlm-retry-failed');
    await page.waitForTimeout(250);
    const retryCall = vlmCalls.filter((c) => c.type === 'batch')[beforeRetryBatchCalls];
    if (!retryCall || JSON.stringify(retryCall.body?.image_ids || []) !== JSON.stringify([2])) {
        throw new Error('Retry failed should POST only failed image ids, got ' + JSON.stringify(retryCall));
    }
    console.log('[ok] Retry failed reruns only failed VLM image ids');

    await page.click('#tag-modal .tagger-tab[data-tagger-tab="local"]');
    await page.waitForTimeout(250);
    const hiddenOnLocal = await page.evaluate(() => ({
        workflowVisible: Boolean(document.getElementById('tagger-nl-workflow-card')?.offsetParent),
        retryVisible: Boolean(document.getElementById('btn-vlm-retry-failed')?.offsetParent),
        statusText: document.getElementById('vlm-batch-status')?.textContent || '',
    }));
    if (hiddenOnLocal.workflowVisible || hiddenOnLocal.retryVisible) {
        throw new Error('VLM completion/error UI must not follow to Local tab, got ' + JSON.stringify(hiddenOnLocal));
    }
    await page.click('#tag-modal .tagger-tab[data-tagger-tab="nl"]');
    await page.waitForTimeout(250);
    await page.click('#tag-model-choice-list .tagger-model-choice[data-model-value="vlm"]');
    await page.waitForTimeout(250);

    await page.click('#btn-vlm-debug-chat');
    await page.waitForSelector('#vlm-debug-chat-modal.visible', { timeout: 5000 });
    await page.waitForFunction(() => /You are a captioner|HTTP 401|API keys and base64/.test(document.getElementById('vlm-debug-chat-list')?.textContent || ''), null, { timeout: 5000 });
    const debugText = await page.textContent('#vlm-debug-chat-list');
    if (!debugText.includes('Describe this image.') || !debugText.includes('HTTP 401') || /data:image|base64,|sk-/.test(debugText)) {
        throw new Error('API Chat should show prompt/error and hide base64/API keys: ' + debugText);
    }
    console.log('[ok] API Chat modal shows sanitized request/response details');
    await page.click('#btn-vlm-debug-chat-close');
    await page.waitForTimeout(150);

    // Toggle back to ToriiGate so the rest of the test runs with ToriiGate
    // as the active selection (matches what the user would see on first open).
    await page.click('#tag-model-choice-list .tagger-model-choice[data-model-value="toriigate-0.5"]');
    await page.waitForTimeout(300);

    // ToriiGate setup card visible on NL tab.
    const toriCard = await page.evaluate(() => {
        const el = document.getElementById('tagger-nl-toriigate-card');
        return Boolean(el && el.offsetParent !== null);
    });
    if (!toriCard) throw new Error('NL tab should show ToriiGate setup card');
    console.log('[ok] NL tab shows ToriiGate setup card');

    // tagger-model-panel + tag-advanced-options must be HIDDEN on NL tab.
    const modelPanelHidden = await page.evaluate(() => {
        const el = document.getElementById('tagger-model-panel');
        return el && el.offsetParent === null;
    });
    if (!modelPanelHidden) throw new Error('tagger-model-panel should hide on NL');
    console.log('[ok] WD14-only sections hidden on NL tab');

    // --- Switch to Aesthetic tab ---
    await page.click('#tag-modal .tagger-tab[data-tagger-tab="aesthetic"]');
    await page.waitForTimeout(300);

    const aestheticPanelVisible = await page.evaluate(() => {
        const el = document.getElementById('tagger-aesthetic-panel');
        return Boolean(el && el.offsetParent !== null);
    });
    if (!aestheticPanelVisible) throw new Error('Aesthetic panel should be visible');
    console.log('[ok] Aesthetic panel visible');

    // The standard tagger modal-actions row should be HIDDEN on aesthetic tab.
    const localActionsHidden = await page.evaluate(() => {
        const el = document.getElementById('tagger-modal-actions');
        return el && el.offsetParent === null;
    });
    if (!localActionsHidden) throw new Error('tagger-modal-actions should hide on aesthetic tab');
    const aestheticActionsVisible = await page.evaluate(() => {
        const el = document.getElementById('tagger-modal-actions-aesthetic');
        return Boolean(el && el.offsetParent !== null);
    });
    if (!aestheticActionsVisible) throw new Error('aesthetic-only actions row missing');
    console.log('[ok] Aesthetic tab swaps action row');

    // --- Switch back to Local ---
    await page.click('#tag-modal .tagger-tab[data-tagger-tab="local"]');
    await page.waitForTimeout(300);
    const localPanelVisible = await page.evaluate(() => {
        const el = document.getElementById('tagger-model-panel');
        return Boolean(el && el.offsetParent !== null);
    });
    if (!localPanelVisible) throw new Error('Local tab failed to re-show tagger-model-panel');
    console.log('[ok] back to Local restores WD14 panel');

    await browser.close();
    console.log('--- ALL TASK 4 CHECKS PASSED ---');
})().catch((err) => {
    console.error('TASK 4 TEST FAILED:', err.message);
    process.exit(1);
});
