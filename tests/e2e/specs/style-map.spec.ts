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
    map_id: 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0',
    cached: false,
    ...overrides,
  }
}

/** Three regions: labels + artist, nothing to say, artist only (S3b.2 landmarks). */
function regionsBody(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    space: 'kaloscope',
    method: 'pca',
    model_version: 'kaloscope:test',
    k: 3,
    seed: 0,
    algo_version: 1,
    regions: [
      { id: 0, center: [-0.4, 0.2, 0.1], size: 12, members_total: 14, representatives: [9003, 9008], tagged: 12,
        tags: [{ tag: 'monochrome', count: 6, tagged: 12, rate: 0.5, ratio: 4.1, p: 0.0002, q: 0.001 }],
        artists: [{ artist: 'modare', count: 5, high_total: 6, share: 0.833 }] },
      { id: 1, center: [0.3, -0.3, 0.2], size: 10, members_total: 10, representatives: [9012], tagged: 0, tags: [], artists: [] },
      { id: 2, center: [0.1, 0.4, -0.3], size: 8, members_total: 8, representatives: [9020, 9025], tagged: 8, tags: [],
        artists: [{ artist: 'meion', count: 3, high_total: 4, share: 0.75 }] },
    ],
    cached: false,
    ...overrides,
  }
}

/**
 * Colours (S4a) of the 30 mock points: `categories` generators in turn, the
 * last point (id 30) without data; scores 3..8 with id 30 unscored.
 */
