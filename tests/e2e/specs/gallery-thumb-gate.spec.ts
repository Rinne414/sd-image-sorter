import { expect, test, type Page } from '@playwright/test'

/**
 * A fast flick through a large library asked the server for the thumbnail of
 * every card it passed (286 to 758 requests in a 3 s flick at 100,000
 * pictures, none cancelled), and the cards left on screen waited behind them:
 * 9.7 s of blank tiles with real 960x1440 pictures. Cards rendered mid-flick
 * now wait until the gallery settles, the nearest load first, and cards that
 * leave the page cancel a thumbnail that has not arrived (measured after: about
 * 1.1 s, nothing passed by is generated for nothing).
 */

test.use({ viewport: { width: 1920, height: 1080 } })

test('the gate defers a flick, waits for a real stop, and loads the nearest cards first', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).GalleryThumbGate)).toBe('object')
  const result = await page.evaluate(() => {
    const loaded: string[] = []
    const flushes: string[] = []
    let clock = 0
    let top = 0
    let nextId = 1
    const timers = new Map<number, { fn: () => void, at: number }>()
    const gate = (window as any).GalleryThumbGate.create({
      getScrollTop: () => top,
      load: (item: HTMLElement) => loaded.push(item.id),
      now: () => clock,
      setTimer: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id },
      clearTimer: (id: number) => timers.delete(id),
      onFlush: (reason: string) => flushes.push(reason),
    })
    const runDue = () => {
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) { timers.delete(id); timer.fn() }
      }
    }
    const card = (id: string, y: number) => {
      const element = document.createElement('div')
      element.id = id
      element.style.cssText = `position:fixed;left:0;top:${y}px;width:10px;height:10px`
      document.body.appendChild(element)
      return element
    }
    const step = (ms: number, px: number) => { clock += ms; top += px; gate.noteScroll() }

    step(0, 0)
    step(2000, 50000) // one jump after a pause: a scrollbar click, End
    const deferAfterJump = gate.shouldDefer()
    step(100, 100) // 1 px/ms: reading
    const deferWhileReading = gate.shouldDefer()
    step(16, 600) // 37 px/ms: a flick
    const deferWhileFlinging = gate.shouldDefer()

    const far = card('far', 5)
    const near = card('near', innerHeight / 2)
    const gone = card('gone', 20)
    gate.defer(far)
    gate.defer(near)
    gate.defer(gone)
    gone.remove()

    // The settle timer fires while the page moved on without a scroll event yet.
    clock += 120
    top += 300
    runDue()
    const loadedDuringBusyFrame = loaded.length

    step(20, 0) // the late event arrives, then nothing more
    clock += 120
    runDue()
    const result = { deferAfterJump, deferWhileReading, deferWhileFlinging, loadedDuringBusyFrame, loaded: [...loaded], flushes: [...flushes] }
    far.remove()
    near.remove()
    return result
  })
  expect(result).toEqual({
    deferAfterJump: false,
    deferWhileReading: false,
    deferWhileFlinging: true,
    loadedDuringBusyFrame: 0,
    loaded: ['near', 'far'],
    flushes: ['settled'],
  })
})

test('a fling that slows to a reading pace shows its cards while still moving', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).GalleryThumbGate)).toBe('object')
  const result = await page.evaluate(() => {
    const flushes: string[] = []
    let clock = 0
    let top = 0
    const gate = (window as any).GalleryThumbGate.create({
      getScrollTop: () => top,
      load: () => {},
      now: () => clock,
      setTimer: () => 0,
      clearTimer: () => {},
      onFlush: (reason: string) => flushes.push(reason),
    })
    const element = document.createElement('div')
    document.body.appendChild(element)
    const step = (ms: number, px: number) => { clock += ms; top += px; gate.noteScroll() }
    step(0, 0)
    step(16, 600)
    gate.defer(element)
    for (let i = 0; i < 12; i += 1) step(16, 16) // 1 px/ms for 192 ms
    element.remove()
    return { flushes, deferAfter: gate.shouldDefer() }
  })
  expect(result).toEqual({ flushes: ['slowed'], deferAfter: false })
})

