import { expect, test, type Page, type Route } from '../fixtures/click-ledger'
import { StyleMapPage } from '../pages/StyleMapPage'

/**
 * Style Map (画风地图, slice S3) — page smoke against mocked /api/style-map/*.
 * The E2E library has no style vectors and no Kaloscope, so the API answers
 * are scripted here; what is under test is the page: entrances, the empty
 * state, the index job flow, the UMAP status line and its polling cadence,
 * the install hint, hover-only thumbnails and the filter debounce.
 */

const UMAP_PARAMS = { n_neighbors: 15, min_dist: 0.1, metric: 'cosine', input_dim: 64, random_state: 0 }

function pointsBody(overrides: Record<string, unknown> = {}) {
  const points = Array.from({ length: 30 }, (_, i) => [i + 1, (i % 5) / 4 - 0.5, (i % 7) / 6 - 0.5, (i % 3) / 2 - 0.5, i === 2 ? 3 : 1])
  return {
    status: 'ok',
    space: 'kaloscope',
    method: 'pca',
    model_version: 'kaloscope:test',
    total_images: 33,
    missing_vectors: 3,
    unlocatable: [99],
    merged_away: 2,
    explained_variance: [0.05, 0.04, 0.03],
    points_layout: ['id', 'x', 'y', 'z', 'members'],
    points,
    umap: { status: 'unavailable', points: 30, min_points: 21, params: UMAP_PARAMS, install: { model_id: 'style-map-umap', packages: ['umap-learn>=0.5.12'] } },
    cached: false,
    ...overrides,
  }
}

async function mockSelectionToken(page: Page) {
  await page.route('**/api/images/selection-token', (route) =>
    route.fulfill({ json: { selection_token: 'tok.e2e', total_estimate: 33 } }))
}

async function mockProgressIdle(page: Page) {
  await page.route('**/api/style-map/vectors/progress', (route) =>
    route.fulfill({ json: { running: false, paused: false, total: 0, processed: 0, written: 0, kept: 0, errors: 0, step: 'idle', message: '', recent_issues: [] } }))
}

