import { expect, test, type Page } from '../fixtures/click-ledger'
import { StyleMapPage } from '../pages/StyleMapPage'

/**
 * Style Map custom axes (S4g) against mocked /api/style-map/*. The scripted
 * custom-axes answer moves every dot (x by the parity of its id), so what is
 * under test is the page: defining the two ends from the picked dots, Apply
 * (the request, the new positions, the user's names on the grid labels, the
 * landmarks hidden with a note), going back, persistence per library across a
 * reload, the honest warnings, and the card's layout at 1366, 1920 and 2560.
 */

const MAP_ID = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'
const UMAP_PARAMS = { n_neighbors: 15, min_dist: 0.1, metric: 'cosine', input_dim: 64, random_state: 0 }
// Screenshots of the defined-axis state, written next to the other throw-away output (git-ignored).
const SHOTS = require('node:path').resolve(__dirname, '../../../.tmp/s4g-shots')

function colorPng(r: number, g: number, b: number): Buffer {
  const zlib = require('node:zlib')
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, tail]) }
  const size = 32
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from([r, g, b])))])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const WORDS = {
  en: {
    tabCustom: 'My axes', tabModel: 'Model axes', apply: 'Apply', revert: 'Back to the model layout', add: 'Add selected pictures',
    applied: 'Applied: the map is laid out along your axes', hiddenModel: 'Your own axes are on', needTwo: 'Each box needs at least 2 pictures', applyNeed: 'Put at least 2 pictures in each box to apply',
    nearNote: 'Your own axes are on, so the estimated spot of your picture cannot be marked. The closest pictures are listed below.',
    notSeparable: 'These two groups are hard to tell apart (3/5); the model may not see this difference. Add more pictures, or use more typical ones.',
    nameA: 'thick paint', nameB: 'flat color', placeholder: 'e.g. thick paint', placeholderB: 'e.g. flat color', open: 'Axis meanings',
  },
  'zh-CN': {
    tabCustom: '自订轴', tabModel: '模型算出的轴', apply: '套用', revert: '还原原本排法', add: '加入选取的图',
    applied: '已套用：地图按你定义的轴排列', hiddenModel: '自订轴已套用', needTwo: '每一栏至少要 2 张图', applyNeed: '每栏至少放 2 张图才能套用',
    nearNote: '自订轴排列下无法标出你的图的估计位置，下面是最像的图',
    notSeparable: '这两组范例分不太开（3/5），模型可能看不出这个差别。可以多放几张，或换更典型的图',
    nameA: '厚涂', nameB: '平涂', placeholder: '例如：厚涂', placeholderB: '例如：平涂', open: '轴的含义',
  },
} as const

function pointsBody(collide = false) {
  const points = Array.from({ length: 30 }, (_, i) => [i + 1, (i % 5) / 4 - 0.5, (i % 7) / 6 - 0.5, (i % 3) / 2 - 0.5, 1])
  // Two different dots that round to the very same spot (L1): ids 29 and 30.
  if (collide) { points[29][1] = points[28][1]; points[29][2] = points[28][2]; points[29][3] = points[28][3] }
  return {
    status: 'ok', space: 'kaloscope', method: 'pca', model_version: 'kaloscope:test',
    total_images: 33, missing_vectors: 3, unlocatable: [], merged_away: 0,
    explained_variance: [0.05, 0.04, 0.03], points_layout: ['id', 'x', 'y', 'z', 'members'], points,
    umap: { status: 'unavailable', points: 30, min_points: 21, params: UMAP_PARAMS, install: { model_id: 'style-map-umap', packages: ['umap-learn>=0.5.12'] } },
    map_id: MAP_ID, cached: false,
  }
}

const original = (id: number) => { const i = id - 1; return [(i % 5) / 4 - 0.5, (i % 7) / 6 - 0.5, (i % 3) / 2 - 0.5] }
/** The scripted custom layout: x by parity (odd ids at -0.9, even at +0.9), y and z squeezed. */
const moved = (id: number) => { const [, y, z] = original(id); return [id % 2 ? -0.9 : 0.9, y * 0.5, z * 0.5] }

