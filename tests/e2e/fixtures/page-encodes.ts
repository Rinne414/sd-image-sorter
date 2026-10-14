import type { Page } from '@playwright/test'

/**
 * Count PNG encodes on the page's own thread (call before the page opens).
 * Saves (the censored copy, a training mask) must encode in a worker: on the
 * page, OffscreenCanvas.convertToBlob waits for idle time (about a second when
 * the page is busy or has no window), which made saves slow on a busy computer.
 */
export async function countPageEncodes(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __pagePngEncodes: number }
    w.__pagePngEncodes = 0
    const original = OffscreenCanvas.prototype.convertToBlob
    OffscreenCanvas.prototype.convertToBlob = function (options?: ImageEncodeOptions) {
      if (!options?.type || options.type === 'image/png') w.__pagePngEncodes++
      return original.call(this, options)
    }
  })
  return () => page.evaluate(() => (window as unknown as { __pagePngEncodes: number }).__pagePngEncodes)
}