function colorsBody(by: string, { categories = 5, ids = Array.from({ length: 30 }, (_, i) => i + 1), missing = true } = {}) {
  const missingId = missing ? ids[ids.length - 1] : -1
  if (by.startsWith('aesthetic')) {
    const values = ids.map((id, i) => (id === missingId ? null : 3 + (5 * i) / Math.max(1, ids.length - 2)))
    const present = values.filter((v): v is number => v !== null)
    return { status: 'ok', space: 'kaloscope', model_version: 'kaloscope:test', by, kind: 'scale', ids, values, legend: [], range: [Math.min(...present), Math.max(...present)], missing: values.length - present.length }
  }
  const names = Array.from({ length: categories }, (_, i) => (by === 'folder' ? `L:/pics/set ${String.fromCharCode(65 + i)}` : `gen${i}`))
  const counts = new Array(categories).fill(0)
  const values = ids.map((id, i) => {
    if (id === missingId) return null
    const slot = i % categories
    counts[slot] += 1
    return slot
  })
  const legend = names.map((name, i) => ({ key: name, label: by === 'folder' ? name.split('/').pop() : name, count: counts[i] }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  const order = new Map(legend.map((entry, i) => [names.indexOf(entry.key), i]))
  return { status: 'ok', space: 'kaloscope', model_version: 'kaloscope:test', by, kind: 'category', ids, values: values.map((v) => (v === null ? null : order.get(v))), legend, range: null, missing: values.filter((v) => v === null).length }
}

const NO_DATA_RGB = [0x5a / 255, 0x5a / 255, 0x60 / 255]
const FIRST_CATEGORY_RGB = [0xd8 / 255, 0x52 / 255, 0x4b / 255]
const RAMP_START_RGB = [0x44 / 255, 0x39 / 255, 0x83 / 255]

function expectRgb(actual: number[], expected: number[]) {
  for (let i = 0; i < 3; i += 1) expect(actual[i]).toBeCloseTo(expected[i], 3)
}

async function mockColors(page: Page, onRequest: (url: URL) => void = () => {}, options: { categories?: number; missing?: boolean } = {}) {
  await page.route('**/api/style-map/colors**', (route) => {
    const url = new URL(route.request().url())
    onRequest(url)
    return route.fulfill({ json: colorsBody(url.searchParams.get('by') || 'generator', options) })
  })
}

/**
 * Every visible chip of the legend sits on one line inside the row (no wrap,
 * no overflow), and when chips are folded the row holds as many as fit: one
 * more chip (plus the gap and the button) would not fit (rule 18).
 */
async function legendRowCheck(map: StyleMapPage) {
  return map.page.evaluate(() => {
    const host = document.querySelector('#stylemap-legend') as HTMLElement
    const all = [...host.querySelectorAll(':scope > .stylemap-legend-chip')] as HTMLElement[]
    const button = host.querySelector(':scope > .stylemap-legend-more') as HTMLElement | null
    const visible = all.filter((el) => !el.hidden)
    const rects = [...visible, ...(button ? [button] : [])].map((el) => el.getBoundingClientRect())
    const row = host.getBoundingClientRect()
    const tops = new Set(rects.map((r) => Math.round(r.top)))
    // Width the row would need with one more chip shown (measured unhidden,
    // then restored) beside the button at its widest ("Fewer", the open state).
    let maximal = true
    if (button && visible.length < all.length) {
      const gap = 6
      const next = all[visible.length]
      next.hidden = false
      const widths = [...visible, next].map((el) => el.offsetWidth)
      next.hidden = true
      const label = button.textContent
      button.textContent = (window as any).appT('stylemap.legendLess', 'Fewer')
      const room = Math.max(button.offsetWidth, 48)
      button.textContent = label
      const needed = widths.reduce((sum, w, i) => sum + w + (i ? gap : 0), 0) + gap + room
      maximal = needed > host.clientWidth
    }
    return {
      chips: rects.length,
      oneRow: tops.size <= 1,
      inside: rects.every((r) => r.left >= row.left - 0.5 && r.right <= row.right + 0.5),
      overflow: host.scrollWidth > host.clientWidth + 1,
      maximal,
      toolbarWraps: (document.querySelector('.stylemap-toolbar') as HTMLElement).getBoundingClientRect().height > 48,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    }
  })
}

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

async function mockThumbnails(page: Page, onRequest: (url: string) => void = () => {}) {
  await page.route('**/api/image-thumbnail/**', (route) => {
    onRequest(route.request().url())
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX })
  })
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
    // The CSD space is offered (S5): enabled, with its own name.
    await expect(map.spaceSelect.locator('option[value="csd"]')).toBeEnabled()
    await expect(map.spaceSelect.locator('option[value="csd"]')).toContainText(/CSD/)

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
    // Regions and colours are answered (a not_started from the real server
    // would arm a rebuild and add points calls this test counts).
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    await mockColors(page)
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
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    await mockColors(page)
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

  test('reads the map and builds the index with the Style Finder model settings', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    await mockColors(page)
    const pointsUrls: string[] = []
    const regionsUrls: string[] = []
    const starts: Array<Record<string, unknown>> = []
    await page.route('**/api/style-map/points**', (route) => {
      pointsUrls.push(route.request().url())
      return route.fulfill({ json: pointsBody() })
    })
    await page.route('**/api/style-map/regions**', (route) => {
      regionsUrls.push(route.request().url())
      return route.fulfill({ json: regionsBody() })
    })
    await page.route('**/api/style-map/vectors/start', (route) => {
      starts.push(route.request().postDataJSON())
      return route.fulfill({ json: { status: 'idle', total: 0, space: 'kaloscope' } })
    })
    await mockThumbnails(page)
    // The user saved local weights on the Style Finder page (its own store).
    await page.addInitScript(() => {
      localStorage.setItem('sd-image-sorter-artist-defaults-v1', JSON.stringify({
        version: 1, savedAt: '2026-10-01T00:00:00Z', modelSource: 'local', modelPath: 'D:/models/my-kaloscope.pth', threshold: 0.03, useGpu: false,
      }))
    })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    await expect.poll(() => regionsUrls.length).toBeGreaterThan(0)
    const settings = 'model_source=local&model_path=D%3A%2Fmodels%2Fmy-kaloscope.pth'
    expect(pointsUrls[0]).toContain(settings)
    expect(regionsUrls[0]).toContain(settings)
    await map.buildButton.click()
    await expect.poll(() => starts.length).toBe(1)
    expect(starts[0]).toMatchObject({ space: 'kaloscope', model_source: 'local', model_path: 'D:/models/my-kaloscope.pth', use_gpu: false })
    // The CLIP space reads the Similarity index, not Kaloscope: no model settings ride along.
    await map.spaceSelect.selectOption('clip')
    await expect.poll(() => pointsUrls.length).toBe(2)
    expect(pointsUrls[1]).toContain('space=clip')
    expect(pointsUrls[1]).not.toContain('model_source')
    expect(pointsUrls[1]).not.toContain('model_path')
  })

  test('builds the index with the Style Finder threshold so both entrances store the same rows', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    const pointsUrls: string[] = []
    const starts: Array<Record<string, unknown>> = []
    await page.route('**/api/style-map/points**', (route) => {
      pointsUrls.push(route.request().url())
      return route.fulfill({ json: pointsBody() })
    })
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    await page.route('**/api/style-map/vectors/start', (route) => {
      starts.push(route.request().postDataJSON())
      return route.fulfill({ json: { status: 'idle', total: 0, space: 'kaloscope' } })
    })
    await mockThumbnails(page)
    // The user raised the "Discard results below" slider on the Style Finder
    // page and saved it (the page's own store; applied to the slider at boot).
    await page.addInitScript(() => {
      localStorage.setItem('sd-image-sorter-artist-defaults-v1', JSON.stringify({
        version: 1, savedAt: '2026-10-01T00:00:00Z', modelSource: 'huggingface', modelPath: '', threshold: 0.12, useGpu: true,
      }))
    })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    await expect(page.locator('#artist-threshold')).toHaveValue('0.12')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    // The map reads vectors by weights only: the slider never rides on GET.
    expect(pointsUrls[0]).not.toContain('threshold')
    await map.buildButton.click()
    await expect.poll(() => starts.length).toBe(1)
    expect(starts[0]).toMatchObject({ space: 'kaloscope', model_source: 'huggingface', use_gpu: true, threshold: 0.12 })

    // Moving the slider afterwards is enough: the next build reads it live,
    // the same way the Finder page reads it for identify-batch.
    await page.locator('#artist-threshold').evaluate((input) => {
      (input as HTMLInputElement).value = '0.22'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await map.buildButton.click()
    await expect.poll(() => starts.length).toBe(2)
    expect(starts[1]).toMatchObject({ threshold: 0.22 })
  })

  test('refuses to build the index while the Style Finder says local but names no file', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    const pointsUrls: string[] = []
    let starts = 0
    await page.route('**/api/style-map/points**', (route) => {
      pointsUrls.push(route.request().url())
      return route.fulfill({ json: pointsBody() })
    })
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    await page.route('**/api/style-map/vectors/start', (route) => {
      starts += 1
      return route.fulfill({ json: { status: 'started', total: 3, space: 'kaloscope' } })
    })
    await mockThumbnails(page)
    // Saved on the Style Finder page: local weights, path left blank.
    await page.addInitScript(() => {
      localStorage.setItem('sd-image-sorter-artist-defaults-v1', JSON.stringify({
        version: 1, savedAt: '2026-10-01T00:00:00Z', modelSource: 'local', modelPath: '', threshold: 0.03, useGpu: true,
      }))
    })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    // Reading falls back to the official weights (never a half-filled local setting).
    expect(pointsUrls[0]).toContain('model_source=huggingface')
    expect(pointsUrls[0]).not.toContain('model_path')
    // Building must not: the official weights would overwrite the user's own
    // identification results. Nothing is sent and the page says why.
    await map.buildButton.click()
    await expect(page.locator('.toast')).toContainText(/Style Finder page|画风识别页/)
    await page.waitForTimeout(500)
    expect(starts).toBe(0)
    await expect(map.progressRow).toBeHidden()
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

  test('draws at most k landmark cards without empty text rows; the switch flips its words, remembers, and stops the thumbnails', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    await mockColors(page)
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody() }))
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    let landmarkThumbnails = 0
    // Landmark pictures are the mock's 90xx ids at size=256; the Gallery grid
    // behind the view fetches its own (smaller, real) thumbnails.
    await mockThumbnails(page, (url) => { if (/\/api\/image-thumbnail\/90\d\d\?size=256/.test(url)) { landmarkThumbnails += 1 } })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    await expect(map.landmarksLayer).toBeVisible()
    // One card per region, never more than k; a region with nothing to say
    // shows its picture only (no empty text row).
    await expect(map.landmarks).toHaveCount(3)
    expect(await map.landmarks.count()).toBeLessThanOrEqual(regionsBody().k)
    await expect(map.landmark(0).locator('.stylemap-landmark-text')).toHaveText(/monochrome|单色/)
    await expect(map.landmark(1).locator('.stylemap-landmark-text')).toHaveCount(0)
    // Closed: the artist's name only; the coverage sits in the open card.
    await expect(map.landmark(2).locator('.stylemap-landmark-text')).toContainText('meion')
    await expect(map.landmark(2).locator('.stylemap-landmark-text')).not.toContainText('3/4')
    await expect.poll(() => landmarkThumbnails, { message: () => landmarkUrls.join('\n') }).toBe(3)
    // Nothing on the card pretends to be clickable.
    expect(await map.landmark(0).evaluate((el) => getComputedStyle(el).cursor)).not.toBe('pointer')

    // The switch names the action and flips with the state (rule 16).
    await expect(map.landmarksToggle).toHaveText(/隐藏区域标记|Hide region landmarks/)
    await expect(map.landmarksToggle).toHaveAttribute('aria-pressed', 'true')
    await map.landmarksToggle.click()
    await expect(map.landmarksToggle).toHaveText(/显示区域标记|Show region landmarks/)
    await expect(map.landmarksToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(map.landmarksLayer).toBeHidden()

    // Off is remembered across a reload, and an off map never asks for the
    // landmark thumbnails (only the hover preview's 512 size is the page's).
    landmarkThumbnails = 0
    await page.reload()
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    await expect(map.landmarksToggle).toHaveText(/显示区域标记|Show region landmarks/)
    await expect(map.landmarksLayer).toBeHidden()
    await page.waitForTimeout(600)
    expect(landmarkThumbnails).toBe(0)
    await map.landmarksToggle.click()
    await expect(map.landmarksLayer).toBeVisible()
    await expect(map.landmarks).toHaveCount(3)
    await expect.poll(() => landmarkThumbnails).toBe(3)
  })

  test('hovering a landmark opens it and lights that region\'s dots', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody() }))
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    // One category for every dot: the focus contrast below compares bases.
    await mockColors(page, () => {}, { categories: 1, missing: false })
    await mockThumbnails(page)
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect(map.landmarks).toHaveCount(3)
    const card = map.landmark(0)
    await card.hover()
    await expect(card).toHaveClass(/is-open/)
    // The open card: second picture, every label, the picture count.
    await expect(card.locator('.stylemap-landmark-thumbs img')).toHaveCount(2)
    await expect(card.locator('.stylemap-landmark-artist')).toContainText('modare')
    await expect(card.locator('.stylemap-landmark-artist')).toContainText('5/6')
    await expect(card.locator('.stylemap-landmark-tags')).toHaveText(/monochrome|单色/)
    await expect(card.locator('.stylemap-landmark-count')).toContainText('14')
    // Dots of region 0 are brighter than every other dot; leaving restores them.
    const contrast = () => page.evaluate(() => {
      const state = (window as any).StyleMap._state
      const colors = state.scene.geometry.getAttribute('color')
      const labels: Int8Array = state.regionLabels
      const inside = labels.indexOf(0)
      const outside = labels.findIndex((label: number) => label !== 0)
      return { focus: state.scene.focus?.region ?? null, inside: colors.getX(inside), outside: colors.getX(outside) }
    })
    await expect.poll(async () => (await contrast()).focus).toBe(0)
    const lit = await contrast()
    expect(lit.inside).toBeGreaterThan(lit.outside)
    await page.mouse.move(5, 5)
    await expect(card).not.toHaveClass(/is-open/)
    await expect.poll(async () => (await contrast()).focus).toBeNull()
    const plain = await contrast()
    expect(plain.inside).toBeCloseTo(plain.outside, 5)
  })

  test('the wheel over a landmark card zooms the map instead of scrolling the page', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody() }))
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    await mockThumbnails(page)
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect(map.landmarks).toHaveCount(3)
    const distance = () => page.evaluate(() => {
      const scene = (window as any).StyleMap._state.scene
      return scene.camera.position.distanceTo(scene.controls.target)
    })
    const card = map.landmark(0)
    await card.hover()
    await expect(card).toHaveClass(/is-open/)
    const before = await distance()
    await page.mouse.wheel(0, -240)
    await expect.poll(distance, { timeout: 3000 }).not.toBeCloseTo(before, 3)
    expect(await distance()).toBeLessThan(before)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('drops the regions of a map that was replaced while they were loading', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    await mockColors(page)
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody() }))
    await mockThumbnails(page)
    let regionsCalls = 0
    await page.route('**/api/style-map/regions**', async (route) => {
      regionsCalls += 1
      if (regionsCalls === 1) {
        // The first map's regions are slow; the filter changes meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        return route.fulfill({ json: regionsBody({ regions: regionsBody().regions.map((region) => ({ ...region, id: region.id + 100 })) }) })
      }
      return route.fulfill({ json: regionsBody() })
    })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    await expect.poll(() => regionsCalls).toBe(1)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('gallery-filters-changed')))
    await expect.poll(() => regionsCalls, { timeout: 5000 }).toBe(2)
    await expect(map.landmarks).toHaveCount(3)
    // The stale answer lands at ~1.5 s: it must not replace the new map's cards.
    await page.waitForTimeout(1800)
    const ids = await map.landmarks.evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.region))
    expect(ids).toEqual(['0', '1', '2'])
  })

  test('landmark cards use small pictures on a small canvas and large ones on a big canvas', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody() }))
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    await mockThumbnails(page)
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect(map.landmarks).toHaveCount(3)
    // The card's own CSS width (the depth scale is a transform on top of it).
    const thumbWidth = () => map.landmark(0).locator('.stylemap-landmark-thumbs img').first()
      .evaluate((img) => Math.round(parseFloat(getComputedStyle(img).width)))
    // The canvas, not the window, decides: 1366x768 leaves it ~570 px tall.
    const canvas = await map.canvas.evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }))
    expect(Math.min(canvas.w, canvas.h)).toBeLessThan(700)
    await expect(map.landmarksLayer).toHaveClass(/is-small/)
    await expect.poll(thumbWidth).toBe(64)
    // Growing the window past the threshold re-lays the cards out at full size.
    await page.setViewportSize({ width: 1920, height: 1080 })
    await expect(map.landmarksLayer).not.toHaveClass(/is-small/)
    await expect.poll(thumbWidth).toBe(96)
    // The open card stays whole on the small canvas.
    await page.setViewportSize({ width: 1366, height: 768 })
    await expect.poll(thumbWidth).toBe(64)
    const card = map.landmark(0)
    await card.hover()
    await expect(card).toHaveClass(/is-open/)
    const fit = await page.evaluate(() => {
      const open = document.querySelector('.stylemap-landmark.is-open')!.getBoundingClientRect()
      const box = document.querySelector('#stylemap-canvas-card')!.getBoundingClientRect()
      return open.left >= box.left - 0.5 && open.right <= box.right + 0.5 && open.top >= box.top - 0.5 && open.bottom <= box.bottom + 0.5
    })
    expect(fit).toBe(true)
  })

  test('asks for regions again when the layout switches from PCA to UMAP, and calls points first on not_started', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    await mockColors(page)
    await mockThumbnails(page)
    let statusReply = 'computing'
    let regionsReply: 'not_started' | 'ok' = 'not_started'
    const regionsCalls: string[] = []
    let pointsCalls = 0
    await page.route('**/api/style-map/layout-status**', (route) =>
      route.fulfill({ json: { space: 'kaloscope', method: statusReply === 'ready' ? 'umap' : 'pca', umap: { status: statusReply, points: 30, min_points: 21, params: UMAP_PARAMS } } }))
    await page.route('**/api/style-map/points**', (route) => {
      pointsCalls += 1
      const ready = statusReply === 'ready'
      return route.fulfill({ json: pointsBody({
        method: ready ? 'umap' : 'pca',
        umap: ready
          ? { status: 'ready', points: 30, min_points: 21, params: UMAP_PARAMS, source: 'memory', elapsed_s: 4.2 }
          : { status: 'computing', points: 30, min_points: 21, params: UMAP_PARAMS, queued_at: 1 },
      }) })
    })
    await page.route('**/api/style-map/regions**', (route) => {
      regionsCalls.push(statusReply)
      if (regionsReply === 'not_started') {
        regionsReply = 'ok'
        return route.fulfill({ json: { status: 'not_started', space: 'kaloscope', regions: [] } })
      }
      return route.fulfill({ json: regionsBody({ method: statusReply === 'ready' ? 'umap' : 'pca' }) })
    })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    // not_started: the page calls points again, then regions again (once).
    await expect(map.landmarks).toHaveCount(3)
    expect(pointsCalls).toBe(2)
    expect(regionsCalls.length).toBe(2)
    // The UMAP coordinates arrive as a new points answer: fresh regions.
    statusReply = 'ready'
    await expect.poll(() => pointsCalls, { timeout: 8000 }).toBe(3)
    await expect.poll(() => regionsCalls.length, { timeout: 8000 }).toBe(3)
    expect(regionsCalls[2]).toBe('ready')
    await expect(map.landmarks).toHaveCount(3)
  })

  test('colours the dots by the chosen field without asking for points again, greys dots without data, and remembers the choice', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    let pointsCalls = 0
    await page.route('**/api/style-map/points**', (route) => {
      pointsCalls += 1
      return route.fulfill({ json: pointsBody() })
    })
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    await mockThumbnails(page)
    const colorsUrls: URL[] = []
    await mockColors(page, (url) => colorsUrls.push(url))
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    // Rule 20: every colourable field is offered.
    await expect(map.colorBySelect.locator('option')).toHaveCount(6)
    expect(await map.colorBySelect.locator('option').evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value)))
      .toEqual(['generator', 'folder', 'artist', 'aesthetic_score', 'aesthetic_waifu', 'aesthetic_anime'])
    // The default field is the generator and its request carries the map's scope.
    await expect(map.colorBySelect).toHaveValue('generator')
    await expect.poll(() => colorsUrls.length).toBe(1)
    expect(colorsUrls[0].searchParams.get('by')).toBe('generator')
    expect(colorsUrls[0].searchParams.get('selection_token')).toBe('tok.e2e')
    expect(colorsUrls[0].searchParams.get('space')).toBe('kaloscope')
    // Legend: one chip per category (5) plus the grey "no data" chip, one row.
    await expect(map.legendChips).toHaveCount(6)
    await expect(map.legendChips.first()).toContainText('gen0')
    await expect(map.legendChips.last()).toContainText(/无数据|No data/)
    await expect(map.legendChips.last()).toContainText('1')
    expect(await legendRowCheck(map)).toMatchObject({ oneRow: true, inside: true, overflow: false, toolbarWraps: false, pageOverflow: false })
    // Dots: the first category's hue, the unscored dot the no-data grey.
    expectRgb(await map.dotColor(1), FIRST_CATEGORY_RGB)
    expectRgb(await map.dotColor(30), NO_DATA_RGB)
    // The legend swatch is the dot's own colour.
    const swatch = await map.legendChips.first().locator('.stylemap-swatch').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(swatch).toBe('rgb(216, 82, 75)')

    // Switching the field asks for colours only; the layout stays.
    await map.colorBySelect.selectOption('aesthetic_score')
    await expect.poll(() => colorsUrls.length).toBe(2)
    expect(colorsUrls[1].searchParams.get('by')).toBe('aesthetic_score')
    expect(pointsCalls).toBe(1)
    await expect(map.legendRamp).toBeVisible()
    await expect(map.legend.locator('.stylemap-legend-min')).toHaveText('3.00')
    await expect(map.legend.locator('.stylemap-legend-max')).toHaveText('8.00')
    await expect(map.legendChips).toHaveCount(1) // the no-data chip only
    await expect.poll(async () => (await map.dotColor(1))[0]).toBeCloseTo(RAMP_START_RGB[0], 3)
    expectRgb(await map.dotColor(1), RAMP_START_RGB)
    expectRgb(await map.dotColor(30), NO_DATA_RGB)
    const stats = await page.evaluate(() => (window as any).StyleMap._state.colorStats)
    expect(stats.by).toBe('aesthetic_score')
    expect(stats.points).toBe(30)

    // Folder chips show the last segment and carry the full path as tooltip.
    await map.colorBySelect.selectOption('folder')
    await expect.poll(() => colorsUrls.length).toBe(3)
    await expect(map.legendChips.first()).toContainText('set A')
    await expect(map.legendChips.first()).toHaveAttribute('title', /L:\/pics\/set A/)
    expect(pointsCalls).toBe(1)

    // The choice survives a reload and is the first thing asked for.
    await page.reload()
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    await expect(map.colorBySelect).toHaveValue('folder')
    await expect.poll(() => colorsUrls.length).toBe(4)
    expect(colorsUrls[3].searchParams.get('by')).toBe('folder')
  })

  test('folds a long legend into a +N button that opens the full list, one row at 1366 and 1920, in both languages', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody() }))
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    await mockThumbnails(page)
    // 14 artists (long names, the tightest case): the server folds the
    // smallest ones into "other" (13 entries).
    await page.route('**/api/style-map/colors**', (route) => {
      const body = colorsBody('artist', { categories: 12 })
      body.legend = body.legend.map((entry, i) => ({ ...entry, key: `artist_${i}_(long_name_${i})`, label: `artist_${i}_(long_name_${i})` }))
      body.legend.push({ key: '__other__', label: '', count: 3 })
      return route.fulfill({ json: body })
    })
    for (const [width, height, lang] of [[1366, 768, 'en'], [1366, 768, 'zh-CN'], [1920, 1080, 'zh-CN']] as const) {
      await page.setViewportSize({ width, height })
      await page.goto('/')
      await page.evaluate((code) => localStorage.setItem('sd-image-sorter-lang', code), lang)
      await page.reload()
      const map = new StyleMapPage(page)
      await map.open()
      await expect.poll(() => map.pointCount()).toBe(30)
      await expect(map.legendMore).toBeVisible()
      const folded = Number(await map.legendMore.getAttribute('data-hidden'))
      expect(folded).toBeGreaterThan(0)
      const shown = await map.legendChips.count()
      expect(shown + folded).toBe(14) // 13 legend entries + the no-data chip
      // Rule 18: never an empty row beside a "+N"; the row holds as many
      // chips as fit, and one more would overflow.
      expect(shown).toBeGreaterThan(0)
      expect(await legendRowCheck(map)).toMatchObject({ oneRow: true, inside: true, overflow: false, maximal: true, toolbarWraps: false, pageOverflow: false })
      // The status line keeps whole words and carries its full sentence as tooltip.
      expect(await map.layoutText.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      await expect(map.layoutStatus).toHaveAttribute('title', /UMAP/)
      // Open: every entry, the "other" one named; the button's words flip (rule 16).
      await map.legendMore.click()
      await expect(map.legendPop).toBeVisible()
      await expect(map.legendPop.locator('.stylemap-legend-chip')).toHaveCount(14)
      await expect(map.legendPop).toContainText(/其他|Other/)
      await expect(map.legendMore).toHaveText(/收起|Fewer/)
      await expect(map.legendMore).toHaveAttribute('aria-expanded', 'true')
      await page.keyboard.press('Escape')
      await expect(map.legendPop).toHaveCount(0)
      await expect(map.legendMore).toHaveText(`+${folded}`)
    }
  })

  test('a colour change that the server cannot answer leaves the dots grey and says so; not_started rebuilds the map once', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    let pointsCalls = 0
    await page.route('**/api/style-map/points**', (route) => {
      pointsCalls += 1
      return route.fulfill({ json: pointsBody() })
    })
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    await mockThumbnails(page)
    let mode: 'ok' | 'not_started' | 'error' = 'ok'
    const colorsCalls: string[] = []
    await page.route('**/api/style-map/colors**', (route) => {
      const by = new URL(route.request().url()).searchParams.get('by') || 'generator'
      colorsCalls.push(`${mode}:${by}`)
      if (mode === 'error') return route.fulfill({ status: 500, json: { detail: 'boom' } })
      if (mode === 'not_started') {
        mode = 'ok' // the rebuilt map answers
        return route.fulfill({ json: { status: 'not_started', space: 'kaloscope', by, kind: 'category', ids: [], values: [], legend: [], range: null, missing: 0 } })
      }
      return route.fulfill({ json: colorsBody(by) })
    })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    await expect.poll(() => colorsCalls.length).toBe(1)
    // The request is counted before its answer is painted: wait for it.
    await expect(map.legendChips.first()).toContainText('gen0')
    expectRgb(await map.dotColor(1), FIRST_CATEGORY_RGB)

    // The server lost the map (a picture was added meanwhile): points are
    // asked for again, then the colours of the new field.
    mode = 'not_started'
    await map.colorBySelect.selectOption('folder')
    await expect.poll(() => pointsCalls).toBe(2)
    await expect.poll(() => colorsCalls.length).toBe(3)
    expect(colorsCalls.slice(1)).toEqual(['not_started:folder', 'ok:folder'])
    await expect(map.legendChips.first()).toContainText('set A')
    expectRgb(await map.dotColor(1), FIRST_CATEGORY_RGB)

    // A failure: the select names the new field, the dots are grey (never
    // the old field's colours) and the row says the colours failed.
    mode = 'error'
    await map.colorBySelect.selectOption('artist')
    await expect.poll(() => colorsCalls.length).toBe(4)
    await expect(map.colorBySelect).toHaveValue('artist')
    await expect(map.legend).toContainText(/读取失败|could not be loaded/)
    expectRgb(await map.dotColor(1), NO_DATA_RGB)
    expectRgb(await map.dotColor(2), NO_DATA_RGB)
    expect(pointsCalls).toBe(2)
    await expect(map.legendRamp).toHaveCount(0)
  })

  test('a server that keeps losing the map is asked for points once more only; colours and regions then say so', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    let pointsCalls = 0
    const mapIds: Array<string | null> = []
    await page.route('**/api/style-map/points**', (route) => {
      pointsCalls += 1
      return route.fulfill({ json: pointsBody({ map_id: `0000000000000000000000000000000${pointsCalls}` }) })
    })
    let colorsCalls = 0
    await page.route('**/api/style-map/colors**', (route) => {
      colorsCalls += 1
      const url = new URL(route.request().url())
      mapIds.push(url.searchParams.get('map_id'))
      return route.fulfill({ json: { status: 'not_started', space: 'kaloscope', by: url.searchParams.get('by'), kind: 'category', ids: [], values: [], legend: [], range: null, missing: 0 } })
    })
    let regionsCalls = 0
    await page.route('**/api/style-map/regions**', (route) => {
      regionsCalls += 1
      mapIds.push(new URL(route.request().url()).searchParams.get('map_id'))
      return route.fulfill({ json: { status: 'not_started', space: 'kaloscope', regions: [] } })
    })
    await mockThumbnails(page)
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    // Colours and regions each get one rebuild, then stop: three points
    // calls at most (first + one per retry), however long we wait.
    await expect(map.legend).toContainText(/读取失败|could not be loaded/)
    await page.waitForTimeout(3000)
    expect(pointsCalls).toBeLessThanOrEqual(3)
    expect(pointsCalls).toBeGreaterThanOrEqual(2)
    expect(colorsCalls).toBeLessThanOrEqual(3)
    expect(regionsCalls).toBeLessThanOrEqual(3)
    // Every colours/regions request named the map by the handle points gave it.
    expect(mapIds.every((id) => id !== null && /^0{31}\d$/.test(id))).toBe(true)
    expectRgb(await map.dotColor(1), NO_DATA_RGB)
    await expect(map.landmarks).toHaveCount(0)
    // The retry in the row arms one more rebuild, and only one.
    const before = pointsCalls
    await map.legend.locator('.stylemap-legend-retry').click()
    await expect.poll(() => pointsCalls).toBe(before + 1)
    await expect(map.legend).toContainText(/读取失败|could not be loaded/)
    await page.waitForTimeout(2000)
    expect(pointsCalls).toBe(before + 1)
  })

  test('an empty filter result clears the legend', async ({ page }) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    let empty = false
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: empty
      ? pointsBody({ status: 'empty', points: [], total_images: 0, missing_vectors: 0, unlocatable: [], umap: { status: 'too_few_points', points: 0, min_points: 21, params: UMAP_PARAMS } })
      : pointsBody() }))
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    await mockThumbnails(page)
    await mockColors(page)
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    await expect(map.legendChips).toHaveCount(6)
    empty = true
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('gallery-filters-changed')))
    await expect.poll(() => map.pointCount()).toBe(0)
    await expect(map.legend).toBeEmpty()
    await expect(map.scope).toContainText(/没有|matches no/)
  })

  test('ESC closes the open legend list without opening the entry page', async ({ page }) => {
    // The suite skips the entry page (aurora-entry-skip=1); this test wants it.
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem('stylemap-entry-booted')) {
        window.sessionStorage.setItem('stylemap-entry-booted', '1')
        window.localStorage.removeItem('aurora-entry-skip')
      }
    })
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody() }))
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
    await mockThumbnails(page)
    await page.route('**/api/style-map/colors**', (route) => {
      const body = colorsBody('generator', { categories: 12 })
      body.legend.push({ key: '__other__', label: '', count: 3 })
      return route.fulfill({ json: body })
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto('/')
    await expect(page.locator('#entry-page')).toBeVisible()
    await page.locator('#entry-fn-gallery').click()
    await expect(page.locator('#entry-page')).toBeHidden()
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    await map.legendMore.click()
    await expect(map.legendPop).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(map.legendPop).toHaveCount(0)
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(map.view).toHaveClass(/active/)
    // A second ESC with nothing open is the entry page's as before.
    await page.keyboard.press('Escape')
    await expect(page.locator('#entry-page')).toBeVisible()
  })

  test('repaints 50k dots from a colours answer in under 50 ms', async ({ page }, testInfo) => {
    await mockSelectionToken(page)
    await mockProgressIdle(page)
    const n = 50000
    const rows = Array.from({ length: n }, (_, i) => [i + 1, ((i * 7919) % 2000) / 1000 - 1, ((i * 104729) % 2000) / 1000 - 1, ((i * 1299709) % 2000) / 1000 - 1, 1])
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody({ total_images: n, missing_vectors: 0, unlocatable: [], points: rows, umap: { status: 'unavailable', points: n, min_points: 21, params: UMAP_PARAMS } }) }))
    await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: { status: 'ok', space: 'kaloscope', method: 'pca', k: 0, seed: 0, algo_version: 1, regions: [], cached: false } }))
    const ids = rows.map((row) => row[0] as number)
    const body = colorsBody('generator', { categories: 12, ids })
    const bytes = Buffer.byteLength(JSON.stringify(body))
    await page.route('**/api/style-map/colors**', (route) => route.fulfill({ json: body }))
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount(), { timeout: 30000 }).toBe(n)
    await expect.poll(() => page.evaluate(() => (window as any).StyleMap._state.colorStats?.by), { timeout: 30000 }).toBe('generator')
    const stats = await page.evaluate(() => (window as any).StyleMap._state.colorStats)
    testInfo.annotations.push({ type: 'perf', description: `50k recolour ${stats.ms.toFixed(1)} ms; colours JSON ${bytes} bytes` })
    expect(stats.points).toBe(n)
    expect(stats.ms).toBeLessThan(50)
    expectRgb(await map.dotColor(n), NO_DATA_RGB)
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
