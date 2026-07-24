// Task 2 verification: Help is reachable at supported desktop widths.

const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8488';
const DESKTOP_VIEWPORTS = [
    { width: 2560, height: 1440, label: '2560x1440' },
    { width: 1920, height: 1080, label: '1920x1080' },
    { width: 1440, height: 900, label: '1440x900' },
    { width: 1366, height: 768, label: '1366x768' },
    { width: 1280, height: 720, label: '1280x720' },
];

async function checkDesktop(browser, vp) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    await ctx.addInitScript(() => {
        localStorage.setItem('aurora-entry-skip', '1');
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(500);

    const visible = await page.evaluate(() => {
        const btn = document.getElementById('btn-help');
        return Boolean(btn && btn.offsetParent !== null);
    });
    if (!visible) {
        throw new Error(`[desktop ${vp.label}] #btn-help should be visible but is hidden`);
    }
    await page.click('#btn-help');
    await page.waitForSelector('.guide-overlay.visible', { timeout: 5000 });
    console.log(`[ok] desktop ${vp.label}: ❓ button visible + opens guide`);
    await ctx.close();
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const vp of DESKTOP_VIEWPORTS) await checkDesktop(browser, vp);
        console.log('--- ALL TASK 2 CHECKS PASSED ---');
    } finally {
        await browser.close();
    }
})().catch((err) => {
    console.error('TASK 2 TEST FAILED:', err.message);
    process.exit(1);
});
