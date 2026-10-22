import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type APIRequestContext, type Page } from '../fixtures/click-ledger'
import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, repoRoot, seedImages } from '../fixtures/v4-seed'

/**
 * Feature entrances in a real browser (owner, 2026-10-23, M203). The classic
 * interface is the baseline: every classic entrance in docs/feature-entrances.json
 * is on the page. Every entrance Vopus and /next/ claim to have is found where
 * the registry says, after the clicks it lists; what they have not ported yet
 * is listed (annotation "not ported"), not failed. The static half is
 * backend/tests/test_feature_entrances.py.
 *
 * Entrances that need state this spec does not build (a running sort session,
 * missing files, a running job...) are checked in the source only by the static
 * test and listed here as "needs state".
 *
 * Needs the frontend-v4 build: `cd frontend-v4 && npm run build`.
 */

type Entrance = {
  at?: string
  open?: string[]
  find?: string
  needs?: string
  palette?: string
  then_find?: string
  missing?: string
  partial?: string
}
type Feature = { id: string; en: string; classic: string[]; vopus: Entrance; next: Entrance }

const REGISTRY = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs', 'feature-entrances.json'), 'utf8')) as {
  features: Feature[]
}
const TOKEN = 'featentrancetoken'
const PREFIX = 'featentrance-'
const DIR = 'feature-entrances'
/** State this spec builds before looking for an entrance. */
const BUILT_NEEDS = new Set(['', 'one pick', 'picks', 'image', 'opened image', 'batch'])


test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: 4, dir: DIR }))
/** Remove this spec's batches, also ones an interrupted run left behind. */
async function deleteOwnBatches(request: APIRequestContext): Promise<void> {
  const listed = (await (await request.get('/api/batches')).json()) as {
    batches: { id: number; name: string; project_revision?: number | null }[]
  }
  for (const batch of listed.batches.filter((b) => b.name.startsWith(PREFIX))) {
    const revision = batch.project_revision ? `?expected_project_revision=${batch.project_revision}` : ''
    const res = await request.delete(`/api/batches/${batch.id}${revision}`)
    expect(res.ok(), `delete batch ${batch.id}`).toBe(true)
  }
}

test.afterAll(async ({ request }) => {
  await deleteOwnBatches(request)
  cleanupImages(PREFIX, [DIR])
})
test.beforeEach(async ({ page }) => {
  await markModelsReady(page)
  await page.setViewportSize({ width: 1920, height: 1080 })
})

test('classic: every baseline entrance is on the page', async ({ page }) => {
  await openFresh(page, '/?ui=classic')
  await expect(page.locator('#view-gallery')).toBeAttached()
  const gone: string[] = []
  for (const feature of REGISTRY.features) {
    for (const selector of feature.classic) {
      if ((await page.locator(selector).count()) === 0) gone.push(`${feature.id}: ${selector}`)
    }
  }
  expect(gone, 'classic entrances missing from the page').toEqual([])
})

/** A dataset and a Pixiv batch of the seeded images: batch steps are looked for in them. */
async function makeBatches(request: APIRequestContext): Promise<number[]> {
  const found = await request.get(`/api/images?search=${TOKEN}&limit=10`)
  expect(found.ok()).toBe(true)
  const imageIds = ((await found.json()) as { images: { id: number }[] }).images.map((image) => image.id)
  expect(imageIds.length).toBeGreaterThanOrEqual(3)
  await deleteOwnBatches(request)
  const ids: number[] = []
  for (const kind of ['dataset', 'pixiv'] as const) {
    const created = await request.post('/api/batches', { data: { kind, name: `${PREFIX}${kind}`, image_ids: imageIds } })
    expect(created.status()).toBe(201)
    ids.push(((await created.json()) as { batch: { id: number } }).batch.id)
  }
  return ids
}

/**
 * A new document with fresh storage every time: a hash change alone keeps the
 * last page's state, and a click made while looking for one entrance (a mode,
 * a folded section) must not hide the next one.
 */
