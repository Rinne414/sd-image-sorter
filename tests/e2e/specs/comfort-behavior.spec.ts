/**
 * Comfort BEHAVIOR pins — the mechanisms that make people come back.
 *
 * Why this file exists: three comfort features shipped looking implemented and
 * did nothing for their whole lifetime, and every existing pin passed the whole
 * time. The pins asserted DOM structure ("the ribbon element exists and is
 * dismissible", "the resume storage read/write contract works") while the actual
 * user-visible behavior — heart an image and see the count rise, scroll away and
 * come back to the same place — was broken.
 *
 * So: no test here asserts that an element exists or that a setter round-trips.
 * Each one drives the real interaction and asserts the OUTCOME, and each names
 * the specific regression it would have caught:
 *
 *   1. window.AppState does not exist (state lives on the sealed window.App), so
 *      every `window.AppState?.x` read in comfort.js was undefined -> restore
 *      could never fire and the save guard never engaged.        [fixed e1163c8]
 *   2. Because that guard was dead, launching the app saved scrollTop: 0 over the
 *      real position while the entry overlay was still up.       [fixed e1163c8]
 *   3. card-markup.js calls stopPropagation() on the heart, so comfort.js's
 *      #gallery-grid listener never counted a single favorite.   [fixed e47c6e9]
 *   4. switchView's scroll reset fires out to 700ms and one write is
 *      behavior:'smooth', whose glide dragged a restored position back to 0.
 *                                                                [fixed e1163c8]
 *
 * Desktop-only (project supports >=1280px). Cards are synthesized in-page via the
 * real Gallery.setImages path — the isolated e2e DB starts empty and seeding it
 * would pollute .tmp/e2e-data-<port> across runs.
 */
import { expect, test, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const COMFORT_KEY = 'sd-gallery-comfort-v1'
/** Below GALLERY_VIRTUAL_CONFIG.threshold (96) so real, non-virtual cards render. */
const CARD_COUNT = 60

async function bootGallery(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() =>
    typeof window.Gallery?.setImages === 'function'
    && document.documentElement.dataset.appReady === '1'
    && Boolean((window as any).GalleryComfort))
  // The entry overlay is skipped via init script, but boot may still be mid-flight.
  await page.waitForFunction(() => window.App?.AppState?.isLoading === false)
}

async function seedCards(page: Page, count = CARD_COUNT): Promise<void> {
  await page.evaluate((n) => {
    const imgs = Array.from({ length: n }, (_v, i) => ({
      id: 9001 + i,
      filename: `comfort-${9001 + i}.png`,
      generator: 'webui',
      width: 512,
      height: 512,
      file_size: 1000 + i,
    }))
    window.App.AppState.viewMode = 'grid'
    window.App.AppState.images = imgs
    window.App.AppState.currentView = 'gallery'
    window.Gallery.setImages(imgs)
  }, count)
  await expect
    .poll(() => page.locator('#gallery-grid .gallery-item[data-id]').count())
    .toBeGreaterThanOrEqual(count)
}

function readDay(page: Page) {
  return page.evaluate(() => (window as any).GalleryComfort._read().day)
}