async function mockLargeGallery(page: Page, count: number, thumbnailDelayMs: number) {
  // The full summary the gallery reads.
  const images = Array.from({ length: count }, (_, index) => ({
    id: 70001 + index,
    filename: `flick-${index}.png`,
    path: `/mock/flick-${index}.png`,
    generator: 'webui',
    width: 512,
    height: 512,
    file_size: 1000,
    checkpoint: null,
    checkpoint_normalized: null,
    loras: null,
    user_rating: null,
    aesthetic_score: null,
    is_readable: 1,
    metadata_status: 'complete',
    created_at: '2026-11-08T00:00:00',
    library_order_time: '2026-11-08T00:00:00',
  }))
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#468"/></svg>'
  await page.route(/\/api\/image-thumbnail\/\d+/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, thumbnailDelayMs))
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }).catch(() => {})
  })
  await page.route('**/api/images**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/images') return route.fallback()
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } })
  })
}

// 6x: a slow machine (GitHub's runners), where frames come further apart than
// the gate's settle time while the flick goes on (CI run 43181606281).
for (const cpuSlowdown of [1, 6]) {
test(`a fast flick asks for few thumbnails, cancels the ones it passed, and fills the screen when it stops (cpu x${cpuSlowdown})`, async ({ page }) => {
  if (cpuSlowdown > 1) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown })
  }
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('aurora-entry-skip', '1')
  })
  await mockLargeGallery(page, 1200, 400)
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item[data-id]').first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => Boolean((window as any).Gallery.useVirtualScroll))).toBe(true)
  await page.waitForTimeout(1500)

  let duringFlick = 0
  let cancelled = 0
  let flinging = true
  page.on('request', (request) => { if (flinging && /\/api\/image-thumbnail\//.test(request.url())) duringFlick += 1 })
  page.on('requestfailed', (request) => { if (/\/api\/image-thumbnail\//.test(request.url())) cancelled += 1 })
  const rendered = await page.evaluate(() => {
    (window as any).__rendered = 0
    const original = (window as any).Gallery.createVirtualGalleryItem.bind((window as any).Gallery)
    ;(window as any).Gallery.createVirtualGalleryItem = (...args: unknown[]) => { (window as any).__rendered += 1; return original(...args) }
    return 0
  })
  expect(rendered).toBe(0)

  const grid = await page.locator('#gallery-grid').boundingBox()
  await page.mouse.move(grid!.x + grid!.width / 2, 540)
  // One step at a reading pace first: its cards ask for their pictures (each
  // takes 400 ms here), and the flick then carries them off the screen.
  await page.mouse.wheel(0, 900)
  // The flick is the browser's own scroll gesture, 12 px/ms for two seconds.
  // Forty wheel steps sent from here took about 110 ms each on a busy machine
  // (2026-11-12), so the gallery really did stop between them and loaded its
  // pictures, as it should: that measured this machine, not the gallery.
  const browser = await page.context().newCDPSession(page)
  await browser.send('Input.synthesizeScrollGesture', {
    x: Math.round(grid!.x + grid!.width / 2),
    y: 540,
    yDistance: -24000,
    speed: 12000,
    gestureSourceType: 'mouse',
  })
  flinging = false
  const cardsRendered = await page.evaluate(() => (window as any).__rendered)

  // Far fewer thumbnails than cards the flick drew (most cards were never seen).
  expect(cardsRendered).toBeGreaterThan(150)
  expect(duringFlick).toBeLessThan(cardsRendered / 3)

  // Every card on screen gets its picture once the gallery settles.
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#gallery-grid .gallery-item[data-id]')]
    .filter((card) => { const rect = card.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight })
    .filter((card) => {
      const img = card.querySelector('img') as HTMLImageElement | null
      return !img || img.dataset.src || (img.getAttribute('src') || '').startsWith('data:') || !img.complete || img.naturalWidth === 0
    }).length), { timeout: 15000 }).toBe(0)
  // The few cards drawn before the flick was recognised scrolled away while
  // their thumbnails were still on the way: those requests were cancelled.
  expect(cancelled).toBeGreaterThan(0)
})
}