test.describe('Style Map', () => {
  test('is reachable through its tab or the More mirror, and the catalog lists it', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody() }))
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    await expect(page.locator('#view-gallery')).toBeVisible()
    const map = new StyleMapPage(page)
    // Direct tab where the bar fits, More mirror otherwise (the ladder is
    // width- and language-driven, so the page object picks the entrance).
    await map.open()
    await expect(map.view).toHaveClass(/active/)
    await expect(map.tab).toHaveAttribute('aria-selected', 'true')
    // The mirror must never carry data-view (Playwright strict-mode contract).
    await expect(map.mirror).toHaveAttribute('data-mirror-view', 'stylemap')
    expect(await map.mirror.getAttribute('data-view')).toBeNull()
    // One direct tab only (the nav bar itself mirrors the active view name).
    await expect(page.locator('.nav-tab[data-view="stylemap"]')).toHaveCount(1)

    // Narrow + English (the tightest bar): the sixth default tab still fits
    // and no tab is tucked; the mirror stays hidden.
    await page.evaluate(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.reload()
    await expect(page.locator('#view-gallery')).toBeVisible()
    await expect(map.tab).toBeVisible()
    await expect(map.mirror).toBeHidden()
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('.nav-tabs > .nav-tab[data-view]')]
        .filter((tab) => (tab as HTMLElement).offsetParent !== null)
        .map((tab) => (tab as HTMLElement).dataset.view))
    expect(shown).toEqual(['gallery', 'reader', 'sorting', 'censor', 'similar', 'stylemap'])

    // Unticked in the customize checklist: the More mirror becomes the entrance.
    await page.evaluate(() => localStorage.setItem('aurora-nav-tabs', JSON.stringify(['gallery', 'reader', 'sorting', 'censor', 'similar'])))
    await page.reload()
    await expect(page.locator('#view-gallery')).toBeVisible()
    await expect(map.tab).toBeHidden()
    await page.click('#nav-tools-toggle')
    await expect(map.mirror).toBeVisible()
    await map.mirror.click()
    await expect(map.view).toHaveClass(/active/)
  })

  test('renders the map, the scope line and the install hint when UMAP is missing', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    const pointsRequests: string[] = []
    await page.route('**/api/style-map/points**', (route) => {
      pointsRequests.push(route.request().url())
      return route.fulfill({ json: pointsBody() })
    })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    expect(pointsRequests[0]).toContain('selection_token=tok.e2e')
    expect(pointsRequests[0]).toContain('space=kaloscope')
    await expect(map.scope).toContainText('33')
    await expect(map.scope).toContainText('3')
    await expect(map.scope).toContainText('1')
    await expect(map.layoutStatus).toHaveAttribute('data-status', 'unavailable')
    await expect(map.installButton).toBeVisible()
    await expect(map.emptyCard).toBeHidden()
    await expect(map.buildButton).toBeVisible()
    // The CSD space is announced but not offered.
    await expect(map.spaceSelect.locator('option[value="csd"]')).toHaveAttribute('disabled', '')

    // Install goes through the app's first-use model flow for the umap card.
    const prepared: unknown[] = []
    await page.route('**/api/models/status', async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      body.models = (body.models ?? []).map((card: any) => (
        card.id === 'style-map-umap' ? { ...card, status: 'missing', available: false } : card))
      await route.fulfill({ response, json: body })
    })
    await page.route('**/api/models/plan**', (route) => route.fulfill({ json: { group: 'umap', packages: ['umap-learn==0.5.12'], restart_likely: false } }))
    await page.route('**/api/models/prepare', (route) => {
      prepared.push(route.request().postDataJSON())
      return route.fulfill({ json: { status: 'ok', model_id: 'style-map-umap', message: 'ready', paths: {} } })
    })
    await map.installButton.click()
    await expect.poll(() => prepared.length).toBe(1)
    expect((prepared[0] as any).model_id).toBe('style-map-umap')
  })

  test('shows the start card with one primary and runs the index job to a Done state', async ({ page }) => {
    await mockSelectionToken(page)
    let progressCalls = 0
    const starts: unknown[] = []
    await page.route('**/api/style-map/vectors/progress', (route) => {
      progressCalls += 1
      const running = starts.length > 0 && progressCalls < 6
      return route.fulfill({ json: {
        running,
        paused: false,
        total: starts.length ? 30 : 0,
        processed: running ? Math.min(30, progressCalls * 6) : 30,
        written: running ? Math.min(30, progressCalls * 6) : 30,
        kept: 0,
        errors: 0,
        step: running ? 'extracting' : 'done',
        message: '',
        recent_issues: [],
      } })
    })
    await page.route('**/api/style-map/vectors/start', (route) => {
      starts.push(route.request().postDataJSON())
      return route.fulfill({ json: { status: 'started', total: 30, space: 'kaloscope' } })
    })
    await page.route('**/api/style-map/points**', (route) => {
      const done = starts.length > 0 && progressCalls >= 6
      return route.fulfill({ json: done
        ? pointsBody({ missing_vectors: 0 })
        : pointsBody({ status: 'no_vectors', points: [], missing_vectors: 33, unlocatable: [], umap: { status: 'too_few_points', points: 0, min_points: 21, params: UMAP_PARAMS } }) })
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect(map.emptyCard).toBeVisible()
    await expect(map.emptyBuildButton).toBeVisible()
    // One solid primary per screen: the toolbar's build button steps aside.
    await expect(map.buildButton).toBeHidden()
    await expect(page.locator('#view-stylemap .btn-primary:visible')).toHaveCount(1)

    await map.emptyBuildButton.click()
    await expect.poll(() => starts.length).toBe(1)
    expect((starts[0] as any).selection_token).toBe('tok.e2e')
    expect((starts[0] as any).space).toBe('kaloscope')
    await expect(map.progressRow).toBeVisible()
    await expect(map.progressText).toContainText('/ 30')
    await expect(map.progressRow).toHaveAttribute('data-state', 'done', { timeout: 15000 })
    await expect(map.progressText).toContainText('30')
    await expect(page.locator('.toast')).toContainText(/Done|完成/)
    await expect.poll(() => map.pointCount(), { timeout: 10000 }).toBe(30)
    await expect(map.emptyCard).toBeHidden()
  })

  test('polls layout-status about every 3 s, reloads points when UMAP is ready, and calls points on not_started', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    const pointsTimes: number[] = []
    const statusTimes: number[] = []
    let statusReply: string = 'computing'
    await page.route('**/api/style-map/layout-status**', (route) => {
      statusTimes.push(Date.now())
      return route.fulfill({ json: { space: 'kaloscope', method: statusReply === 'ready' ? 'umap' : 'pca', umap: { status: statusReply, points: 30, min_points: 21, params: UMAP_PARAMS } } })
    })
    await page.route('**/api/style-map/points**', (route) => {
      pointsTimes.push(Date.now())
      const ready = statusReply === 'ready'
      return route.fulfill({ json: pointsBody({
        method: ready ? 'umap' : 'pca',
        umap: ready
          ? { status: 'ready', points: 30, min_points: 21, params: UMAP_PARAMS, source: 'memory', elapsed_s: 4.2 }
          : { status: 'computing', points: 30, min_points: 21, params: UMAP_PARAMS, queued_at: 1 },
      }) })
    })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect(map.layoutStatus).toHaveAttribute('data-status', 'computing')
    await expect.poll(() => statusTimes.length, { timeout: 8000 }).toBe(2)
    expect(statusTimes[1] - statusTimes[0]).toBeGreaterThanOrEqual(2500)
    expect(pointsTimes.length).toBe(1)

    // The server forgot this map's inputs (not_started): the poller itself
    // must ask for points again, which re-queues the layout (computing).
    statusReply = 'not_started'
    await expect.poll(() => pointsTimes.length, { timeout: 8000 }).toBe(2)
    statusReply = 'computing'
    await expect(map.layoutStatus).toHaveAttribute('data-status', 'computing')

    statusReply = 'ready'
    await expect.poll(() => pointsTimes.length, { timeout: 8000 }).toBe(3)
    await expect(map.layoutStatus).toHaveAttribute('data-status', 'ready')
    await expect(map.layoutText).toContainText('UMAP')
    const polls = statusTimes.length
    await page.waitForTimeout(3500)
    expect(statusTimes.length).toBe(polls) // ready: no more polling
  })

  test('loads a thumbnail only on hover and debounces filter changes into one points request', async ({ page }) => {
    let tokenCalls = 0
    await page.route('**/api/images/selection-token', (route) => {
      tokenCalls += 1
      return route.fulfill({ json: { selection_token: 'tok.e2e', total_estimate: 33 } })
    })
    await mockProgressIdle(page)
    let pointsCalls = 0
    await page.route('**/api/style-map/points**', (route) => {
      pointsCalls += 1
      return route.fulfill({ json: pointsBody() })
    })
    // Only the map's own thumbnails (size=512) count, from page load on; the
    // Gallery grid's smaller thumbnails are its business.
    let thumbnailCalls = 0
    await page.route('**/api/image-thumbnail/**', (route) => {
      if (route.request().url().includes('size=512')) thumbnailCalls += 1
      return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') })
    })
    await page.route('**/api/images/7', (route) => route.fulfill({ json: { image: { id: 7, filename: 'seven.png' } } }))
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    await expect(map.previewHint).toBeVisible()
    await page.waitForTimeout(500)
    expect(thumbnailCalls).toBe(0)

    // Hover is a raycast against WebGL points; drive the scene's hover hook directly.
    await page.evaluate(() => (window as any).StyleMap._state.scene.onHover({ id: 7, members: 3 }))
    await expect(map.previewImage).toBeVisible()
    await expect(map.previewImage).toHaveAttribute('src', /\/api\/image-thumbnail\/7\?size=512/)
    await expect(page.locator('#stylemap-preview-name')).toHaveText('seven.png')
    await expect(page.locator('#stylemap-preview-members')).toContainText('3')
    await expect.poll(() => thumbnailCalls).toBe(1)
    await page.evaluate(() => (window as any).StyleMap._state.scene.onHover(null))
    await expect(map.previewHint).toBeVisible()

    // Four filter events inside the debounce window cost ONE token request
    // and one points request (a refresh that starts always posts a token).
    const beforePoints = pointsCalls
    const beforeTokens = tokenCalls
    await page.evaluate(() => {
      for (let i = 0; i < 4; i += 1) window.dispatchEvent(new CustomEvent('gallery-filters-changed'))
    })
    await page.waitForTimeout(900)
    expect(tokenCalls).toBe(beforeTokens + 1)
    expect(pointsCalls).toBe(beforePoints + 1)
  })

  test('loads under a random Gallery order by asking for a fixed order token', async ({ page }) => {
    await mockProgressIdle(page)
    const tokenBodies: Array<Record<string, unknown>> = []
    await page.route('**/api/images/selection-token', (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      tokenBodies.push(body)
      if (body.sortBy === 'random') {
        return route.fulfill({ status: 400, json: { detail: 'Random sort cannot be used for a selection token' } })
      }
      return route.fulfill({ json: { selection_token: 'tok.e2e', total_estimate: 33 } })
    })
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody() }))
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    await expect(page.locator('#view-gallery')).toBeVisible()
    await page.evaluate(() => { (window as any).App.AppState.filters.sortBy = 'random' })
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    expect(tokenBodies.length).toBeGreaterThan(0)
    expect(tokenBodies.every((body) => body.sortBy === 'newest')).toBe(true)
    await expect(page.locator('#stylemap-error')).toBeHidden()
  })

  test('stops polling the index job after leaving the page, even mid-flight', async ({ page }) => {
    await mockSelectionToken(page)
    let progressCalls = 0
    await page.route('**/api/style-map/vectors/progress', async (route) => {
      progressCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 1200)) // a slow answer straddles the leave
      await route.fulfill({ json: { running: true, paused: false, total: 30, processed: 5, written: 5, kept: 0, errors: 0, step: 'extracting', message: '', recent_issues: [] } })
    })
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody() }))
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    // The first poll is in flight for 1.2 s; leave right after it started.
    await expect.poll(() => progressCalls, { timeout: 8000, intervals: [50] }).toBeGreaterThanOrEqual(1)
    await page.evaluate(() => (window as any).switchView('gallery'))
    await page.waitForTimeout(300)
    const afterLeave = progressCalls
    // The in-flight answer arrives at ~1.2 s; a rescheduled poll would follow
    // one second later, well inside this window.
    await page.waitForTimeout(3200)
    expect(progressCalls).toBe(afterLeave)
  })
})
