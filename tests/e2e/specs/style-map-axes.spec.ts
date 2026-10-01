import { expect, test, type Page } from '../fixtures/click-ledger'
import { StyleMapPage } from '../pages/StyleMapPage'

/**
 * Style Map axis meanings (S4e) against mocked /api/style-map/*. The scripted
 * axes answer has labels at both ends of x, one end of y and a weak z; what
 * is under test is the page: the labels on the floor grid (words, arrows,
 * a dash for the weak axis, no overlap or clipping), the "what the axes mean"
 * card (pictures per end, preview + fly-to on click, the UMAP note, flipping
 * toggles, Esc owned by the card), the requests (map_id, layout, space) and
 * the bounded rebuild when the server lost the map.
 */

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const MAP_ID = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'
const UMAP_PARAMS = { n_neighbors: 15, min_dist: 0.1, metric: 'cosine', input_dim: 64, random_state: 0 }

const WORDS = {
  en: {
    title: 'What the axes mean', open: 'Axis meanings', close: 'Hide axis meanings',
    umap: 'UMAP: directions are not fixed, only distances mean something',
    weak: 'No clear shared trait in this direction', hide: 'Hide axis labels', show: 'Show axis labels',
    xLow: 'monochrome · lineart', xHigh: 'flat color', sunlight: 'sunlight', error: 'The axis meanings could not be loaded',
  },
  'zh-CN': {
    title: '轴的含义', open: '轴的含义', close: '收起轴的含义',
    umap: 'UMAP：位置方向不固定，只看远近',
    weak: '这个方向没有明显的共同特征', hide: '隐藏轴标签', show: '显示轴标签',
    xLow: '单色 · 线稿', xHigh: '平涂', sunlight: '阳光', error: '无法载入轴的含义',
  },
} as const

function pointsBody(overrides: Record<string, unknown> = {}) {
  const points = Array.from({ length: 30 }, (_, i) => [i + 1, (i % 5) / 4 - 0.5, (i % 7) / 6 - 0.5, (i % 3) / 2 - 0.5, 1])
  return {
    status: 'ok', space: 'kaloscope', method: 'pca', model_version: 'kaloscope:test',
    total_images: 33, missing_vectors: 3, unlocatable: [], merged_away: 0,
    explained_variance: [0.05, 0.04, 0.03], points_layout: ['id', 'x', 'y', 'z', 'members'], points,
    umap: { status: 'unavailable', points: 30, min_points: 21, params: UMAP_PARAMS, install: { model_id: 'style-map-umap', packages: ['umap-learn>=0.5.12'] } },
    map_id: MAP_ID, cached: false, ...overrides,
  }
}

function coord(id: number) {
  const i = id - 1
  return { x: (i % 5) / 4 - 0.5, y: (i % 7) / 6 - 0.5, z: (i % 3) / 2 - 0.5 }
}

const tag = (name: string, zh: string | null = null) => ({ tag: name, zh, count: 12, tagged: 20, rate: 0.6, other_rate: 0.05, gain: 0.55, ratio: 12, q: 0.001 })
const end = (representatives: number[], tags: ReturnType<typeof tag>[], size = 6) => ({ representatives, tags, size, tagged: size })

/** x: tags at both ends (3 in all); y: one end labelled; z: weak. */
function axesBody(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok', space: 'kaloscope', layout: 'pca', model_version: 'kaloscope:test', algo_version: 1, points: 30,
    axes: {
      x: { weak: false, strength: 0.55, low: end([1, 2, 3], [tag('monochrome'), tag('lineart')]), high: end([4, 5, 6], [tag('flat_color')]) },
      y: { weak: false, strength: 0.4, low: end([7, 8, 9], [tag('sunlight', '阳光')]), high: end([10, 11, 12], []) },
      z: { weak: true, strength: 0, low: end([13, 14, 15], []), high: end([16, 17, 18], []) },
    },
    cached: false, ...overrides,
  }
}

type Counters = { points: string[]; axes: string[] }

