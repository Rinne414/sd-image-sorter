// Task 1 verification (round-2 simplified): cache-bust on every static
// /static/*.js + /static/*.css URL, so a normal F5 picks up the new
// language pack after an upgrade. The modal-side "Refresh translations"
// button was moved to the navbar in round 2 and tested in
// round2_real_api.spec.js.

const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8488';

async function main() {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    const page = await ctx.newPage();

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    const scriptSrcs = await page.$$eval('script[src]', (els) => els.map((e) => e.getAttribute('src')));
    const langScript = scriptSrcs.find((s) => s && s.includes('/lang/zh-CN.js'));
    if (!langScript || !langScript.includes('?v=')) {
        throw new Error('zh-CN.js not version-stamped: ' + langScript);
    }
    console.log('[ok] zh-CN.js cache-busted:', langScript);

    const cssLinks = await page.$$eval('link[rel="stylesheet"][href]', (els) => els.map((e) => e.getAttribute('href')));
    const stylesCss = cssLinks.find((s) => s && s.includes('/static/css/styles.css'));
    if (!stylesCss || !stylesCss.includes('?v=')) {
        throw new Error('styles.css not version-stamped: ' + stylesCss);
    }
    console.log('[ok] styles.css cache-busted:', stylesCss);

    await browser.close();
    console.log('--- TASK 1 (cache-bust) PASSED ---');
}

main().catch((err) => {
    console.error('TASK 1 TEST FAILED:', err.message);
    process.exit(1);
});
