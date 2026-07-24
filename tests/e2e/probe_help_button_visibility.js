// Probe ❓ help button visibility at common desktop widths.
// Run with backend already up.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8488';

const VIEWPORTS = [
    { width: 2560, height: 1440, label: '2560x1440' },
    { width: 1920, height: 1080, label: '1920x1080' },
    { width: 1440, height: 900,  label: '1440x900'  },
    { width: 1366, height: 768,  label: '1366x768'  },
    { width: 1280, height: 720,  label: '1280x720'  },
];

(async () => {
    const browser = await chromium.launch({ headless: true });
    for (const v of VIEWPORTS) {
        const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height } });
        await ctx.addInitScript(() => {
            localStorage.setItem('aurora-entry-skip', '1');
        });
        const page = await ctx.newPage();
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        // Settle layout
        await page.waitForTimeout(500);
        const info = await page.evaluate(() => {
            const btn = document.getElementById('btn-help');
            if (!btn) return { exists: false };
            const r = btn.getBoundingClientRect();
            const style = window.getComputedStyle(btn);
            const navActions = btn.closest('.nav-actions');
            const navRect = navActions ? navActions.getBoundingClientRect() : null;
            return {
                exists: true,
                visible: btn.offsetParent !== null,
                display: style.display,
                visibility: style.visibility,
                rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                inViewport: r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight,
                rightOverflow: r.right - window.innerWidth,
                navActionsRect: navRect ? { x: Math.round(navRect.x), w: Math.round(navRect.width) } : null,
                viewportWidth: window.innerWidth,
            };
        });
        console.log(v.label, JSON.stringify(info));
        await ctx.close();
    }
    await browser.close();
})();
