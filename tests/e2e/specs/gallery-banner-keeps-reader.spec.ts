import { expect, test, type Page } from '@playwright/test'

/**
 * The missing-files banner sits above the Gallery toolbar and arrives a moment
 * after the first load (again after a scan or a reconnect); the "reading image
 * info" chip above the grid comes and goes with metadata reading. Nothing kept
 * the page still when they appeared or went away, so a reader scrolled down was
 * pushed down by their height, or pulled up when they went. After a relaunch the
 * saved place was a raw offset taken with the banner showing, so the reader
 * landed a banner's height off and was then jumped back when it arrived.
 * The image being read now stays put; at the top of the page the banner still
 * pushes the grid down, where it can be seen.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'
const COMFORT_KEY = 'sd-gallery-comfort-v1'
// Rounding of fractional heights; the jumps this guards against are 40-60 px.
const SAME_PLACE_PX = 1

interface MissingSummary {
  /** Hold the next missing-summary response until the returned function is called. */
  holdNext: () => () => void
  /** What the next responses report. */
  set: (total: number) => void
}

async function mockGallery(page: Page, count: number): Promise<MissingSummary> {
  const images = Array.from({ length: count }, (_, index) => ({
    id: 3001 + index,
    filename: `banner-${index + 1}.png`,
    path: `/mock/banner-${index + 1}.png`,
  }))
  let total = 3
  let hold: Promise<void> | null = null
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    const held = hold
    hold = null
    if (held) await held
    await route.fulfill({ json: total > 0
      ? { total, clearable_total: total, groups: [{ location: 'D:/old', count: total, reason: 'missing' }] }
      : { total: 0, clearable_total: 0, groups: [] } }).catch(() => {})
  })
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/images') {
      // The missing-summary mock above, or the real backend.
      await route.fallback()
      return
    }
    const start = Number(url.searchParams.get('cursor') || 0)
    const end = Math.min(images.length, start + Number(url.searchParams.get('limit') || 100))
    await route.fulfill({ json: {
      images: images.slice(start, end),
      total: start ? -1 : images.length,
      has_more: end < images.length,
      next_cursor: end < images.length ? String(end) : null,
    } }).catch(() => {})
  })
  return {
    holdNext: () => {
      let release: () => void = () => {}
      hold = new Promise<void>((resolve) => { release = resolve })
      return release
    },
    set: (next: number) => { total = next },
  }
}

async function openGallery(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
}

/** Scroll deep and report the image being read and where it sits. */
async function readDeep(page: Page, top: number) {
  await expect.poll(() => page.evaluate((target) => {
    window.scrollTo({ top: target, behavior: 'instant' })
    return Math.round(window.scrollY)
  }, top)).toBeGreaterThan(top - 50)
  // The grid draws the rows in view a frame or two after the scroll; until
  // then the only cards are far above and the anchor is one of those.
  let reader: { imageId: string, offset: number } | null = null
  await expect.poll(async () => {
    reader = await page.evaluate(() => new Promise<{ imageId: string, offset: number } | null>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const anchor = (window as any).Gallery._captureViewAnchor()
        const card = anchor && document.querySelector(`#gallery-grid .gallery-item[data-id="${anchor.imageId}"]`)
        const rect = card && card.getBoundingClientRect()
        const onScreen = rect && rect.bottom > 0 && rect.top < window.innerHeight
        resolve(onScreen ? { imageId: String(anchor.imageId), offset: Math.round(anchor.offset) } : null)
      }))
    }))
    return reader
  }).not.toBeNull()
  return reader!
}

/** Two frames from now: where the image `imageId` sits on screen. */
async function offsetOf(page: Page, imageId: string) {
  return page.evaluate((id) => new Promise<number | null>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const card = document.querySelector(`#gallery-grid .gallery-item[data-id="${id}"]`)
      resolve(card ? Math.round(card.getBoundingClientRect().top) : null)
    }))
  }), imageId)
}

async function expectInPlace(page: Page, reader: { imageId: string, offset: number }) {
  const offset = await offsetOf(page, reader.imageId)
  expect(offset, `image ${reader.imageId} should stay at ${reader.offset}`).not.toBeNull()
  expect(Math.abs(offset! - reader.offset), `image ${reader.imageId} at ${offset}, was ${reader.offset}`)
    .toBeLessThanOrEqual(SAME_PLACE_PX)
}

test('the banner arriving while the reader is deep leaves their image where it was', async ({ page }) => {
  const missing = await mockGallery(page, 400)
  const release = missing.holdNext()
  await openGallery(page)
  const reader = await readDeep(page, 3000)

  release()
  await expect(page.locator('#gallery-unreadable-banner')).toBeVisible()

  await expectInPlace(page, reader)
})