function customBody(overrides: Record<string, unknown> = {}, axes: Record<string, unknown> | null = null) {
  const info = (a: number[], b: number[], extra: Record<string, unknown> = {}) => ({ applied: true, reason: null, a_used: a, b_used: b, missing_ids: [], agree: a.length + b.length, total: a.length + b.length, separable: true, ...extra })
  return {
    status: 'ok', space: 'kaloscope', layout: 'pca', model_version: 'kaloscope:test',
    ids: Array.from({ length: 30 }, (_, i) => i + 1), coords: Array.from({ length: 30 }, (_, i) => moved(i + 1)),
    axes: axes ?? { x: info([1, 3, 5], [2, 4, 6]), y: null, z: null }, warnings: [], ...overrides,
  }
}

/** The model's axes answer: all three weak, so six dash labels on the grid. */
const weakAxesBody = () => {
  const end = { representatives: [], tags: [], size: 6, tagged: 6 }
  const axis = { weak: true, strength: 0, low: end, high: end }
  return { status: 'ok', space: 'kaloscope', layout: 'pca', algo_version: 3, points: 30, axes: { x: axis, y: axis, z: axis }, cached: false }
}

const regionsBody = () => ({
  status: 'ok', space: 'kaloscope', method: 'pca', k: 1, seed: 0, algo_version: 1, cached: false,
  regions: [{ id: 0, center: [0, 0, 0], size: 30, members_total: 30, representatives: [1], tagged: 0, tags: [{ tag: 'monochrome', count: 5, tagged: 10, rate: 0.5, ratio: 4, p: 0.001, q: 0.001 }], artists: [] }],
})

type Seen = { posts: Array<{ url: string; body: any }>; axesGets: number; points: number }

async function mockAll(page: Page, custom: (body: any) => unknown = () => customBody(), collide = false): Promise<Seen> {
  const seen: Seen = { posts: [], axesGets: 0, points: 0 }
  await page.route('**/api/images/selection-token', (route) => route.fulfill({ json: { selection_token: 'tok.e2e', total_estimate: 33 } }))
  await page.route('**/api/style-map/vectors/progress', (route) =>
    route.fulfill({ json: { running: false, paused: false, total: 0, processed: 0, written: 0, kept: 0, errors: 0, step: 'idle', message: '', recent_issues: [] } }))
  await page.route('**/api/style-map/points**', (route) => { seen.points += 1; return route.fulfill({ json: pointsBody(collide) }) })
  await page.route('**/api/style-map/axes**', (route) => { seen.axesGets += 1; return route.fulfill({ json: weakAxesBody() }) })
  await page.route('**/api/style-map/custom-axes**', (route) => {
    const body = route.request().postDataJSON()
    seen.posts.push({ url: route.request().url(), body })
    return route.fulfill({ json: custom(body) })
  })
  await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: regionsBody() }))
  await page.route('**/api/style-map/colors**', (route) => route.fulfill({ json: { status: 'ok', space: 'kaloscope', by: 'generator', kind: 'category', ids: Array.from({ length: 30 }, (_, i) => i + 1), values: new Array(30).fill(0), legend: [{ key: 'nai', label: 'nai', count: 30 }], range: null, missing: 0 } }))
  await page.route('**/api/image-thumbnail/**', (route) => {
    const id = Number(/thumbnail\/(\d+)/.exec(route.request().url())?.[1] || 0)
    return route.fulfill({ status: 200, contentType: 'image/png', body: colorPng(60 + (id * 53) % 180, 80 + (id * 97) % 150, 70 + (id * 31) % 170) })
  })
  await page.route('**/api/images/*', (route) => {
    if (route.request().method() !== 'GET' || !/\/api\/images\/\d+$/.test(route.request().url())) return route.fallback()
    return route.fulfill({ json: { image: { filename: 'preview_name.png' } } })
  })
  return seen
}