test.describe('comfort behavior', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('aurora-entry-skip', '1')
      localStorage.removeItem('sd-gallery-comfort-v1')
    })
    await page.setViewportSize({ width: 1920, height: 1080 })
  })

  // --- Regression 1: the state accessor -----------------------------------
  test('comfort reads AppState from the sealed window.App facade, not window.AppState', async ({ page }) => {
    await bootGallery(page)
    const probe = await page.evaluate(() => ({
      // The trap: this global does NOT exist. Any module depending on it fails
      // silently because optional chaining swallows it.
      bareGlobalMissing: typeof (window as any).AppState === 'undefined',
      facadeHasState: Boolean(window.App?.AppState),
    }))
    expect(probe.bareGlobalMissing).toBe(true)
    expect(probe.facadeHasState).toBe(true)

    // Behavioral proof comfort resolves it: with cards present and the gallery
    // active, a deep scroll must be persisted (this needs AppState.images).
    await seedCards(page)
    await page.evaluate(() => window.scrollTo({ top: 1500, behavior: 'instant' }))
    await page.evaluate(() => (window as any).GalleryComfort.saveResumeNow())
    const saved = await page.evaluate(() =>
      (window as any).GalleryComfort._read().resume)
    expect(saved.scrollTop).toBeGreaterThanOrEqual(80)
    // imageCount proves AppState.images was reachable, not just the scroll offset.
    expect(saved.imageCount).toBe(CARD_COUNT)
  })

  // --- Regression 3: hearts were never counted ----------------------------
  test('clicking a card heart increments the daily count and renders the ribbon', async ({ page }) => {
    await bootGallery(page)
    await page.route('**/api/collections', (route) => route.fulfill({ json: { collections: [] } }))
    await page.route('**/api/collections/favorites', (route) => route.fulfill({ json: { favorited: true } }))
    await seedCards(page, 12)

    expect((await readDay(page)).favorites).toBe(0)

    // A REAL click on the heart. card-markup.js stops propagation here, which is
    // exactly why the old bubble-phase listener on #gallery-grid counted nothing.
    await page.locator('#gallery-grid .gallery-item[data-id]').first().hover()
    await page.locator('#gallery-grid .gallery-item[data-id] .gallery-item-fav').first().click()

    await expect.poll(async () => (await readDay(page)).favorites).toBe(1)
    const ribbon = page.locator('#gallery-comfort-ribbon')
    await expect(ribbon).toBeVisible()
    await expect(ribbon).toContainText('1')
  })

  // --- Regression 2: launch wiped the saved position -----------------------
  test('a zero-scroll save while the entry overlay is up cannot bury a real position', async ({ page }) => {
    await bootGallery(page)
    await seedCards(page)

    await page.evaluate(() => {
      const gc = (window as any).GalleryComfort
      const state = gc._read()
      state.resume = {
        scrollTop: 2600,
        scope: 'library',
        sortBy: 'newest',
        imageCount: 60,
        savedAt: Date.now(),
      }
      localStorage.setItem('sd-gallery-comfort-v1', JSON.stringify(state))
    })

    // Simulate relaunch: entry overlay covering the app, grid at the top.
    await page.evaluate(() => {
      const entry = document.getElementById('entry-page')
      if (entry) entry.hidden = false
      window.scrollTo({ top: 0, behavior: 'instant' })
      ;(window as any).GalleryComfort.saveResumeNow()
    })
    expect((await page.evaluate(() =>
      (window as any).GalleryComfort._read().resume.scrollTop))).toBe(2600)

    // Same protection with the overlay down: a top-of-list write is not a resume.
    await page.evaluate(() => {
      const entry = document.getElementById('entry-page')
      if (entry) entry.hidden = true
      window.scrollTo({ top: 0, behavior: 'instant' })
      ;(window as any).GalleryComfort.saveResumeNow()
    })
    expect((await page.evaluate(() =>
      (window as any).GalleryComfort._read().resume.scrollTop))).toBe(2600)
  })

  // --- Regression 4: the view-switch reset ladder stomped the restore ------
  test('a restored position survives the view-switch scroll reset ladder', async ({ page }) => {
    await bootGallery(page)
    await seedCards(page)

    const target = await page.evaluate(() => {
      const max = document.documentElement.scrollHeight - document.documentElement.clientHeight
      return Math.min(1500, Math.max(200, Math.round(max / 2)))
    })
    await page.evaluate((top) => {
      const gc = (window as any).GalleryComfort
      const state = gc._read()
      state.resume = {
        scrollTop: top,
        scope: String(window.App.AppState.filters?.scope || ''),
        sortBy: String(window.App.AppState.filters?.sortBy || ''),
        imageCount: 60,
        savedAt: Date.now(),
      }
      localStorage.setItem('sd-gallery-comfort-v1', JSON.stringify(state))
    }, target)

    // Restore, then immediately trigger the REAL reset ladder the way the app
    // does: switchView('gallery') calls scheduleViewScrollReset internally
    // (0/rAF/50/160/320/700ms, one of them a smooth scroll). Calling that
    // private function through `window` would silently miss — it is a local
    // binding in app/selection.js — and the test would pass against the bug.
    //
    // Assert STABILITY, not just the final offset: comfort.js re-asserts the
    // target for ~1100ms, so with the reset guard removed the view still ends
    // up in the right place but visibly lurches on the way (measured
    // 668 -> 657 -> 668 -> 72 -> 668). A user sees that jump, so a test that
    // only checked the last value would pass against the regression.
    const samples = await page.evaluate(async () => {
      const readTop = () =>
        Math.round(window.pageYOffset || document.documentElement.scrollTop || 0)
      const seen: number[] = []
      ;(window as any).GalleryComfort.restoreSoon()
      window.App.switchView('gallery')
      await new Promise<void>((resolve) => {
        const startedAt = Date.now()
        const id = setInterval(() => {
          seen.push(readTop())
          if (Date.now() - startedAt > 2000) {
            clearInterval(id)
            resolve()
          }
        }, 100)
      })
      return seen
    })

    const landed = samples[samples.length - 1]
    expect(Math.abs(landed - target)).toBeLessThanOrEqual(24)
    // Once the restore has taken (first sample within range), it must not be
    // yanked away again — no sample may collapse back toward the top.
    const firstOnTarget = samples.findIndex((top) => Math.abs(top - target) <= 24)
    expect(firstOnTarget).toBeGreaterThanOrEqual(0)
    const afterLanding = samples.slice(firstOnTarget)
    const worstDrift = Math.max(...afterLanding.map((top) => Math.abs(top - target)))
    expect(worstDrift, `scroll lurched after landing: ${JSON.stringify(samples)}`)
      .toBeLessThanOrEqual(48)

    // The suppression must not stick around and disable scroll-to-top forever.
    await expect
      .poll(async () => page.evaluate(() =>
        (window as any).GalleryComfort.isRestoring()), { timeout: 8000 })
      .toBe(false)
  })

  // --- The entry slab that advertises the above ----------------------------
  test('entry page offers a fresh browse position and declines a stale one', async ({ page }) => {
    // This test needs the real entry overlay, so it does NOT skip it. Seeding
    // happens per-navigation via addInitScript, so the age is read from a module
    // variable the second load overwrites — an init script that hard-coded a
    // fresh savedAt would silently re-seed on reload() and the stale assertion
    // would test nothing.
    await page.addInitScript(() => {
      localStorage.removeItem('aurora-entry-skip')
      const ageMs = Number(localStorage.getItem('e2e-resume-age-ms') || String(95 * 60 * 1000))
      localStorage.setItem('sd-gallery-comfort-v1', JSON.stringify({
        v: 1,
        resume: {
          scrollTop: 2400,
          scope: 'library',
          sortBy: 'newest',
          imageCount: 312,
          savedAt: Date.now() - ageMs,
        },
        dayKey: '',
        day: { favorites: 0, selectsPeak: 0, loads: 0 },
        lastResumeToastAt: 0,
      }))
    })
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const slab = page.locator('#entry-resume')
    await expect(slab).toBeVisible()
    await expect(page.locator('#entry-resume-when')).not.toHaveText('')
    await expect(page.locator('#entry-resume-detail')).toContainText('312')
    // The WASD sort slab is a separate concern and stays hidden without a session.
    await expect(page.locator('#entry-anchor')).toBeHidden()

    // Aged past the 14-day window comfort.js honors -> no offer.
    await page.evaluate(() => {
      localStorage.setItem('e2e-resume-age-ms', String(20 * 24 * 60 * 60 * 1000))
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#entry-resume')).toBeHidden()
  })
})
