import { expect, test, type Page } from '../fixtures/click-ledger'
import { StyleMapPage } from '../pages/StyleMapPage'

/**
 * Style Map in the CSD space (S5) against mocked /api/style-map/*. The scripted
 * answers carry space "csd"; what is under test is the page: the space is
 * selectable, the index job (no Style Finder model settings), the empty start
 * card, colours and the dropped-picture query all name the csd space, a failed
 * job says why, and the Model Center card of the optional model.
 */

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const MAP_ID = 'c5d0c5d0c5d0c5d0c5d0c5d0c5d0c5d0'
const UMAP_PARAMS = { n_neighbors: 15, min_dist: 0.1, metric: 'cosine', input_dim: 64, random_state: 0 }
const CSD_VERSION = 'csd:vit-l-14:40e92fad63a3'

function pointsBody(space: string, overrides: Record<string, unknown> = {}) {
  const points = Array.from({ length: 30 }, (_, i) => [i + 1, (i % 5) / 4 - 0.5, (i % 7) / 6 - 0.5, (i % 3) / 2 - 0.5, 1])
  return {
    status: 'ok', space, method: 'pca', model_version: space === 'csd' ? CSD_VERSION : 'kaloscope:test',
    total_images: 30, missing_vectors: 0, unlocatable: [], merged_away: 0,
    explained_variance: [0.1, 0.07, 0.05], points_layout: ['id', 'x', 'y', 'z', 'members'], points,
    umap: { status: 'unavailable', points: 30, min_points: 21, params: UMAP_PARAMS, install: { model_id: 'style-map-umap', packages: ['umap-learn>=0.5.12'] } },
    map_id: MAP_ID, cached: false, ...overrides,
  }
}

const emptyCsd = () => pointsBody('csd', { status: 'no_vectors', points: [], missing_vectors: 30, umap: { status: 'too_few_points', points: 0, min_points: 21, params: UMAP_PARAMS } })

interface Mocks {
  starts: any[]
  points: string[]
  colors: string[]
  queries: string[]
  failure: string | null
}

async function mockCsd(page: Page, { indexed, failure = null }: { indexed: boolean; failure?: string | null }): Promise<Mocks> {
  const seen: Mocks = { starts: [], points: [], colors: [], queries: [], failure }
  let built = indexed
  let polls = 0
  await page.route('**/api/images/selection-token', (route) => route.fulfill({ json: { selection_token: 'tok.e2e', total_estimate: 30 } }))
  await page.route('**/api/style-map/vectors/progress', (route) => {
    if (seen.starts.length > 0 && seen.failure) {
      return route.fulfill({ json: { running: false, paused: false, total: 30, processed: 0, written: 0, kept: 0, errors: 0, step: 'error', message: seen.failure, recent_issues: [] } })
    }
    if (seen.starts.length > 0) {
      polls += 1
      const running = polls < 4
      if (!running) built = true
      return route.fulfill({ json: { running, paused: false, total: 30, processed: running ? polls * 8 : 30, written: running ? polls * 8 : 30, kept: 0, errors: 0, step: running ? 'extracting' : 'done', message: '', recent_issues: [] } })
    }
    return route.fulfill({ json: { running: false, paused: false, total: 0, processed: 0, written: 0, kept: 0, errors: 0, step: 'idle', message: '', recent_issues: [] } })
  })
  await page.route('**/api/style-map/vectors/start', (route) => {
    seen.starts.push(route.request().postDataJSON())
    return route.fulfill({ json: { status: 'started', total: 30, space: 'csd' } })
  })
  await page.route('**/api/style-map/points**', (route) => {
    const url = new URL(route.request().url())
    seen.points.push(url.search)
    const space = url.searchParams.get('space') || 'kaloscope'
    if (space === 'csd') return route.fulfill({ json: built ? pointsBody('csd') : emptyCsd() })
    return route.fulfill({ json: pointsBody('kaloscope') })
  })
  await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: { status: 'ok', space: 'csd', method: 'pca', regions: [], cached: false } }))
  await page.route('**/api/style-map/colors**', (route) => {
    const url = new URL(route.request().url())
    seen.colors.push(url.search)
    return route.fulfill({ json: { status: 'ok', space: url.searchParams.get('space'), by: 'generator', kind: 'category', ids: Array.from({ length: 30 }, (_, i) => i + 1), values: new Array(30).fill(0), legend: [{ key: 'nai', label: 'nai', count: 30 }], range: null, missing: 0 } })
  })
  await page.route('**/api/style-map/query**', (route) => {
    seen.queries.push(route.request().url())
    return route.fulfill({ json: {
      status: 'ok', query: { x: 0.1, y: 0.05, z: -0.1 }, weak_threshold: 0.65, model_version: CSD_VERSION,
      neighbors: [3, 7, 12].map((id, i) => ({ id, score: 0.9 - i * 0.1, filename: `csd_${id}.png`, weak: false, in_filter: true, located: true, merged: false, x: (id % 5) / 4 - 0.5, y: (id % 7) / 6 - 0.5, z: (id % 3) / 2 - 0.5 })),
    } })
  })
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }))
  return seen
}

async function openCsd(page: Page, width: number, height: number, lang = 'en') {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.evaluate((code) => localStorage.setItem('sd-image-sorter-lang', code), lang)
  await page.reload()
  const map = new StyleMapPage(page)
  await map.open()
  await expect.poll(() => map.pointCount()).toBe(30)
  await map.spaceSelect.selectOption('csd')
  return map
}

