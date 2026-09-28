import { expect, type Page } from '@playwright/test'

/**
 * Resize, then wait until ui-scale.js has applied the zoom for the new width.
 * It switches the root zoom 150 ms after a resize (1.3x at 2560, 1x at 1366
 * and 1920). A measurement or click inside that window races the relayout:
 * Playwright re-scrolls its click target and the scroll looks like the app's.
 */
export async function resizeAndSettleUiScale(
  page: Page,
  viewport: { width: number, height: number },
): Promise<void> {
  await page.setViewportSize(viewport)
  await expect.poll(async () => page.evaluate(() => {
    const scale = window.UiScale
    return Boolean(scale) && scale.get() === scale.autoScaleForWidth(window.innerWidth)
  })).toBe(true)
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  }))
}
