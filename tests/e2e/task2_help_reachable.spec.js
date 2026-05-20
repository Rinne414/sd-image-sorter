// Task 2 verification: ❓ Help is reachable at every desktop AND mobile width.
// At >=769px the desktop nav-actions row carries #btn-help.
// At <=768px we now expose #mobile-btn-help inside the hamburger overlay.

const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8488';

const DESKTOP_VIEWPORTS = [
    { width: 1920, height: 1080, label: '1920x1080' },
    { width: 1366, height: 768,  label: '1366x768'  },
    { width: 1024, height: 768,  label: '1024x768'  },
    { width: 800,  height: 720,  label: '800x720'   },
];
const MOBILE_VIEWPORTS = [
    { width: 768, height: 800, label: '768x800' },
    { width: 600, height: 900, label: '600x900' },
    { width: 480, height: 800, label: '480x800' },
];

async function checkDesktop(browser, vp) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
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

async function checkMobile(browser, vp) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(500);

    // At narrow widths the desktop nav-actions row is hidden by CSS,
    // so #btn-help should NOT be visible.
    const desktopVisible = await page.evaluate(() => {
        const btn = document.getElementById('btn-help');
        return Boolean(btn && btn.offsetParent !== null);
    });
    if (desktopVisible) {
        throw new Error(`[mobile ${vp.label}] desktop #btn-help leaked into mobile layout`);
    }

    // Open the hamburger menu.
    const togglePresent = await page.$('#mobile-menu-toggle');
    if (!togglePresent) {
        throw new Error(`[mobile ${vp.label}] hamburger toggle not present`);
    }
    await page.click('#mobile-menu-toggle');

    // Wait for overlay to be visible.
    await page.waitForFunction(() => {
        const o = document.getElementById('mobile-nav-overlay');
        return o && o.classList.contains('visible');
    }, { timeout: 5000 });

    // The new mobile-btn-help should be visible inside the overlay.
    const helpVisible = await page.evaluate(() => {
        const btn = document.getElementById('mobile-btn-help');
        return Boolean(btn && btn.offsetParent !== null);
    });
    if (!helpVisible) {
        throw new Error(`[mobile ${vp.label}] #mobile-btn-help not reachable in hamburger menu`);
    }

    // Click it. Mobile overlay should close, guide should open.
    await page.click('#mobile-btn-help');
    await page.waitForSelector('.guide-overlay.visible', { timeout: 5000 });

    const overlayClosed = await page.evaluate(() => {
        const o = document.getElementById('mobile-nav-overlay');
        return !o.classList.contains('visible');
    });
    if (!overlayClosed) {
        throw new Error(`[mobile ${vp.label}] mobile nav overlay did not close before guide opened`);
    }
    console.log(`[ok] mobile ${vp.label}: hamburger \u2192 ❓ \u2192 guide visible, overlay closed`);
    await ctx.close();
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const vp of DESKTOP_VIEWPORTS) await checkDesktop(browser, vp);
        for (const vp of MOBILE_VIEWPORTS) await checkMobile(browser, vp);
        console.log('--- ALL TASK 2 CHECKS PASSED ---');
    } finally {
        await browser.close();
    }
})().catch((err) => {
    console.error('TASK 2 TEST FAILED:', err.message);
    process.exit(1);
});