async function mockBase(page: Page, opts: { points?: unknown; axes?: (url: URL) => unknown } = {}): Promise<Counters> {
  const seen: Counters = { points: [], axes: [] }
  await page.route('**/api/images/selection-token', (route) => route.fulfill({ json: { selection_token: 'tok.e2e', total_estimate: 33 } }))
  await page.route('**/api/style-map/vectors/progress', (route) =>
    route.fulfill({ json: { running: false, paused: false, total: 0, processed: 0, written: 0, kept: 0, errors: 0, step: 'idle', message: '', recent_issues: [] } }))
  await page.route('**/api/style-map/points**', (route) => {
    seen.points.push(route.request().url())
    return route.fulfill({ json: opts.points ?? pointsBody() })
  })
  await page.route('**/api/style-map/axes**', (route) => {
    seen.axes.push(route.request().url())
    return route.fulfill({ json: opts.axes ? opts.axes(new URL(route.request().url())) : axesBody() })
  })
  await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: { status: 'ok', space: 'kaloscope', method: 'pca', regions: [], cached: false } }))
  await page.route('**/api/style-map/colors**', (route) => route.fulfill({ json: { status: 'ok', space: 'kaloscope', by: 'generator', kind: 'category', ids: Array.from({ length: 30 }, (_, i) => i + 1), values: new Array(30).fill(0), legend: [{ key: 'nai', label: 'nai', count: 30 }], range: null, missing: 0 } }))
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await page.route('**/api/images/*', (route) => {
    if (route.request().method() !== 'GET' || !/\/api\/images\/\d+$/.test(route.request().url())) return route.fallback()
    return route.fulfill({ json: { image: { filename: 'preview_name.png' } } })
  })
  return seen
}