async function openMap(page: Page, width: number, height: number, lang: 'en' | 'zh-CN', keepStorage = false) {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.evaluate(([code, keep]) => {
    localStorage.setItem('sd-image-sorter-lang', code as string)
    if (!keep) Object.keys(localStorage).filter((k) => k.startsWith('sd-stylemap-custom-axes')).forEach((k) => localStorage.removeItem(k))
  }, [lang, keepStorage])
  await page.reload()
  const map = new StyleMapPage(page)
  await map.open()
  await expect.poll(() => map.pointCount()).toBe(30)
  return map
}

const pick = (page: Page, ids: number[]) => page.evaluate((list) => (window as any).StyleMap._state.picks.commit(new Set(list)), ids)
const dotAt = (page: Page, id: number) => page.evaluate((target) => {
  const scene = (window as any).StyleMap._state.scene
  const index = Array.from(scene.ids as Int32Array).indexOf(target)
  const p = scene.geometry.getAttribute('position')
  return [p.getX(index), p.getY(index), p.getZ(index)].map((v: number) => Math.round(v * 1000) / 1000)
}, id)

async function openCustomTab(page: Page, words: (typeof WORDS)['en']) {
  await page.locator('#stylemap-axes-toggle').click()
  await page.locator('.stylemap-axes-tab[data-mode="custom"]').click()
  await expect(page.locator('.stylemap-axes-tab[data-mode="custom"]')).toHaveText(words.tabCustom)
}

async function define(page: Page, axis: string, a: number[], b: number[], names: [string, string] = ['', '']) {
  const opener = page.locator(`.stylemap-custom-open[data-axis="${axis}"]`)
  if (await opener.count()) await opener.click()
  for (const [end, ids, name] of [['a', a, names[0]], ['b', b, names[1]]] as const) {
    await pick(page, [...ids])
    await page.locator(`.stylemap-custom-axis[data-axis="${axis}"] .stylemap-custom-end[data-end="${end}"] .stylemap-custom-add`).click()
    if (name) {
      const input = page.locator(`.stylemap-custom-axis[data-axis="${axis}"] .stylemap-custom-end[data-end="${end}"] .stylemap-custom-name`)
      await input.fill(name)
      await input.blur()
    }
  }
}