test.describe('Style Map CSD space', () => {
  for (const [width, height, lang] of [[1366, 768, 'en'], [1920, 1080, 'zh-CN'], [2560, 1440, 'en']] as const) {
    test(`offers CSD, builds its index and shows the CSD map at ${width}x${height} (${lang})`, async ({ page }) => {
      const seen = await mockCsd(page, { indexed: false })
      const consoleErrors: string[] = []
      page.on('pageerror', (error) => consoleErrors.push(String(error)))
      const map = await openCsd(page, width, height, lang)

      await expect(map.spaceSelect.locator('option[value="csd"]')).toBeEnabled()
      await expect(map.spaceSelect.locator('option[value="csd"]')).toHaveText(lang === 'en' ? 'CSD style descriptors (optional)' : 'CSD 画风描述（可选）')
      // No index yet: the start card names the CSD index and the one primary is its button.
      await expect(map.emptyCard).toBeVisible()
      await expect(map.emptyBuildButton).toHaveText(lang === 'en' ? 'Build CSD index' : '建立 CSD 索引')
      await expect(page.locator('#stylemap-empty-title')).toHaveText(lang === 'en' ? 'Build the CSD index first' : '先建立 CSD 索引')
      await expect(page.locator('#stylemap-empty-similar')).toBeHidden()
      await expect(map.buildButton).toBeHidden()
      await expect(page.locator('#view-stylemap .btn-primary:visible')).toHaveCount(1)
      const csdPoints = seen.points.filter((search) => search.includes('space=csd'))
      expect(csdPoints.length).toBeGreaterThan(0)
      // CSD has one pinned model: no Style Finder model settings ride along.
      expect(csdPoints[0]).not.toContain('model_source')
      expect(csdPoints[0]).not.toContain('model_path')

      await map.emptyBuildButton.click()
      await expect.poll(() => seen.starts.length).toBe(1)
      expect(seen.starts[0].space).toBe('csd')
      expect(seen.starts[0].selection_token).toBe('tok.e2e')
      await expect(map.progressRow).toBeVisible()
      await expect(map.progressRow).toHaveAttribute('data-state', 'done', { timeout: 15000 })
      await expect.poll(() => map.pointCount(), { timeout: 10000 }).toBe(30)
      await expect(map.emptyCard).toBeHidden()
      // Nothing left to build: the toolbar offers the refresh, worded for CSD.
      await expect(map.buildButton).toHaveText(lang === 'en' ? 'Refresh CSD index' : '更新 CSD 索引')

      // Dot colours are read for the CSD map.
      await map.colorBySelect.selectOption('folder')
      await expect.poll(() => seen.colors.some((search) => search.includes('space=csd') && search.includes('by=folder'))).toBe(true)

      const layout = await page.evaluate(() => ({
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
        toolbarWraps: (document.querySelector('.stylemap-toolbar') as HTMLElement).getBoundingClientRect().height > 120,
      }))
      expect(layout.pageOverflow).toBe(false)
      expect(layout.toolbarWraps).toBe(false)
      expect(consoleErrors).toEqual([])
    })
  }

  test('a dropped picture asks the csd space about the map on screen', async ({ page }) => {
    const seen = await mockCsd(page, { indexed: true })
    const map = await openCsd(page, 1920, 1080)
    await expect(map.emptyCard).toBeHidden()
    await page.locator('#stylemap-near-file').setInputFiles({ name: 'drop.png', mimeType: 'image/png', buffer: PNG_1PX })
    await expect(page.locator('.stylemap-near-row')).toHaveCount(4) // the query row + 3 neighbours
    const url = new URL(seen.queries[0])
    expect(url.searchParams.get('space')).toBe('csd')
    expect(url.searchParams.get('map_id')).toBe(MAP_ID)
    expect(url.searchParams.has('model_source')).toBe(false)
  })

  test('a job that fails as a whole says why instead of "Done: 0 pictures added"', async ({ page }) => {
    await mockCsd(page, { indexed: false, failure: 'Style vector extraction failed: CSD is not prepared: click Prepare / Download for CSD in the Model Center.' })
    const map = await openCsd(page, 1920, 1080)
    await map.emptyBuildButton.click()
    await expect(page.locator('.toast').filter({ hasText: 'CSD is not prepared' })).toBeVisible()
    await expect(page.locator('.toast').filter({ hasText: /Done|完成/ })).toHaveCount(0)
  })

  test('the Model Center lists CSD as an optional model with licence, size and source', async ({ page }) => {
    await page.route('**/api/models/status', async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      body.models = [...(body.models ?? []).filter((card: any) => card.id !== 'csd'), {
        id: 'csd', name: 'CSD Style Descriptors (optional)', name_key: 'models.csd.name', group: 'Artist ID', group_key: 'models.group.artistId',
        available: false, status: 'missing', status_label: 'Missing', message_key: 'models.csd.missing',
        message: 'Optional, not downloaded yet', path: '', download_supported: true,
        external_links: [{ label: 'Model', url: 'https://huggingface.co/tomg-group-umd/CSD-ViT-L' }],
        setup_steps: ['Click Prepare / Download'],
      }]
      await route.fulfill({ response, json: body })
    })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    await page.evaluate(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
    await page.reload()
    await page.locator('#btn-open-model-manager').click()
    await expect(page.locator('#model-manager-modal')).toBeVisible()
    await page.locator('[data-settings-tab="models"]').click()
    const card = page.locator('.model-card[data-model-id="csd"]')
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card.locator('.model-card-title')).toHaveText('CSD 画风描述（可选）')
    await expect(card.locator('.model-card-message')).toContainText('CC-BY-4.0')
    await expect(card.locator('.model-card-message')).toContainText('2.44 GB')
    await expect(card.locator('.btn-prepare-model')).toBeVisible()
    await expect(card.locator('a[href*="tomg-group-umd/CSD-ViT-L"]')).toBeVisible()
  })
})
