import path from 'node:path'

import { expect, test, type Page, type Route } from '@playwright/test'

import { cleanupImages, openLibrary, pageOverflow, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 find similar: search by meaning in the query bar, search by an image
 * (picked or dropped), find similar / near-duplicates from the card menu and
 * the card, compare two picks, the duplicate review in the library status,
 * and the similarity index and duplicate scan as jobs.
 *
 * CLIP never runs here: the similarity, model and Recycle Bin endpoints are
 * stubbed; the gallery rows come from the real backend (POST /api/images/by-ids).
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4simtoken'
const PREFIX = 'v4sim-'
const COUNT = 6
const DIR = 'v4-sim'

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

const name = (i: number) => `${PREFIX}0${i}.png`
const file = (i: number) => path.join(tmpRoot, DIR, name(i))

/**
 * Seeded ids in gallery order (newest first: v4sim-00 … v4sim-05), read before the
 * page opens: the library status asks for the index and the duplicates as it loads,
 * so every stub must be in place first.
 */
async function idsOf(page: Page): Promise<number[]> {
  const res = await page.request.get('/api/images', {
    params: { search: TOKEN, sort_by: 'newest', limit: 20 },
    headers: { 'X-SD-Library-Id': 'main' },
  })
  const body = (await res.json()) as { images: { id: number; filename: string }[] }
  expect(body.images.map((i) => i.filename)).toEqual([...Array(COUNT).keys()].map(name))
  return body.images.map((i) => i.id)
}

const json = (route: Route, body: unknown) => route.fulfill({ json: body })

async function stubStats(page: Page, embedded = COUNT, pending = 0) {
  await page.route('**/api/similarity/stats', (r) =>
    json(r, { total_images: embedded + pending, embedded_count: embedded, pending_count: pending, unreadable_count: 0 }),
  )
}

/** CLIP on disk (ready) or not; a prepare starts a download that finishes on the second poll. */
async function stubClip(page: Page, ready: boolean) {
  const prepared: unknown[] = []
  let polls = 0
  await page.route('**/api/models/status', (r) => json(r, { models: [{ id: 'clip', status: ready ? 'ready' : 'missing', available: ready }] }))
  await page.route('**/api/models/prepare', (r) => {
    prepared.push(r.request().postDataJSON())
    return json(r, { status: 'started', model_id: 'clip' })
  })
  await page.route('**/api/models/download-progress', (r) => {
    polls += 1
    return json(
      r,
      polls < 2
        ? { active: true, downloaded: 50, total: 100, filename: 'model.onnx' }
        : { active: false, prepare_result: { model_id: 'clip', status: 'ready', active: false } },
    )
  })
  return prepared
}

const tileIds = (page: Page) => page.getByTestId('tile').evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-id'))))

for (const viewport of VIEWPORTS) {
  test(`ranked results, compare and duplicates fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      const ids = await idsOf(page)
      await stubClip(page, true)
      await stubStats(page)
      await page.route('**/api/similarity/search-text', (r) => json(r, { results: ids.map((id, i) => ({ id, similarity: 0.3 - i * 0.01 })), has_more: false }))
      await page.route('**/api/similarity/compare?**', (r) => json(r, { similarity: 0.5 }))
      await page.route('**/api/duplicates/groups?**', (r) =>
        json(r, {
          available: true,
          scanned_at: 1790000000,
          summary: { group_count: 1, redundant_count: 2, reclaimable_bytes: 3000, threshold: 0.95, embedded_count: COUNT },
          groups: [{ group_id: 0, similarity: 0.97, members: ids.slice(0, 3).map((id, i) => ({ id, path: file(i), filename: name(i), width: 64, height: 96, file_size: 1000, aesthetic_score: null, user_rating: 0, suggested_keep: i === 0 })) }],
          total_groups: 1,
          offset: 0,
          limit: 30,
          has_more: false,
        }),
      )

      await openLibrary(page, TOKEN, COUNT, theme)
      await page.getByTestId('semantic-toggle').click()
      await page.getByTestId('semantic-input').fill('a quiet street')
      await page.getByTestId('semantic-input').press('Enter')
      await expect(page.getByTestId('similar-banner')).toBeInViewport({ ratio: 1 })
      await expect(page.getByTestId('similar-back')).toBeInViewport({ ratio: 1 })
      await expect(page.getByTestId('tile-score').first()).toBeVisible()
      for (const id of ['semantic-toggle', 'search-by-image', 'filter-button']) await expect(page.getByTestId(id)).toBeInViewport()
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)

      const tiles = page.getByTestId('tile')
      await tiles.nth(0).click({ modifiers: ['Control'] })
      await tiles.nth(1).click({ modifiers: ['Control'] })
      await page.keyboard.press('Control+k')
      await page.keyboard.type('compare')
      await page.keyboard.press('Enter')
      const compare = page.getByTestId('compare-dialog')
      await expect(compare).toBeInViewport()
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')

      await page.getByTestId('library-status').getByRole('button', { name: 'Review…' }).click()
      const dups = page.getByTestId('duplicates-dialog')
      await expect(dups).toBeInViewport()
      await expect(dups.getByTestId('duplicate-group')).toHaveCount(1)
      await expect(dups.getByTestId('duplicates-trash-others')).toBeInViewport()
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
      await page.getByTestId('semantic-toggle').click()
    }
  })
}

test('by meaning: the query bar ranks the library by a sentence; Esc goes back to the filter', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const ids = await idsOf(page)
  await stubClip(page, true)
  await stubStats(page)
  const sent: unknown[] = []
  await page.route('**/api/similarity/search-text', (r) => {
    sent.push(r.request().postDataJSON())
    return json(r, {
      results: [
        { id: ids[3], similarity: 0.31 },
        { id: ids[1], similarity: 0.27 },
        { id: 999999, similarity: 0.25 },
        { id: ids[5], similarity: 0.22 },
      ],
      has_more: false,
    })
  })

  await openLibrary(page, TOKEN, COUNT)
  await page.getByTestId('semantic-toggle').click()
  await expect(page.getByTestId('semantic-toggle')).toHaveAttribute('aria-pressed', 'true')
  const input = page.getByTestId('semantic-input')
  await expect(input).toBeFocused()
  await input.fill('a girl smiling')
  await input.press('Enter')

  const banner = page.getByTestId('similar-banner')
  await expect(banner).toContainText('By meaning: "a girl smiling"')
  // an id the library no longer has drops out; the ranking stays
  await expect(banner).toContainText('3 images')
  await expect.poll(() => tileIds(page)).toEqual([ids[3], ids[1], ids[5]])
  await expect(page.getByTestId('tile-score').first()).toHaveText('31%')
  expect(sent[0]).toEqual({ query: 'a girl smiling', limit: 100, offset: 0, threshold: 0 })

  // the picks and the lightbox work on the ranked images
  await page.getByTestId('tile').first().dblclick()
  await expect(page.getByTestId('lightbox')).toContainText(name(3))
  await page.keyboard.press('Escape')

  // with nothing picked and no field in use, Esc leaves the ranking
  await banner.locator('strong').click()
  await page.keyboard.press('Escape')
  await expect(banner).toHaveCount(0)
  await expect(page.getByTestId('result-count')).toHaveText(`${COUNT} images`)

  await page.getByTestId('semantic-toggle').click()
  await expect(page.getByTestId('query-input')).toHaveValue(TOKEN)
})

test('first use downloads CLIP as a job in the drawer, then the search runs', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const ids = await idsOf(page)
  const prepared = await stubClip(page, false)
  await stubStats(page)
  let searched = 0
  await page.route('**/api/similarity/search-text', (r) => {
    searched += 1
    return json(r, { results: [{ id: ids[0], similarity: 0.3 }], has_more: false })
  })

  await openLibrary(page, TOKEN, COUNT)
  await page.getByTestId('semantic-toggle').click()
  await page.getByTestId('semantic-input').fill('sunset')
  await page.getByTestId('semantic-input').press('Enter')
  await expect.poll(() => prepared.length).toBe(1)
  expect(prepared[0]).toMatchObject({ model_id: 'clip' })
  expect(searched).toBe(0)
  await expect(page.getByTestId('jobs-button')).toBeVisible()
  // when the download is done, the search it waited for runs
  await expect(page.getByTestId('similar-banner')).toContainText('By meaning: "sunset"', { timeout: 15_000 })
  expect(searched).toBe(1)
})

test('search by image: pick a file, or drop one on the query bar (the import dialog stays away)', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const ids = await idsOf(page)
  await stubClip(page, true)
  await stubStats(page)
  const uploads: string[] = []
  await page.route('**/api/similarity/search-upload?**', (r) => {
    uploads.push(r.request().headers()['content-type'] ?? '')
    return json(r, { results: [{ id: ids[2], similarity: 0.93 }, { id: ids[0], similarity: 0.5 }], has_more: false })
  })

  await openLibrary(page, TOKEN, COUNT)
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('search-by-image').click()
  await (await chooser).setFiles(file(4))
  const banner = page.getByTestId('similar-banner')
  await expect(banner).toContainText(`Similar to ${name(4)}`)
  await expect.poll(() => tileIds(page)).toEqual([ids[2], ids[0]])
  expect(uploads[0]).toContain('multipart/form-data')
  await page.getByTestId('similar-back').click()
  await expect(banner).toHaveCount(0)

  // drag a file over the query bar: its own hint, not the import overlay; the drop searches
  const id = ids[1]
  await page.evaluate(async (imageId) => {
    const blob = await (await fetch(`/api/image-file/${imageId}`)).blob()
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'dropped.png', { type: 'image/png' }))
    const bar = document.querySelector('[data-testid="query-bar"]')!
    const fire = (type: string) => bar.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    fire('dragenter')
    fire('dragover')
    ;(window as unknown as { __fireDrop: () => void }).__fireDrop = () => fire('drop')
  }, id)
  await expect(page.getByText('Drop to find images like this one')).toBeVisible()
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { __fireDrop: () => void }).__fireDrop())
  await expect(banner).toContainText('Similar to dropped.png')
  expect(uploads).toHaveLength(2)
  await expect(page.getByTestId('drop-dialog')).toHaveCount(0)
})

test('find similar and near-duplicates from the card menu, the card and Ctrl K', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const ids = await idsOf(page)
  await stubStats(page)
  const asked: string[] = []
  await page.route('**/api/similarity/near/**', (r) => {
    asked.push(r.request().url())
    return json(r, {
      results: [
        { id: ids[4], similarity: 0.96 },
        { id: ids[2], similarity: 0.91 },
        { id: ids[5], similarity: 0.6 },
      ],
    })
  })
  await openLibrary(page, TOKEN, COUNT)
  const tiles = page.getByTestId('tile')
  const menu = page.getByTestId('card-menu')
  const banner = page.getByTestId('similar-banner')

  await tiles.nth(0).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Find similar' }).click()
  await expect(banner).toContainText(`Similar to ${name(0)}`)
  await expect.poll(() => tileIds(page)).toEqual([ids[4], ids[2], ids[5]])
  await expect(page.getByTestId('tile-score').first()).toHaveAttribute('data-near', 'true')
  expect(asked[0]).toContain(`/api/similarity/near/${ids[0]}?limit=200`)
  await page.keyboard.press('Escape')
  await expect(banner).toHaveCount(0)

  // near-duplicates: only 90% and up
  await tiles.nth(0).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Find near-duplicates' }).click()
  await expect(banner).toContainText('Near-duplicates of')
  await expect.poll(() => tileIds(page)).toEqual([ids[4], ids[2]])
  await page.getByTestId('similar-back').click()

  // from the generation card
  await tiles.nth(1).click()
  await page.getByTestId('generation-card').getByTestId('card-find-similar').click()
  await expect(banner).toContainText(`Similar to ${name(1)}`)
  await page.getByTestId('similar-back').click()

  // and from Ctrl K, for the inspected image
  await page.keyboard.press('Control+k')
  await page.keyboard.type('images similar to this')
  await page.keyboard.press('Enter')
  await expect(banner).toContainText(`Similar to ${name(1)}`)
})

test('compare two picks: CLIP likeness, the parameters and tags that differ', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const ids = await idsOf(page)
  await stubStats(page)
  let compared = ''
  await page.route('**/api/similarity/compare?**', (r) => {
    compared = r.request().url()
    return json(r, { id_a: ids[0], id_b: ids[1], similarity: 0.8731 })
  })
  await openLibrary(page, TOKEN, COUNT)
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await tiles.nth(1).click({ modifiers: ['Control'] })

  await page.keyboard.press('Control+k')
  await page.keyboard.type('compare')
  await page.keyboard.press('Enter')
  const dialog = page.getByTestId('compare-dialog')
  await expect(dialog.getByTestId('compare-clip')).toHaveText('CLIP similarity 87%')
  expect(compared).toContain(`id_a=${ids[0]}`)
  expect(compared).toContain(`id_b=${ids[1]}`)
  // the seeds differ in shape (64×96 vs 96×64) and in "frame n"; SEED, steps and CFG are the same
  const params = dialog.getByTestId('compare-params')
  await expect(params.getByRole('row', { name: /Size/ })).toContainText('64×96')
  await expect(params.getByRole('row', { name: /Size/ })).toContainText('96×64')
  await expect(params.getByRole('row', { name: /SEED/ })).toHaveCount(0)
  await dialog.getByRole('button', { name: /Also show the \d+ that are the same/ }).click()
  await expect(params.getByRole('row', { name: /SEED/ })).toContainText('424242')
  const promptTags = dialog.getByTestId('compare-prompt-tags')
  await expect(promptTags).toContainText(`Only in ${name(0)}`)
  await expect(promptTags).toContainText('frame 0')
  await expect(promptTags).toContainText('frame 1')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // the same action sits in the right-click menu and under More, only for exactly two
  await tiles.nth(1).click({ button: 'right' })
  await expect(page.getByTestId('card-menu').locator('[data-item="compare"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await tiles.nth(2).click({ modifiers: ['Control'] })
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('menu').locator('[data-item="compare"]')).toHaveCount(0)
})

test('duplicates: the status offers the review; keep one, the rest go to Trash after the confirm', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const ids = await idsOf(page)
  await stubStats(page)
  const member = (i: number) => ({ id: ids[i], path: file(i), filename: name(i), width: 64, height: 96, file_size: 1000 + i, aesthetic_score: null, user_rating: 0, suggested_keep: i === 0 })
  await page.route('**/api/duplicates/groups?**', (r) =>
    json(r, {
      available: true,
      scanned_at: 1790000000,
      summary: { group_count: 1, redundant_count: 2, reclaimable_bytes: 2003, threshold: 0.95, embedded_count: COUNT },
      // 999999 was removed since the scan: it must not show or be sent
      groups: [{ group_id: 0, similarity: 0.97, members: [member(0), member(1), member(2), { ...member(3), id: 999999 }] }],
      total_groups: 1,
      offset: 0,
      limit: 30,
      has_more: false,
    }),
  )
  let trashed: { image_ids: number[]; confirm_delete_files: boolean } | null = null
  await page.route('**/api/images/delete-selected/start', (r) => {
    trashed = r.request().postDataJSON()
    return json(r, { status: 'started', total: 2, operation: 'delete' })
  })
  // idle until our job starts, so the start-up check finds nothing running
  await page.route('**/api/images/delete-selected/progress', (r) =>
    json(r, trashed ? { status: 'running', current: 0, total: 2, deleted: 0, errors: 0, failed: [] } : { status: 'idle', current: 0, total: 0 }),
  )

  await openLibrary(page, TOKEN, COUNT)
  const status = page.getByTestId('library-status')
  await expect(status).toContainText('Duplicate groups: 1')
  await status.getByRole('button', { name: 'Review…' }).click()
  const dialog = page.getByTestId('duplicates-dialog')
  await expect(dialog.getByTestId('duplicates-coverage')).toContainText(`${COUNT} of ${COUNT} images are in the index`)
  const group = dialog.getByTestId('duplicate-group')
  await expect(group.getByTestId('duplicate-keep')).toHaveCount(3)
  await expect(group.locator(`[data-testid="duplicate-keep"][data-id="${ids[0]}"]`)).toBeChecked()

  // keep the second one instead
  await group.locator(`[data-testid="duplicate-keep"][data-id="${ids[1]}"]`).check()
  const trashOthers = group.getByTestId('duplicates-trash-others')
  await expect(trashOthers).toHaveText('Move the other 2 to Trash…')
  await trashOthers.click()
  const confirm = page.getByTestId('confirm-dialog')
  await expect(confirm).toBeVisible()
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await confirm.getByRole('button', { name: 'Move 2 to Trash' }).click()
  await expect.poll(() => trashed?.image_ids.slice().sort()).toEqual([ids[0], ids[2]].sort())
  expect(trashed!.confirm_delete_files).toBe(true)
})

test('the similarity index and the duplicate scan run as jobs', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const ids = await idsOf(page)
  await stubClip(page, true)
  let pending = 2
  await page.route('**/api/similarity/stats', (r) =>
    json(r, { total_images: COUNT, embedded_count: COUNT - pending, pending_count: pending, unreadable_count: 0 }),
  )
  let embedPolls = 0
  let embedding = false
  await page.route('**/api/similarity/embed', (r) => {
    embedding = true
    return json(r, { status: 'started' })
  })
  await page.route('**/api/similarity/progress', (r) => {
    // idle until the build starts, so the start-up check finds nothing running
    if (!embedding) return json(r, { running: false, step: 'idle', total: 0 })
    embedPolls += 1
    if (embedPolls >= 2) pending = 0
    return json(
      r,
      embedPolls < 2
        ? { running: true, step: 'embedding', total: 2, processed: 1, embedded: 1, errors: 0 }
        : { running: false, step: 'done', total: 2, processed: 2, embedded: 2, errors: 0 },
    )
  })
  let scanned = false
  let scanBody: unknown = null
  let bulkPolls = 0
  await page.route('**/api/duplicates/scan', (r) => {
    scanBody = r.request().postDataJSON()
    return json(r, { job_id: 'dup-job-1', threshold: 0.95 })
  })
  await page.route('**/api/bulk-jobs/dup-job-1', (r) => {
    bulkPolls += 1
    if (bulkPolls >= 2) scanned = true
    return json(r, { job_id: 'dup-job-1', status: bulkPolls < 2 ? 'running' : 'done', processed: bulkPolls < 2 ? 40 : 100, total: 100, message: '' })
  })
  await page.route('**/api/duplicates/groups?**', (r) =>
    json(
      r,
      scanned
        ? {
            available: true,
            scanned_at: 1790000000,
            summary: { group_count: 1, redundant_count: 1, reclaimable_bytes: 1000, threshold: 0.95, embedded_count: COUNT },
            groups: [{ group_id: 0, similarity: 0.99, members: [0, 1].map((i) => ({ id: ids[i], path: file(i), filename: name(i), width: 64, height: 96, file_size: 1000, aesthetic_score: null, user_rating: 0, suggested_keep: i === 0 })) }],
            total_groups: 1,
            offset: 0,
            limit: 30,
            has_more: false,
          }
        : { available: false, summary: null, groups: [], total_groups: 0, offset: 0, limit: 30, has_more: false },
    ),
  )

  // the index fell behind: the status says so and builds it as a job
  await openLibrary(page, TOKEN, COUNT)
  const status = page.getByTestId('library-status')
  await expect(status).toContainText('2 images not in the similarity index')
  await status.getByRole('button', { name: 'Build the index' }).click()
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer').getByTestId('job').first()).toContainText('Added 2 images to the similarity index')
  await page.keyboard.press('Escape')
  await expect(status).not.toContainText('not in the similarity index')

  // no scan yet: the review says so, and scanning is a job too
  await page.keyboard.press('Control+k')
  await page.keyboard.type('duplicate')
  await page.keyboard.press('Enter')
  const dialog = page.getByTestId('duplicates-dialog')
  await expect(dialog).toContainText('No duplicate scan yet')
  await dialog.getByTestId('duplicates-scan').click()
  await expect.poll(() => scanBody).toEqual({ threshold: 0.95 })
  await expect(dialog.getByTestId('duplicate-group')).toHaveCount(1, { timeout: 10_000 })
  await expect(dialog.getByTestId('duplicates-scan')).toHaveText('Scan again')
})