function watch(page: Page) {
  const consoleErrors: string[] = []
  const httpErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  page.on('response', (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`) })
  return { consoleErrors, httpErrors }
}

async function cardCheck(page: Page) {
  return page.evaluate(() => {
    const card = (document.querySelector('#stylemap-canvas-card') as HTMLElement).getBoundingClientRect()
    const panel = document.querySelector('#stylemap-axes-panel') as HTMLElement
    const rect = panel.getBoundingClientRect()
    const side = (document.querySelector('.stylemap-side') as HTMLElement).getBoundingClientRect()
    const buttons = [...panel.querySelectorAll('.stylemap-custom-actions .btn, .stylemap-custom-add')] as HTMLElement[]
    const body = panel.querySelector('.stylemap-axes-body') as HTMLElement
    const bodyRect = body.getBoundingClientRect()
    const applyBox = (panel.querySelector('.stylemap-custom-apply') as HTMLElement)?.getBoundingClientRect()
    return {
      inside: rect.left >= card.left - 0.5 && rect.right <= card.right + 0.5 && rect.top >= card.top - 0.5 && rect.bottom <= card.bottom + 0.5,
      apartFromSide: rect.right <= side.left + 0.5,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      buttonsClipped: buttons.some((b) => b.scrollWidth > b.clientWidth + 1),
      xOverflow: body.scrollWidth > body.clientWidth + 1,
      applyReachable: !!applyBox && applyBox.width > 0,
      bodyInsidePanel: bodyRect.bottom <= rect.bottom + 0.5,
    }
  })
}

test.describe('Style Map custom axes', () => {
  for (const [width, height, lang] of [[1366, 768, 'en'], [1920, 1080, 'zh-CN'], [2560, 1440, 'en']] as const) {
    test(`define an axis from picked dots, apply it, see your names, go back at ${width}x${height} (${lang})`, async ({ page }) => {
      const words = WORDS[lang]
      const seen = await mockAll(page)
      const map = await openMap(page, width, height, lang)
      const { consoleErrors, httpErrors } = watch(page)
      await expect(page.locator('.stylemap-landmark')).toHaveCount(1)
      const before = await dotAt(page, 1)

      await openCustomTab(page, words)
      await expect(page.locator('.stylemap-axes-tab[data-mode="model"]')).toHaveText(words.tabModel)
      // Nothing picked: the add buttons are off and say why; Apply asks for a definition.
      await expect(page.locator('.stylemap-custom-add').first()).toBeDisabled()
      await expect(page.locator('.stylemap-custom-add').first()).toHaveText(words.add)
      await expect(page.locator('.stylemap-custom-name').first()).toHaveAttribute('placeholder', words.placeholder)
      await expect(page.locator('.stylemap-custom-name').nth(1)).toHaveAttribute('placeholder', words.placeholderB)
      // Nothing defined: X is open, Y and Z are one folded button each (no empty boxes).
      await expect(page.locator('.stylemap-custom-axis')).toHaveCount(1)
      await expect(page.locator('.stylemap-custom-open')).toHaveCount(2)
      if (width === 1366) await page.screenshot({ path: `${SHOTS}/custom_empty_${lang}_${width}x${height}.png` })
      await expect(page.locator('.stylemap-custom-apply')).toBeDisabled()
      expect(seen.posts).toHaveLength(0)

      await define(page, 'x', [1, 3, 5], [2, 4, 6], [words.nameA, words.nameB])
      await expect(page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-chip')).toHaveCount(3)
      await expect(page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="b"] .stylemap-custom-chip')).toHaveCount(3)
      // A chip can be taken out again; put it back by adding the pick.
      await page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-chip-x').first().click()
      await expect(page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-chip')).toHaveCount(2)
      await pick(page, [1])
      await page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-add').click()
      await expect(page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-chip')).toHaveCount(3)
      expect(await cardCheck(page)).toMatchObject({ inside: true, apartFromSide: true, pageOverflow: false, buttonsClipped: false, xOverflow: false, applyReachable: true })

      await page.locator('.stylemap-custom-apply').click()
      await expect.poll(() => seen.posts.length).toBe(1)
      const post = seen.posts[0]
      expect(post.body).toMatchObject({ space: 'kaloscope', map_id: MAP_ID, layout: 'pca' })
      expect(post.body.axes.x.a.sort()).toEqual([1, 3, 5])
      expect(post.body.axes.x.b.sort()).toEqual([2, 4, 6])
      expect(post.body.axes.y).toBeUndefined()
      expect(new URL(post.url).searchParams.get('space')).toBe('kaloscope')
      await expect(page.locator('.stylemap-custom-note[data-tone="ok"]')).toHaveText(words.applied)
      // The state line sits in the bottom block that stays in view, above Apply, even at 1366.
      const foot = await page.evaluate(() => {
        const panel = (document.querySelector('#stylemap-axes-panel') as HTMLElement).getBoundingClientRect()
        const ok = document.querySelector('.stylemap-custom-foot .stylemap-custom-note[data-tone="ok"]') as HTMLElement
        const apply = (document.querySelector('.stylemap-custom-apply') as HTMLElement).getBoundingClientRect()
        const r = ok.getBoundingClientRect()
        return { inView: r.top >= panel.top && r.bottom <= panel.bottom, aboveApply: r.bottom <= apply.top + 1 }
      })
      expect(foot).toEqual({ inView: true, aboveApply: true })
      // Every example chip shows its picture (a blank chip would be a broken thumbnail).
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.stylemap-custom-chip img')].map((i) => (i as HTMLImageElement).naturalWidth))).toEqual([32, 32, 32, 32, 32, 32])

      // The dots moved to the scripted positions; the landmarks (original layout) are gone with a note.
      await expect.poll(() => dotAt(page, 1)).toEqual(moved(1).map((v) => Math.round(v * 1000) / 1000))
      expect(await dotAt(page, 2)).toEqual(moved(2).map((v) => Math.round(v * 1000) / 1000))
      expect(await dotAt(page, 1)).not.toEqual(before)
      await expect(page.locator('.stylemap-landmark')).toHaveCount(0)
      // Only the defined axis is labelled on the grid, with the user's own names.
      await expect(page.locator('.stylemap-axis-label:visible')).toHaveCount(2)
      await expect(page.locator('.stylemap-axis-label[data-axis="x"][data-end="low"] .stylemap-axis-text')).toContainText(words.nameA)
      await expect(page.locator('.stylemap-axis-label[data-axis="x"][data-end="high"] .stylemap-axis-text')).toContainText(words.nameB)
      await page.locator('.stylemap-axes-tab[data-mode="model"]').click()
      await expect(page.locator('.stylemap-axes-state')).toContainText(words.hiddenModel)
      await page.locator('.stylemap-axes-tab[data-mode="custom"]').click()
      await page.screenshot({ path: `${SHOTS}/custom_${lang}_${width}x${height}.png` })

      // Lookups still land on the dots' shown positions.
      const remapped = await page.evaluate((o) => (window as any).StyleMap._state.scene.remap(o), original(1))
      expect(remapped.map((v: number) => Math.round(v * 1000) / 1000)).toEqual(moved(1).map((v) => Math.round(v * 1000) / 1000))

      // Back to the model layout: dots, landmarks and the six model labels return.
      await page.locator('.stylemap-custom-revert').click()
      await expect.poll(() => dotAt(page, 1)).toEqual(original(1).map((v) => Math.round(v * 1000) / 1000))
      await expect(page.locator('.stylemap-landmark')).toHaveCount(1)
      await expect(page.locator('.stylemap-custom-revert')).toBeDisabled()
      expect(await page.evaluate(() => (window as any).StyleMap._state.scene.remap)).toBeNull()
      expect(map).toBeTruthy()
      expect(consoleErrors).toEqual([])
      expect(httpErrors).toEqual([])
    })
  }

  test('the definitions and the applied state survive a reload, per library', async ({ page }) => {
    const seen = await mockAll(page)
    await openMap(page, 1366, 768, 'en')
    await openCustomTab(page, WORDS.en)
    await define(page, 'x', [1, 3, 5], [2, 4, 6], ['thick paint', 'flat color'])
    await page.locator('.stylemap-custom-apply').click()
    await expect.poll(() => seen.posts.length).toBe(1)
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sd-stylemap-custom-axes')))).toEqual(['sd-stylemap-custom-axes:main'])
    // The same definitions do not leak into another library's key.
    expect(await page.evaluate(() => localStorage.getItem('sd-stylemap-custom-axes:other'))).toBeNull()

    const map = await openMap(page, 1366, 768, 'en', true)
    await expect.poll(() => dotAt(page, 1)).toEqual(moved(1).map((v) => Math.round(v * 1000) / 1000))
    expect(seen.posts.length).toBeGreaterThanOrEqual(2) // re-applied on the fresh map
    await page.locator('#stylemap-axes-toggle').click()
    await page.locator('.stylemap-axes-tab[data-mode="custom"]').click()
    await expect(page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-chip')).toHaveCount(3)
    await expect(page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-name')).toHaveValue('thick paint')
    await expect(page.locator('.stylemap-axis-label[data-axis="x"][data-end="low"] .stylemap-axis-text')).toContainText('thick paint')
    expect(map).toBeTruthy()
  })

  for (const lang of ['en', 'zh-CN'] as const) {
    test(`says so when the two groups are hard to tell apart, a picture is missing or the axes look alike (${lang})`, async ({ page }) => {
      const words = WORDS[lang]
      await mockAll(page, () => customBody({
        warnings: [{ code: 'axes_parallel', axes: ['x', 'y'], cos: 0.95 }],
      }, {
        x: { applied: true, reason: null, a_used: [1, 3, 5], b_used: [2, 4], missing_ids: [6], agree: 3, total: 5, separable: false },
        y: { applied: false, reason: 'too_few_examples', a_used: [7], b_used: [8, 9], missing_ids: [10], agree: 0, total: 3, separable: false },
        z: null,
      }))
      await openMap(page, 1366, 768, lang)
      await openCustomTab(page, words)
      await define(page, 'x', [1, 3, 5], [2, 4, 6])
      await define(page, 'y', [7, 10], [8, 9])
      await page.locator('.stylemap-custom-apply').click()
      await expect(page.locator('.stylemap-custom-note', { hasText: words.notSeparable })).toBeVisible()
      await expect(page.locator('.stylemap-custom-note[data-tone="warn"]')).toHaveCount(5)
      expect(await cardCheck(page)).toMatchObject({ inside: true, pageOverflow: false, buttonsClipped: false })
    })
  }

  test('a one-sided definition is not sent and says each end needs 2 pictures; a lost map is rebuilt once', async ({ page }) => {
    const seen = await mockAll(page, () => ({ status: 'not_started', space: 'kaloscope', layout: 'pca', ids: [], coords: [], axes: {}, warnings: [] }))
    await openMap(page, 1366, 768, 'en')
    await openCustomTab(page, WORDS.en)
    await page.locator('.stylemap-custom-open[data-axis="y"]').click()
    await pick(page, [1, 3])
    await page.locator('.stylemap-custom-axis[data-axis="y"] [data-end="a"] .stylemap-custom-add').click()
    await expect(page.locator('.stylemap-custom-note[data-tone="warn"]')).toHaveText(WORDS.en.needTwo)
    // No complete axis yet: Apply is off and says why.
    await expect(page.locator('.stylemap-custom-apply')).toBeDisabled()
    await expect(page.locator('.stylemap-custom-apply')).toHaveAttribute('title', WORDS.en.applyNeed)
    expect(seen.posts).toHaveLength(0)
    await define(page, 'x', [1, 3, 5], [2, 4, 6])
    await expect(page.locator('.stylemap-custom-apply')).toBeEnabled()
    await page.locator('.stylemap-custom-axis[data-axis="y"] .stylemap-custom-clear').click()
    const pointsBefore = seen.points
    await page.locator('.stylemap-custom-apply').click()
    await expect(page.locator('.stylemap-custom-note[data-tone="error"]')).toBeVisible()
    await page.waitForTimeout(600)
    expect(seen.points).toBe(pointsBefore + 1) // one rebuild, then it gives up
    expect(seen.posts).toHaveLength(2)
  })

  test('another library has its own definitions and applied state, saved under its own key (M1)', async ({ page }) => {
    const seen = await mockAll(page)
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto('/')
    await page.evaluate(() => {
      localStorage.setItem('sd-image-sorter-lang', 'en')
      const def = (a: number[], b: number[], nameA: string) => ({ v: 1, applied: false, axes: { x: { a, b, nameA, nameB: '' }, y: { a: [], b: [], nameA: '', nameB: '' }, z: { a: [], b: [], nameA: '', nameB: '' } } })
      localStorage.setItem('sd-stylemap-custom-axes:main', JSON.stringify(def([1, 3], [2, 4], 'main thick')))
      localStorage.setItem('sd-stylemap-custom-axes:other', JSON.stringify({ ...def([5, 7, 9], [6, 8], 'other thick'), applied: true }))
    })
    await page.reload()
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)
    await openCustomTab(page, WORDS.en)
    await expect(page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-name')).toHaveValue('main thick')
    await expect(page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-chip')).toHaveCount(2)
    expect(seen.posts).toHaveLength(0)
    // Switch library inside the same session, then the map reloads.
    await page.evaluate(() => { (window as any).LibraryWorkspace.getCurrentLibraryId = () => 'other'; return (window as any).StyleMap.refresh() })
    await expect(page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-name')).toHaveValue('other thick')
    await expect(page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-chip')).toHaveCount(3)
    // The other library had it applied: it is laid out again, from its own examples.
    await expect.poll(() => seen.posts.length).toBe(1)
    expect(seen.posts[0].body.axes.x.a.sort()).toEqual([5, 7, 9])
    // Editing writes to the OTHER library's key only.
    await page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="b"] .stylemap-custom-name').fill('right of other')
    const stored = await page.evaluate(() => ({ main: JSON.parse(localStorage.getItem('sd-stylemap-custom-axes:main')!), other: JSON.parse(localStorage.getItem('sd-stylemap-custom-axes:other')!) }))
    expect(stored.main.axes.x.nameA).toBe('main thick')
    expect(stored.main.axes.x.nameB).toBe('')
    expect(stored.other.axes.x.nameB).toBe('right of other')
    // And back: the first library's definitions return, not applied.
    await page.evaluate(() => { (window as any).LibraryWorkspace.getCurrentLibraryId = () => 'main'; return (window as any).StyleMap.refresh() })
    await expect(page.locator('.stylemap-custom-axis[data-axis="x"] [data-end="a"] .stylemap-custom-name')).toHaveValue('main thick')
    await expect(page.locator('.stylemap-custom-revert')).toBeDisabled()
    await expect.poll(() => dotAt(page, 1)).toEqual(original(1).map((v) => Math.round(v * 1000) / 1000))
  })

  test('two dots that round to the same spot keep their own positions for lookups (L1)', async ({ page }) => {
    await mockAll(page, undefined, true)
    await openMap(page, 1366, 768, 'en')
    await openCustomTab(page, WORDS.en)
    await define(page, 'x', [1, 3, 5], [2, 4, 6])
    await page.locator('.stylemap-custom-apply').click()
    await expect.poll(() => dotAt(page, 29)).toEqual(moved(29).map((v) => Math.round(v * 1000) / 1000))
    const spot = await page.evaluate(() => { const p = (window as any).StyleMap._state.points.points; return [p[28][1], p[28][2], p[28][3]] })
    const same = await page.evaluate((s) => { const p = (window as any).StyleMap._state.points.points; return [p[29][1], p[29][2], p[29][3]].join() === s.join() }, spot)
    expect(same).toBe(true) // the two dots really do share the rounded spot
    const look = (id: number) => page.evaluate(([o, i]) => (window as any).StyleMap._state.scene.remap(o, i), [spot, id] as any)
    const round = (v: number[]) => v.map((n) => Math.round(n * 1000) / 1000)
    expect(round(await look(29))).toEqual(round(moved(29)))
    expect(round(await look(30))).toEqual(round(moved(30)))
  })

  test('clearing axes while applied lays out again from the rest, and with none left goes back to the model layout (L5)', async ({ page }) => {
    const seen = await mockAll(page)
    await openMap(page, 1366, 768, 'en')
    await expect(page.locator('.stylemap-axis-label:visible')).toHaveCount(6)
    await openCustomTab(page, WORDS.en)
    await define(page, 'x', [1, 3, 5], [2, 4, 6], ['thick paint', 'flat color'])
    await define(page, 'y', [7, 9, 11], [8, 10, 12], ['dark', 'light'])
    await page.locator('.stylemap-custom-apply').click()
    await expect.poll(() => seen.posts.length).toBe(1)
    await expect(page.locator('.stylemap-axis-label:visible')).toHaveCount(4)
    await page.locator('.stylemap-custom-axis[data-axis="y"] .stylemap-custom-clear').click()
    await expect.poll(() => seen.posts.length).toBe(2)
    expect(Object.keys(seen.posts[1].body.axes)).toEqual(['x'])
    await expect(page.locator('.stylemap-axis-label:visible')).toHaveCount(2)
    // The last axis goes: no request, the model layout and the model labels are back.
    await page.locator('.stylemap-custom-axis[data-axis="x"] .stylemap-custom-clear').click()
    await expect.poll(() => dotAt(page, 1)).toEqual(original(1).map((v) => Math.round(v * 1000) / 1000))
    expect(seen.posts).toHaveLength(2)
    await expect(page.locator('.stylemap-axis-label:visible')).toHaveCount(6)
    await expect(page.locator('.stylemap-landmark')).toHaveCount(1)
    await expect(page.locator('.stylemap-custom-revert')).toBeDisabled()
    await expect(page.locator('.stylemap-custom-apply')).toBeDisabled()
  })

  test('the same map and definitions are not asked for twice, and a mismatched answer is asked for once more (L3, L4)', async ({ page }) => {
    let calls = 0
    const seen = await mockAll(page, () => {
      calls += 1
      return calls === 1 ? customBody({ ids: Array.from({ length: 30 }, (_, i) => 30 - i) }) : customBody()
    })
    await openMap(page, 1366, 768, 'en')
    await openCustomTab(page, WORDS.en)
    await define(page, 'x', [1, 3, 5], [2, 4, 6])
    const before = seen.points
    await page.locator('.stylemap-custom-apply').click()
    // The first answer is for other points than the ones on screen: the map is asked for once more, then it is laid out.
    await expect.poll(() => dotAt(page, 1)).toEqual(moved(1).map((v) => Math.round(v * 1000) / 1000))
    expect(seen.points).toBe(before + 1)
    expect(seen.posts).toHaveLength(2)
    await expect(page.locator('.stylemap-custom-note[data-tone="ok"]')).toHaveText(WORDS.en.applied)
    // A refresh of the same map (coming back to the page): the custom layout is used again without a request.
    await page.evaluate(() => (window as any).StyleMap.refresh())
    await expect.poll(() => seen.points).toBe(before + 2)
    expect(await dotAt(page, 1)).toEqual(moved(1).map((v) => Math.round(v * 1000) / 1000))
    expect(seen.posts).toHaveLength(2)
  })

  test('a dropped picture cannot be marked under custom axes and says so (L2)', async ({ page }) => {
    await mockAll(page)
    await page.route('**/api/style-map/query**', (route) => route.fulfill({ json: {
      status: 'ok', query: { x: 0.1, y: 0.05, z: -0.1 },
      neighbors: [{ id: 3, score: 0.9, filename: 'a.png', weak: false, in_filter: true, located: true, merged: false, x: original(3)[0], y: original(3)[1], z: original(3)[2] }],
      weak_threshold: 0.32, model_version: 'kaloscope:test',
    } }))
    await openMap(page, 1366, 768, 'en')
    await openCustomTab(page, WORDS.en)
    await define(page, 'x', [1, 3, 5], [2, 4, 6])
    await page.locator('.stylemap-custom-apply').click()
    await expect.poll(() => dotAt(page, 1)).toEqual(moved(1).map((v) => Math.round(v * 1000) / 1000))
    await page.locator('#stylemap-near-file').setInputFiles({ name: 'drop.png', mimeType: 'image/png', buffer: colorPng(100, 100, 100) })
    await expect(page.locator('#stylemap-near-note')).toHaveText(WORDS.en.nearNote)
    // The neighbour (a dot) is ringed at its NEW position; the estimate is not drawn.
    const rings = await page.evaluate(() => (window as any).StyleMap._state.scene.rings.describe().map((r: any) => `${r.kind}:${r.visible}`))
    expect(rings.filter((r: string) => r.startsWith('query') && r.endsWith('true'))).toHaveLength(0)
    expect(rings.filter((r: string) => r.startsWith('near') && r.endsWith('true'))).toHaveLength(1)
  })

  test('Esc closes the card from the custom tab and a name field keeps its caret while typing', async ({ page }) => {
    await mockAll(page)
    await openMap(page, 1366, 768, 'en')
    await openCustomTab(page, WORDS.en)
    await page.locator('.stylemap-custom-open[data-axis="z"]').click()
    const input = page.locator('.stylemap-custom-axis[data-axis="z"] [data-end="b"] .stylemap-custom-name')
    await input.click()
    await input.pressSequentially('abcdef')
    await expect(input).toHaveValue('abcdef')
    await page.keyboard.press('Escape') // in a text field: the field keeps Esc
    await input.blur()
    await page.keyboard.press('Escape')
    await expect(page.locator('#stylemap-axes-panel')).toBeHidden()
  })
})