test('the banner going away while the reader is deep leaves their image where it was', async ({ page }) => {
  const missing = await mockGallery(page, 400)
  await openGallery(page)
  await expect(page.locator('#gallery-unreadable-banner')).toBeVisible()
  const reader = await readDeep(page, 3000)

  missing.set(0)
  await page.evaluate(() => (window as any).UnreadableBanner.refresh(true))
  await expect(page.locator('#gallery-unreadable-banner')).toBeHidden()

  await expectInPlace(page, reader)
})

test('at the top of the Gallery the banner still pushes the grid down, in sight', async ({ page }) => {
  const missing = await mockGallery(page, 400)
  const release = missing.holdNext()
  await openGallery(page)
  const gridTopBefore = await page.evaluate(() => Math.round(document.getElementById('gallery-grid')!.getBoundingClientRect().top))

  release()
  await expect(page.locator('#gallery-unreadable-banner')).toBeVisible()

  const after = await page.evaluate(() => ({
    y: Math.round(window.scrollY),
    bannerTop: Math.round(document.getElementById('gallery-unreadable-banner')!.getBoundingClientRect().top),
    gridTop: Math.round(document.getElementById('gallery-grid')!.getBoundingClientRect().top),
  }))
  expect(after.y).toBe(0)
  expect(after.bannerTop).toBeGreaterThanOrEqual(0)
  expect(after.gridTop).toBeGreaterThan(gridTopBefore)
})

test('the reading-image-info chip appearing while the reader is deep leaves their image where it was', async ({ page }) => {
  await mockGallery(page, 400)
  let pending = 0
  await page.route('**/api/stats**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/stats') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    const stats = await response.json()
    await route.fulfill({ response, json: { ...stats, metadata_pending: pending } })
  })
  await openGallery(page)
  await expect(page.locator('#gallery-unreadable-banner')).toBeVisible()
  await expect(page.locator('#metadata-status-chip')).toBeHidden()
  const reader = await readDeep(page, 3000)

  pending = 12
  await page.evaluate(() => (window as any).loadStats())
  await expect(page.locator('#metadata-status-chip')).toBeAttached()
  await expect.poll(() => page.evaluate(() => document.getElementById('metadata-status-chip')!.hidden)).toBe(false)

  await expectInPlace(page, reader)
})

test('after a relaunch the reader lands on the same image, before and after the banner arrives', async ({ page }) => {
  const missing = await mockGallery(page, 400)
  await openGallery(page)
  await expect(page.locator('#gallery-unreadable-banner')).toBeVisible()
  const reader = await readDeep(page, 3000)
  // The place is saved shortly after scrolling stops.
  await expect.poll(() => page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem(key) || '{}')
    return Math.round(saved.resume?.scrollTop ?? 0)
  }, COMFORT_KEY)).toBeGreaterThan(2900)

  const release = missing.holdNext()
  await page.reload()
  await expect(page.locator(`#gallery-grid .gallery-item[data-id="${reader.imageId}"]`)).toBeAttached()
  await expect.poll(() => page.evaluate(() => (window as any).GalleryComfort.isRestoring())).toBe(false)
  await expect(page.locator('#gallery-unreadable-banner')).toBeHidden()
  await expectInPlace(page, reader)

  release()
  await expect(page.locator('#gallery-unreadable-banner')).toBeVisible()
  await expectInPlace(page, reader)
})

test('a relaunch that lands while the Gallery is still sliding in puts the reader on the same image', async ({ page }) => {
  const missing = await mockGallery(page, 400)
  await openGallery(page)
  await expect(page.locator('#gallery-unreadable-banner')).toBeVisible()
  const reader = await readDeep(page, 3000)
  await expect.poll(() => page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem(key) || '{}')
    return Math.round(saved.resume?.scrollTop ?? 0)
  }, COMFORT_KEY)).toBeGreaterThan(2900)

  // The Gallery slides in by a few pixels for 160ms when it opens, and the
  // restore can land partway through. Held 3 px into that slide here, under
  // the restore's own 4 px landing tolerance so nothing corrects it later,
  // and let go once the restore is done.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.id = 'held-entrance-slide'
      style.textContent = '#view-gallery { animation: none !important; transform: translateY(3px) !important; }'
      document.head.appendChild(style)
    })
  })
  missing.holdNext()
  await page.reload()
  await expect(page.locator(`#gallery-grid .gallery-item[data-id="${reader.imageId}"]`)).toBeAttached()
  await expect.poll(() => page.evaluate(() => (window as any).GalleryComfort.isRestoring())).toBe(false)
  await page.evaluate(() => document.getElementById('held-entrance-slide')!.remove())
  await expectInPlace(page, reader)
})