function watch(page: Page) {
  const consoleErrors: string[] = []
  const httpErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  page.on('response', (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`) })
  return { consoleErrors, httpErrors }
}

async function openMap(page: Page, width: number, height: number, lang: 'en' | 'zh-CN') {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.evaluate((code) => localStorage.setItem('sd-image-sorter-lang', code), lang)
  await page.evaluate(() => localStorage.removeItem('sd-stylemap-axis-labels'))
  await page.reload()
  const map = new StyleMapPage(page)
  await map.open()
  await expect.poll(() => map.pointCount()).toBe(30)
  return map
}

/** The suite-wide storage state skips the entry page; Esc-to-entry reads the key live, so drop it. */
async function allowEntryEsc(page: Page) {
  await page.evaluate(() => localStorage.removeItem('aurora-entry-skip'))
}

/** Visible labels with their words and boxes, and whether they sit inside the canvas card and apart from each other. */
async function labelCheck(page: Page) {
  return page.evaluate(() => {
    const card = (document.querySelector('#stylemap-canvas-card') as HTMLElement).getBoundingClientRect()
    const labels = [...document.querySelectorAll('.stylemap-axis-label')].filter((node) => !(node as HTMLElement).hidden) as HTMLElement[]
    const rects = labels.map((node) => node.getBoundingClientRect())
    const inside = rects.every((r) => r.left >= card.left - 0.5 && r.right <= card.right + 0.5 && r.top >= card.top - 0.5 && r.bottom <= card.bottom + 0.5)
    let overlap = false
    rects.forEach((a, i) => rects.forEach((b, j) => {
      if (j > i && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlap = true
    }))
    const clipped = labels.some((node) => (node.querySelector('.stylemap-axis-text') as HTMLElement).scrollWidth > (node.querySelector('.stylemap-axis-text') as HTMLElement).clientWidth + 1)
    return {
      count: labels.length, inside, overlap, clipped,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      byKey: Object.fromEntries(labels.map((node) => [`${node.dataset.axis}-${node.dataset.end}`, (node.querySelector('.stylemap-axis-text') as HTMLElement).textContent])),
      weak: labels.filter((node) => node.classList.contains('is-weak')).map((node) => `${node.dataset.axis}-${node.dataset.end}`),
    }
  })
}

/** The card must sit inside the canvas card, keep every block in view or scroll, and never cover the side column. */
async function cardCheck(page: Page) {
  return page.evaluate(() => {
    const card = (document.querySelector('#stylemap-canvas-card') as HTMLElement).getBoundingClientRect()
    const panel = document.querySelector('#stylemap-axes-panel') as HTMLElement
    const rect = panel.getBoundingClientRect()
    const side = (document.querySelector('.stylemap-side') as HTMLElement).getBoundingClientRect()
    const body = document.querySelector('.stylemap-axes-body') as HTMLElement
    const tagsClipped = [...panel.querySelectorAll('.stylemap-axes-tags')].some((node) => (node as HTMLElement).scrollWidth > (node as HTMLElement).clientWidth + 1)
    return {
      inside: rect.left >= card.left - 0.5 && rect.right <= card.right + 0.5 && rect.top >= card.top - 0.5 && rect.bottom <= card.bottom + 0.5,
      apartFromSide: rect.right <= side.left + 0.5,
      bodyScrolls: body.scrollHeight > body.clientHeight + 1,
      tagsClipped,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    }
  })
}

test.describe('Style Map axis meanings', () => {
  for (const [width, height, lang] of [[1366, 768, 'en'], [1920, 1080, 'zh-CN'], [2560, 1440, 'en']] as const) {
    test(`labels the ends of the axes on the grid and the card lists their pictures at ${width}x${height} (${lang})`, async ({ page }) => {
      const words = WORDS[lang]
      const seen = await mockBase(page)
      const map = await openMap(page, width, height, lang)
      const { consoleErrors, httpErrors } = watch(page)

      // The request names the map and the layout shown.
      await expect.poll(() => seen.axes.length).toBeGreaterThan(0)
      const first = new URL(seen.axes[0])
      expect(first.searchParams.get('map_id')).toBe(MAP_ID)
      expect(first.searchParams.get('layout')).toBe('pca')
      expect(first.searchParams.get('space')).toBe('kaloscope')
      expect(first.searchParams.has('selection_token')).toBe(false)

      // Six labels on the grid: words at the labelled ends, a faint dash for the weak axis.
      await expect(page.locator('.stylemap-axis-label:visible')).toHaveCount(6)
      const labels = await labelCheck(page)
      expect(labels).toMatchObject({ count: 6, inside: true, overlap: false, clipped: false, pageOverflow: false })
      expect(labels.byKey['x-low']).toContain(words.xLow)
      expect(labels.byKey['x-high']).toContain(words.xHigh)
      expect(labels.byKey['y-low']).toContain(words.sunlight)
      expect(labels.byKey['x-low']).toMatch(/[←-↙]/)
      expect(labels.byKey['z-low']).toBe('—')
      expect(labels.byKey['y-high']).toBe('—')
      expect(labels.weak.sort()).toEqual(['y-high', 'z-high', 'z-low'])
      // No UMAP: no note on a label.
      await expect(page.locator('.stylemap-axis-label[data-axis="x"][data-end="low"]')).not.toHaveAttribute('title', /UMAP/)

      // A camera move re-projects the labels (still inside, still apart).
      await page.evaluate(() => {
        const scene = (window as any).StyleMap._state.scene
        scene.camera.position.set(scene.camera.position.x * -1, scene.camera.position.y, scene.camera.position.z)
        scene.controls.update()
        scene.render()
      })
      expect(await labelCheck(page)).toMatchObject({ inside: true, overlap: false, pageOverflow: false })

      // The button opens the card and says the state it is in.
      const toggle = page.locator('#stylemap-axes-toggle')
      await expect(toggle).toHaveText(words.open)
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('#stylemap-axes-panel')).toBeHidden()
      await toggle.click()
      const panel = page.locator('#stylemap-axes-panel')
      await expect(panel).toBeVisible()
      await expect(toggle).toHaveText(words.close)
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(panel.locator('.stylemap-axes-title')).toHaveText(words.title)
      await expect(panel.locator('.stylemap-axes-axis')).toHaveCount(3)
      await expect(panel.locator('.stylemap-axes-thumb')).toHaveCount(18)
      await expect(panel.locator('.stylemap-axes-axis[data-axis="z"] .stylemap-axes-weak')).toHaveText(words.weak)
      await expect(panel.locator('.stylemap-axes-axis[data-axis="x"] .stylemap-axes-weak')).toHaveCount(0)
      await expect(panel.locator('.stylemap-axes-axis[data-axis="x"] [data-end="low"] .stylemap-axes-tags')).toHaveText(words.xLow)
      await expect(panel.locator('.stylemap-axes-note')).not.toHaveClass(/is-umap/)
      expect(await cardCheck(page)).toMatchObject({ inside: true, apartFromSide: true, tagsClipped: false, pageOverflow: false })
      // The pictures of an end sit under their words, in order.
      const ids = await panel.locator('.stylemap-axes-axis[data-axis="x"] [data-end="high"] .stylemap-axes-thumb').evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.id))
      expect(ids).toEqual(['4', '5', '6'])

      // A picture previews and the camera turns to its dot.
      await panel.locator('.stylemap-axes-thumb[data-id="5"]').click()
      await expect(panel.locator('.stylemap-axes-thumb[data-id="5"]')).toHaveAttribute('aria-current', 'true')
      await expect(map.previewImage).toHaveAttribute('src', /\/api\/image-thumbnail\/5\?size=512/)
      const want = coord(5)
      await expect.poll(async () => {
        const t = await page.evaluate(() => (window as any).StyleMap._state.scene.controls.target.toArray())
        return Math.hypot(t[0] - want.x, t[1] - want.y, t[2] - want.z)
      }).toBeLessThan(0.01)

      expect(consoleErrors).toEqual([])
      expect(httpErrors).toEqual([])
    })
  }

  test('the labels switch flips its words, hides the labels and is remembered', async ({ page }) => {
    await mockBase(page)
    await openMap(page, 1366, 768, 'en')
    const flip = page.locator('#stylemap-axes-labels-toggle')
    await expect(flip).toHaveText(WORDS.en.hide)
    await expect(flip).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.stylemap-axis-label:visible')).toHaveCount(6)
    await flip.click()
    await expect(flip).toHaveText(WORDS.en.show)
    await expect(flip).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.stylemap-axis-label:visible')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('sd-stylemap-axis-labels'))).toBe('off')
    await page.reload()
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    await expect(page.locator('.stylemap-axis-labels')).toBeHidden()
    await expect(page.locator('#stylemap-axes-labels-toggle')).toHaveText(WORDS.en.show)
    await page.locator('#stylemap-axes-labels-toggle').click()
    await expect(page.locator('.stylemap-axis-label:visible')).toHaveCount(6)
  })

  for (const lang of ['en', 'zh-CN'] as const) {
    test(`a UMAP layout asks for umap and says its directions are not fixed (${lang})`, async ({ page }) => {
      const words = WORDS[lang]
      const seen = await mockBase(page, {
        points: pointsBody({ method: 'umap', umap: { status: 'ready', source: 'memory', elapsed_s: 1, points: 30, min_points: 21, params: UMAP_PARAMS } }),
        axes: (url) => axesBody({ layout: url.searchParams.get('layout') }),
      })
      await openMap(page, 1366, 768, lang)
      await expect.poll(() => seen.axes.length).toBeGreaterThan(0)
      expect(new URL(seen.axes[seen.axes.length - 1]).searchParams.get('layout')).toBe('umap')
      await page.locator('#stylemap-axes-toggle').click()
      await expect(page.locator('.stylemap-axes-note')).toHaveText(words.umap)
      await expect(page.locator('.stylemap-axes-note')).toHaveClass(/is-umap/)
      await expect(page.locator('.stylemap-axis-label[data-axis="x"][data-end="low"]')).toHaveAttribute('title', new RegExp(words.umap.slice(0, 6)))
      expect(await cardCheck(page)).toMatchObject({ inside: true, tagsClipped: false })
    })
  }

  test('a space switch asks again for the new map', async ({ page }) => {
    const seen = await mockBase(page, { axes: (url) => axesBody({ space: url.searchParams.get('space') }) })
    await openMap(page, 1366, 768, 'en')
    await expect.poll(() => seen.axes.length).toBeGreaterThan(0)
    const before = seen.axes.length
    await page.selectOption('#stylemap-space', 'clip')
    await expect.poll(() => seen.axes.length).toBeGreaterThan(before)
    expect(new URL(seen.axes[seen.axes.length - 1]).searchParams.get('space')).toBe('clip')
  })

  test('Esc closes the open card and does not jump back to the entry page; Esc again does', async ({ page }) => {
    await mockBase(page)
    await openMap(page, 1366, 768, 'en')
    const entry = page.locator('#entry-page')
    await allowEntryEsc(page)
    await page.locator('#stylemap-axes-toggle').click()
    await expect(page.locator('#stylemap-axes-panel')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#stylemap-axes-panel')).toBeHidden()
    await expect(page.locator('#stylemap-axes-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#stylemap-axes-toggle')).toHaveText(WORDS.en.open)
    await expect(entry).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(entry).toBeVisible()
  })

  test('the close button closes the card, and leaving the page never leaves it blocking Esc elsewhere', async ({ page }) => {
    await mockBase(page)
    await openMap(page, 1366, 768, 'en')
    await allowEntryEsc(page)
    await page.locator('#stylemap-axes-toggle').click()
    await page.locator('.stylemap-axes-close').click()
    await expect(page.locator('#stylemap-axes-panel')).toBeHidden()
    await page.locator('#stylemap-axes-toggle').click()
    await expect(page.locator('#stylemap-axes-panel')).toBeVisible()
    await page.locator('#nav-tab-gallery').click()
    await expect(page.locator('#view-stylemap')).toBeHidden()
    await expect(page.locator('#stylemap-axes-panel')).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(page.locator('#entry-page')).toBeVisible()
  })

  test('a server that lost the map is rebuilt once per user action, never in a loop', async ({ page }) => {
    const seen = await mockBase(page, { axes: () => ({ status: 'not_started', space: 'kaloscope', layout: 'pca', axes: {} }) })
    await openMap(page, 1366, 768, 'en')
    await page.locator('#stylemap-axes-toggle').click()
    await expect(page.locator('.stylemap-axes-state')).toContainText(WORDS.en.error)
    await expect(page.locator('.stylemap-axis-label:visible')).toHaveCount(0)
    await page.waitForTimeout(700)
    expect(seen.points).toHaveLength(2) // the first answer and one rebuild
    expect(seen.axes).toHaveLength(2)
    await page.locator('.stylemap-axes-state button').click()
    await expect.poll(() => seen.points.length).toBe(3) // the retry is a user action: one more rebuild
    await page.waitForTimeout(700)
    expect(seen.points).toHaveLength(3)
    expect(seen.axes).toHaveLength(4)
  })
})