async function openFresh(page: Page, url: string): Promise<void> {
  await page.goto('/api/batches')
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.setItem('sd-v4-update-autocheck', '0')
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' }))
  })
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' })
  if (res) expect(res.status(), `${url}: the frontend-v4 build is missing (npm run build)`).toBe(200)
}

const LIBRARY_HASH = { vopus: '#/library', next: '#/' } as const

/** Open the entrance's page with the state it needs; false when that state could not be built. */
async function prepare(page: Page, ui: 'vopus' | 'next', entrance: Entrance, batch: number): Promise<boolean> {
  const inBatch = entrance.needs === 'batch' && (entrance.at ?? '').startsWith('#/batch')
  const at = inBatch ? `#/batch/${batch}` : (entrance.at ?? '#/')
  if (!['one pick', 'picks', 'image', 'opened image'].includes(entrance.needs ?? '')) {
    await openFresh(page, `/${ui}/${at}`)
    return true
  }
  // picks and an inspected image are made in the library, then the page is left by its own address
  await openFresh(page, `/${ui}/${LIBRARY_HASH[ui]}`)
  const tiles = page.getByTestId('tile')
  const shown = await tiles.nth(1).waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
  if (!shown) return false
  if (entrance.needs === 'image') await tiles.first().click()
  else if (entrance.needs === 'opened image') await tiles.first().dblclick()
  else if (entrance.needs === 'one pick') await tiles.first().click({ modifiers: ['Control'] })
  else {
    await tiles.nth(0).click({ modifiers: ['Control'] })
    await tiles.nth(1).click({ modifiers: ['Control'] })
  }
  if (at !== LIBRARY_HASH[ui] && at !== '#/library') await page.evaluate((hash) => (location.hash = hash), at)
  return true
}

/** True when the entrance shows up after the registry's clicks. */
async function entranceIsThere(page: Page, entrance: Entrance): Promise<boolean> {
  for (const selector of entrance.open ?? []) {
    const target = page.locator(selector).first()
    try {
      await target.click({ timeout: 8_000 })
    } catch {
      return false
    }
  }
  if (entrance.palette) {
    await page.keyboard.type(entrance.palette)
    const row = page.locator(entrance.find ?? '[role="option"]').filter({ hasText: entrance.palette }).first()
    if (!(await row.isVisible({ timeout: 5_000 }).catch(() => false))) return false
    if (!entrance.then_find) return true
    await row.click()
    return page.locator(entrance.then_find).first().waitFor({ state: 'attached', timeout: 8_000 }).then(() => true, () => false)
  }
  return page.locator(entrance.find!).first().waitFor({ state: 'attached', timeout: 8_000 }).then(() => true, () => false)
}

for (const ui of ['vopus', 'next'] as const) {
  test(`${ui}: every entrance it claims is there, and what it lacks is listed`, async ({ page, request }) => {
    test.setTimeout(900_000)
    const batchIds = await makeBatches(request)
    const notFound: string[] = []
    const notPorted: string[] = []
    const needsState: string[] = []
    for (const feature of REGISTRY.features) {
      const entrance = feature[ui]
      if (entrance.missing) {
        notPorted.push(`${feature.id}: ${entrance.missing}`)
        continue
      }
      if (entrance.partial) notPorted.push(`${feature.id} (part): ${entrance.partial}`)
      if (!BUILT_NEEDS.has(entrance.needs ?? '')) {
        needsState.push(`${feature.id} (${entrance.needs})`)
        continue
      }
      // a batch step is in one kind of batch or the other: look in both
      const batches = entrance.needs === 'batch' ? batchIds : [0]
      let found = false
      for (const batch of batches) {
        if (!(await prepare(page, ui, entrance, batch))) break
        if (await entranceIsThere(page, entrance)) {
          found = true
          break
        }
      }
      if (!found) notFound.push(`${feature.id} (${feature.en}): ${entrance.find}`)
    }
    test.info().annotations.push(
      { type: 'not ported', description: `${notPorted.length}\n${notPorted.join('\n')}` },
      { type: 'needs state', description: `${needsState.length}\n${needsState.join('\n')}` },
    )
    expect(notFound, `${ui}: entrances the registry claims but the page does not have`).toEqual([])
  })
}
