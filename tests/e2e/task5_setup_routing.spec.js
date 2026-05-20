// Task 5 verification: Setup CTAs in tagger modal close the tagger,
// open the Model Manager, scroll to the relevant card, and add the
// is-highlighted class for ~2s.

const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8488';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForLoadState('networkidle').catch(() => {});

    // -- Open tag modal, switch to Natural Language tab --
    await page.click('#btn-tag');
    await page.waitForSelector('#tag-modal.visible', { timeout: 5000 });
    await page.waitForTimeout(800);
    await page.click('#tag-modal .tagger-tab[data-tagger-tab="nl"]');
    await page.waitForTimeout(300);

    // -- Click ToriiGate Setup CTA --
    await page.click('#btn-tagger-toriigate-setup');

    // Tagger modal should close, Model Manager should open.
    await page.waitForSelector('#model-manager-modal.visible', { timeout: 5000 });
    console.log('[ok] Model Manager opened from ToriiGate setup CTA');

    // Tagger modal should be closed (not visible).
    const taggerVisible = await page.evaluate(() => {
        const el = document.getElementById('tag-modal');
        return el && el.classList.contains('visible');
    });
    if (taggerVisible) throw new Error('Tagger modal should close before Model Manager opens');
    console.log('[ok] tagger modal closed');

    // ToriiGate card eventually gets the is-highlighted class.
    let highlighted = false;
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(150);
        highlighted = await page.evaluate(() => {
            const card = document.querySelector('.model-card[data-model-id="toriigate"]');
            return Boolean(card && card.classList.contains('is-highlighted'));
        });
        if (highlighted) break;
    }
    if (!highlighted) {
        throw new Error('ToriiGate card never received is-highlighted class');
    }
    console.log('[ok] ToriiGate card highlighted');

    // Highlight should fade after ~2.4s.
    await page.waitForTimeout(2700);
    const stillHighlighted = await page.evaluate(() => {
        const card = document.querySelector('.model-card[data-model-id="toriigate"]');
        return Boolean(card && card.classList.contains('is-highlighted'));
    });
    if (stillHighlighted) {
        throw new Error('Highlight should clear after ~2.4s');
    }
    console.log('[ok] highlight cleared after timeout');

    // -- Repeat for Aesthetic Setup CTA --
    // Close model manager.
    await page.evaluate(() => {
        const m = document.getElementById('model-manager-modal');
        if (m) m.classList.remove('visible');
    });
    await page.waitForTimeout(200);

    // Re-open tagger, switch to Aesthetic tab.
    await page.click('#btn-tag');
    await page.waitForSelector('#tag-modal.visible', { timeout: 5000 });
    await page.waitForTimeout(500);
    await page.click('#tag-modal .tagger-tab[data-tagger-tab="aesthetic"]');
    await page.waitForTimeout(300);

    // Force the Setup button visible by simulating "missing" state. The real
    // path checks window._aestheticStatus, but for the routing test we just
    // make the button visible and click it.
    await page.evaluate(() => {
        const btn = document.getElementById('btn-tagger-aesthetic-setup');
        if (btn) btn.style.display = '';
    });
    await page.click('#btn-tagger-aesthetic-setup');

    await page.waitForSelector('#model-manager-modal.visible', { timeout: 5000 });
    console.log('[ok] Aesthetic setup CTA opened Model Manager');

    let aestheticHighlighted = false;
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(150);
        aestheticHighlighted = await page.evaluate(() => {
            const card = document.querySelector('.model-card[data-model-id="aesthetic"]');
            return Boolean(card && card.classList.contains('is-highlighted'));
        });
        if (aestheticHighlighted) break;
    }
    if (!aestheticHighlighted) {
        throw new Error('Aesthetic card never highlighted');
    }
    console.log('[ok] Aesthetic card highlighted');

    await browser.close();
    console.log('--- ALL TASK 5 CHECKS PASSED ---');
})().catch((err) => {
    console.error('TASK 5 TEST FAILED:', err.message);
    process.exit(1);
});
