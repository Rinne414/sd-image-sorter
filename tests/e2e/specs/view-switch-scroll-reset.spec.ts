import { expect, test, type Page } from '@playwright/test'

/**
 * A view opens at its top. The reset in switchView() used to be an animated
 * scroll (html has scroll-behavior: smooth), so the new view slid up from
 * wherever the old one had been scrolled, and the reset ladder read that
 * slide as the user scrolling and cancelled itself, which left an interrupted
 * slide stranded partway down the page.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

/** scheduleViewScrollReset() fires out to 700ms; sample a little past it. */
const RESET_LADDER_SPAN_MS = 850
/** The ladder's last step; a user scroll before it must still win. */
const RESET_LADDER_LAST_STEP_MS = 700

async function mockLongGallery(page: Page, count = 60) {
  const images = Array.from({ length: count }, (_, index) => ({
    id: 501 + index,
    filename: `view-reset-${index + 1}.png`,
    path: `/mock/view-reset-${index + 1}.png`,
    prompt: `mock prompt ${index + 1}`,
  }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/images') {
      await route.continue()
      return
    }
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } })
  })
  // The missing-files banner lands above the toolbar ~1.5 s after load when the
  // shared e2e library has missing files, and pushes the grid down 58 px.
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
}

test('a view switched to from a deep Gallery opens at its top, not sliding up to it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await mockLongGallery(page)
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()

  // Deep, instantly: the gallery must be scrolled further than the Sort view is tall.
  await expect.poll(async () => page.evaluate(() => {
    window.scrollTo({ top: 3000, behavior: 'instant' })
    return Math.round(window.scrollY)
  })).toBeGreaterThan(1000)

  // From the switch until the reset ladder's last step (700ms) has passed,
  // sample the offset every frame: it is at the top by the second frame and
  // never leaves it.
  const samples = await page.evaluate((spanMs) => new Promise<number[]>((resolve) => {
    const seen: number[] = []
    const startedAt = performance.now()
    ;(window as any).switchView('sorting')
    const timer = setInterval(() => {
      seen.push(Math.round(window.scrollY))
      if (performance.now() - startedAt > spanMs) {
        clearInterval(timer)
        resolve(seen)
      }
    }, 16)
  }), RESET_LADDER_SPAN_MS)
  expect(samples.length).toBeGreaterThan(10)
  expect(Math.max(...samples)).toBe(0)
})

test('switching the view mode puts the reader straight on their image, without sliding there', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await mockLongGallery(page)
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()

  await expect.poll(async () => page.evaluate(() => {
    window.scrollTo({ top: 1500, behavior: 'instant' })
    return Math.round(window.scrollY)
  })).toBeGreaterThan(1000)

  // Wrap the anchor restore: once it has applied, look two frames later at where
  // the reader's image sits, then watch the offset for the rest of the window.
  // The reference is the anchor the click itself captured (the image on screen
  // when the button was pressed), not one read before the click: anything that
  // moves the page in between - a gallery reload clamps a deep page, a status
  // chip grows the toolbar - would make an earlier reading name another image.
  await page.evaluate((watchMs) => {
    const gallery = (window as any).Gallery
    // Where the grid starts on the page, and what can push it down after load.
    const layout = () => ({
      y: Math.round(window.scrollY),
      gridTop: Math.round(document.getElementById('gallery-grid')!.getBoundingClientRect().top + window.scrollY),
      chip: !(document.getElementById('metadata-status-chip') as HTMLElement).hidden,
    })
    const state: { anchor: any, done: boolean, offsetAfterTwoFrames: number | null, ys: number[], trace: any[] } = {
      anchor: null, done: false, offsetAfterTwoFrames: null, ys: [], trace: [],
    }
    state.trace.push({ at: 'before-click', ...layout() })
    ;(window as any).__anchorRestore = state
    const original = gallery._restoreViewAnchor.bind(gallery)
    gallery._restoreViewAnchor = (anchor: any) => {
      const applied = original(anchor)
      // Only the click's restore counts: a reload before the click restores too,
      // but the grid is not yet in the large view then.
      const isClickRestore = document.getElementById('gallery-grid')!.classList.contains('large')
      if (applied && isClickRestore && !state.anchor) {
        state.anchor = anchor
        state.trace.push({ at: 'restore', ...layout() })
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const item = document.querySelector(`#gallery-grid .gallery-item[data-id="${anchor.imageId}"]`)
          state.offsetAfterTwoFrames = item ? Math.round(item.getBoundingClientRect().top) : null
          state.trace.push({ at: 'two-frames', ...layout() })
          const startedAt = performance.now()
          const timer = setInterval(() => {
            state.ys.push(Math.round(window.scrollY))
            if (performance.now() - startedAt > watchMs) {
              clearInterval(timer)
              state.done = true
            }
          }, 16)
        }))
      }
      return applied
    }
  }, 400)

  const box = await page.locator('.view-btn[data-size="large"]').boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await expect.poll(async () => page.evaluate(() => (window as any).__anchorRestore.done)).toBe(true)

  const result = await page.evaluate(() => (window as any).__anchorRestore)
  const trace = JSON.stringify({ anchor: result.anchor, offsetAfterTwoFrames: result.offsetAfterTwoFrames, trace: result.trace })
  // Already where the reader left it (within a few px), not still travelling.
  expect(result.offsetAfterTwoFrames, trace).not.toBeNull()
  expect(Math.abs(result.offsetAfterTwoFrames - Math.round(result.anchor.offset)), trace).toBeLessThanOrEqual(4)
  // And nothing moves the page afterwards.
  expect(new Set(result.ys).size, trace).toBe(1)
})

test('a user scroll after the new view has settled at the top is left alone', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await mockLongGallery(page)
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()

  await expect.poll(async () => page.evaluate(() => {
    window.scrollTo({ top: 3000, behavior: 'instant' })
    return Math.round(window.scrollY)
  })).toBeGreaterThan(1000)

  await page.evaluate(() => {
    ;(window as any).__switchedAt = performance.now()
    ;(window as any).switchView('sorting')
  })
  // The ladder settles at its first animation-frame step that finds the page at
  // the top. Two frames queued after the switch run after that step, so by then
  // it has settled; its last step (700ms) is still ahead, so the user scrolls
  // inside the ladder.
  const settledAt = await page.evaluate(() => new Promise<{ top: number, elapsed: number }>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      top: Math.round(window.scrollY),
      elapsed: performance.now() - (window as any).__switchedAt,
    })))
  }))
  expect(settledAt.top).toBe(0)
  expect(settledAt.elapsed).toBeLessThan(RESET_LADDER_LAST_STEP_MS)

  await page.mouse.move(683, 400)
  await page.mouse.wheel(0, 40)
  // Wait until the wheel has landed and holds across two frames, and check it
  // landed while the ladder was still running: a scroll after its last step
  // would prove nothing about the ladder.
  let landed = { y: -1, elapsed: Number.POSITIVE_INFINITY }
  await expect.poll(async () => {
    landed = await page.evaluate(() => new Promise<{ y: number, elapsed: number }>((resolve) => {
      const before = Math.round(window.scrollY)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const after = Math.round(window.scrollY)
        resolve({ y: after === before ? after : -1, elapsed: performance.now() - (window as any).__switchedAt })
      }))
    }))
    return landed.y
  }).toBeGreaterThan(4)
  expect(landed.elapsed).toBeLessThan(RESET_LADDER_LAST_STEP_MS)

  // Past the ladder's last step the page is still where the user put it.
  await expect.poll(async () => page.evaluate((span) => ({
    pastLadder: performance.now() - (window as any).__switchedAt > span,
    y: Math.round(window.scrollY),
  }), RESET_LADDER_SPAN_MS)).toEqual({ pastLadder: true, y: landed.y })
})
