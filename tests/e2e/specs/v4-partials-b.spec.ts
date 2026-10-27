import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, dbPath, openLibrary, pageOverflow, runBackendScript, scrollToMiddle, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * Three features that were only partly in V Opus (slice `partialsb`), driven
 * like a user in both languages, with the fits-at-W×H check:
 *   1. the tag dialog's blacklist lists (quality, meta, clear);
 *   2. Sort's "leave out pictures that are already sorted" switch, remembered,
 *      with the number it sends to the backend and shows before starting;
 *   3. sorting a batch's queue into groups (rating, aesthetic score,
 *      resolution, saved profiles) in the Order step and the censor strip,
 *      with one Undo.
 * The sorts run against the real backend (real searches, real saved order);
 * only the tagger is stubbed so nothing downloads or runs a model.
 *
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const PREFIX = 'v4pb-'
const TOKEN = 'v4pbtoken'
const COUNT = 6
const DIR = 'v4-pb'
const DEST = 'v4-pb-dest'
const NAME = 'v4pb'
const PROFILES_KEY = 'sd-v4-queue-sort-profiles'

/** The seeded images' ids in file-name order (index 0 first). */
let ids: number[] = []
let orderBatchId = 0

function seed(): number[] {
  const out = runBackendScript(`
import json, sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    rows = cur.execute("SELECT id FROM images WHERE filename LIKE ? ORDER BY filename", (${JSON.stringify(PREFIX + '%')},)).fetchall()
    ids = [r[0] for r in rows if r[0]]
    # size, aesthetic score and rating per image (index 0..5)
    facts = [
        (2048, 1024, 8.2, 'explicit'),
        (800, 600, 6.0, 'general'),
        (1920, 1080, 4.0, 'sensitive'),
        (512, 512, None, 'questionable'),
        (0, 0, 7.0, None),
        (3000, 2000, 5.0, 'general'),
    ]
    for image_id, (w, h, score, rating) in zip(ids, facts):
        cur.execute("UPDATE images SET width = ?, height = ?, aesthetic_score = ?, ai_rating = ?, tagged_at = ? WHERE id = ?", (w or None, h or None, score, rating, "2026-01-01 00:00:00" if rating else None, image_id))
    conn.commit()
print(json.dumps(ids))
`)
  return JSON.parse(out.split(/\r?\n/).at(-1) as string) as number[]
}

/** Mark these images as already sorted (what Auto-Separate or an earlier sort leaves behind). */
function markSorted(which: number[]): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("DELETE FROM sorted_images WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (${JSON.stringify(PREFIX + '%')},))
    for image_id in ${JSON.stringify(which)}:
        conn.execute("INSERT OR REPLACE INTO sorted_images (image_id, source, operation, sorted_at) VALUES (?, 'auto_separate', 'copy', CURRENT_TIMESTAMP)", (image_id,))
    conn.commit()
print("ok")
`)
}

function cleanup(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("DELETE FROM sorted_images WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (${JSON.stringify(PREFIX + '%')},))
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    conn.commit()
print("ok")
`)
}

test.beforeAll(() => {
  cleanup()
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  ids = seed()
  expect(ids).toHaveLength(COUNT)
  fs.rmSync(path.join(tmpRoot, DEST), { recursive: true, force: true })
  fs.mkdirSync(path.join(tmpRoot, DEST, 'to-w'), { recursive: true })
})

test.afterAll(() => {
  cleanup()
  cleanupImages(PREFIX, [DIR, DEST])
})

test.beforeEach(async ({ page }) => {
  await page.request.delete('/api/sort/session')
})

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`page: ${err.message}`))
  return errors
}

async function setLanguage(page: Page, lang: 'en' | 'zh-CN'): Promise<void> {
  await page.evaluate((l) => localStorage.setItem('sd-image-sorter-lang', l), lang)
  await page.reload({ waitUntil: 'domcontentloaded' })
}

async function pickAll(page: Page, count: number): Promise<void> {
  const tiles = page.getByTestId('tile')
  for (let i = 0; i < count; i++) await tiles.nth(i).click({ modifiers: ['Control'] })
  await expect(page.getByTestId('selection-bar')).toContainText(new RegExp(`${count} picked|已选 ${count} 张`))
}

// ---- 1. tag dialog: blacklist lists ------------------------------------------

const STATUS = {
  models: [
    { id: 'wd14', status: 'ready', available: true, variants: ['wd-swinv2-tagger-v3'], installed_variants: ['wd-swinv2-tagger-v3'] },
  ],
}

async function openTagDialog(page: Page) {
  await page.route('**/api/models/status', (route) => route.fulfill({ json: STATUS }))
  await pickAll(page, 2)
  await page.getByTestId('selection-bar').getByRole('button', { name: /Tag…|打标/ }).click()
  const dialog = page.getByTestId('tag-dialog')
  await expect(dialog).toBeVisible()
  const details = dialog.getByTestId('tag-advanced')
  await expect(details).toBeVisible()
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click()
  await expect(dialog.getByTestId('tag-blacklist-presets')).toBeVisible()
  return dialog
}

test('tag blacklist: quality and meta lists add their words once, Clear empties the box, and the run drops them', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const started: Record<string, unknown>[] = []
  await page.route('**/api/tag/start', async (route) => {
    started.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: 'started' } })
  })
  await page.route('**/api/tag/progress', (route) => route.fulfill({ json: { status: 'done', run_id: 7, current: 2, total: 2, tagged: 2, errors: 0 } }))
  const dialog = await openTagDialog(page)
  const box = dialog.getByTestId('tag-blacklist')

  await expect(dialog.getByTestId('tag-blacklist-clear')).toBeDisabled()
  await box.fill('watermark, My_Tag')
  await dialog.getByTestId('tag-blacklist-quality').click()
  const afterQuality = await box.inputValue()
  expect(afterQuality.startsWith('watermark, My_Tag, masterpiece, best quality')).toBe(true)
  expect(afterQuality).toContain('score_9_up')

  // meta adds the rest of its words; "watermark" was there already and is not repeated
  await dialog.getByTestId('tag-blacklist-meta').click()
  const words = (await box.inputValue()).split(', ')
  expect(words.filter((w) => w === 'watermark')).toHaveLength(1)
  expect(words).toContain('signature')
  expect(words).toContain('jpeg artifacts')

  // pressing a list again changes nothing
  await dialog.getByTestId('tag-blacklist-meta').click()
  await expect(box).toHaveValue(words.join(', '))

  // the run sends exactly these words
  await dialog.getByRole('button', { name: /^(Tag 2|开始打标签)/ }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => started.length).toBe(1)
  const sent = started[0]!.pre_tag_blacklist as string[]
  expect(sent).toContain('masterpiece')
  expect(sent).toContain('score_9_up')
  expect(sent).toContain('signature')
  expect(sent.filter((w) => w === 'watermark')).toHaveLength(1)

  // Clear
  const again = await openTagDialogAgain(page)
  await again.getByTestId('tag-blacklist-clear').click()
  await expect(again.getByTestId('tag-blacklist')).toHaveValue('')
  await expect(again.getByTestId('tag-blacklist-clear')).toBeDisabled()
  expect(errors).toEqual([])
})

async function openTagDialogAgain(page: Page) {
  await page.getByTestId('selection-bar').getByRole('button', { name: /Tag…|打标/ }).click()
  const dialog = page.getByTestId('tag-dialog')
  await expect(dialog.getByTestId('tag-blacklist-presets')).toBeVisible()
  return dialog
}

for (const viewport of VIEWPORTS) {
  for (const lang of ['en', 'zh-CN'] as const) {
    test(`tag blacklist lists fit at ${viewport.width}x${viewport.height} in ${lang}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await openLibrary(page, TOKEN, COUNT)
      if (lang !== 'en') await setLanguage(page, lang)
      const input = page.getByTestId('query-input')
      await input.fill(TOKEN)
      await input.press('Enter')
      await expect(page.getByTestId('result-count')).not.toHaveText('')
      const dialog = await openTagDialog(page)
      const presets = dialog.getByTestId('tag-blacklist-presets')
      if (lang === 'zh-CN') {
        await expect(dialog.getByTestId('tag-blacklist-quality')).toContainText('质量词')
        await expect(dialog.getByTestId('tag-blacklist-clear')).toHaveText('清空')
      } else {
        await expect(dialog.getByTestId('tag-blacklist-quality')).toContainText('Quality')
      }
      await dialog.getByTestId('tag-blacklist-quality').click()
      await dialog.getByTestId('tag-blacklist-meta').click()
      // the dialog scrolls inside itself when the advanced choices are open: the lists are wholly visible once scrolled to
      await scrollToMiddle(presets)
      await expect(presets).toBeInViewport({ ratio: 1 })
      await expect(dialog).toBeInViewport({ ratio: 1 })
      await expect(dialog.getByRole('button', { name: /^(Tag 2|开始打标签)/ })).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    })
  }
}

// ---- 2. Sort: already-sorted pictures ----------------------------------------

async function openSortSetup(page: Page, picked: number) {
  await pickAll(page, picked)
  await page.getByTestId('selection-bar').getByRole('button', { name: /More|更多/ }).click()
  await page.getByRole('menuitem', { name: /Sort into folders…|分拣这些…/ }).click()
  const setup = page.getByTestId('sort-setup')
  await expect(setup).toBeVisible()
  return setup
}

/** The W key's folder: a start needs at least one. */
async function chooseW(page: Page): Promise<void> {
  await page.getByTestId('sort-choose-w').click()
  const picker = page.getByTestId('sort-folder-picker')
  await picker.getByTestId('folder-path').fill(path.join(tmpRoot, DEST, 'to-w'))
  await picker.getByTestId('folder-path').press('Enter')
  await picker.getByRole('button', { name: 'Use this folder' }).click()
  await expect(picker).toHaveCount(0)
}

test('sort: the switch leaves out already sorted pictures, shows the real count, is remembered, and the start sends it', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  markSorted([ids[1] as number, ids[4] as number])
  await openLibrary(page, TOKEN, COUNT)
  const setup = await openSortSetup(page, COUNT)
  const toggle = setup.getByTestId('sort-exclude-sorted')
  const note = setup.getByTestId('sort-sorted-note')

  // never chosen: pictures you picked yourself stay in, and the note says how many were sorted already
  await expect(toggle).not.toBeChecked()
  await expect(note).toHaveText('2 of 6 already sorted, sorted again this time')
  await expect(page.getByTestId('sort-start')).toHaveText('Sort 6 images')
  // a filter ("auto-sort first, hand-sort the rest") leaves them out: the number is what will really be sorted
  await setup.getByTestId('sort-source').getByRole('radio').last().check()
  await expect(toggle).toBeChecked()
  await expect(note).toHaveText('2 of 6 already sorted, left out this time')
  await setup.getByTestId('sort-choose-w').click()
  const picker = page.getByTestId('sort-folder-picker')
  await picker.getByTestId('folder-path').fill(path.join(tmpRoot, DEST, 'to-w'))
  await picker.getByTestId('folder-path').press('Enter')
  await picker.getByRole('button', { name: 'Use this folder' }).click()
  await expect(picker).toHaveCount(0)
  await expect(page.getByTestId('sort-start')).toHaveText('Sort 4 images')

  // off: all six, and the note says they are sorted again; now it is a choice and is kept
  await toggle.uncheck()
  await expect(note).toHaveText('2 of 6 already sorted, sorted again this time')
  await expect(page.getByTestId('sort-start')).toHaveText('Sort 6 images')
  expect(await page.evaluate(() => localStorage.getItem('manual_sort_exclude_sorted_v1'))).toBe('0')

  // remembered across a reload (the picks are gone then, so pick again)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.goto('/vopus/#/library', { waitUntil: 'domcontentloaded' })
  const input = page.getByTestId('query-input')
  await input.fill(TOKEN)
  await input.press('Enter')
  await expect(page.getByTestId('result-count')).toHaveText('6 images')
  const again = await openSortSetup(page, COUNT)
  await expect(again.getByTestId('sort-exclude-sorted')).not.toBeChecked()
  await again.getByTestId('sort-exclude-sorted').check()
  expect(await page.evaluate(() => localStorage.getItem('manual_sort_exclude_sorted_v1'))).toBe('1')
  await expect(again.getByTestId('sort-sorted-note')).toHaveText('2 of 6 already sorted, left out this time')
  await again.getByTestId('sort-choose-w').click()
  const picker2 = page.getByTestId('sort-folder-picker')
  await picker2.getByTestId('folder-path').fill(path.join(tmpRoot, DEST, 'to-w'))
  await picker2.getByTestId('folder-path').press('Enter')
  await picker2.getByRole('button', { name: 'Use this folder' }).click()

  // the start asks the backend to leave them out, and the session has four pictures
  const start = page.waitForRequest((req) => req.url().includes('/api/sort/start') && req.method() === 'POST')
  await page.getByTestId('sort-start').click()
  const body = (await start).postDataJSON() as { exclude_sorted: boolean; image_ids: number[] }
  expect(body.exclude_sorted).toBe(true)
  expect(body.image_ids).toHaveLength(6)
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 4')
  expect(errors).toEqual([])
})

test('sort: when every picture was sorted already, it says so and does not start', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  markSorted(ids)
  await openLibrary(page, TOKEN, COUNT)
  const setup = await openSortSetup(page, 3)
  await chooseW(page)
  await expect(setup.getByTestId('sort-sorted-note')).toHaveText('3 of 3 already sorted, sorted again this time')
  await expect(page.getByTestId('sort-start')).toBeEnabled()
  await setup.getByTestId('sort-exclude-sorted').check()
  await expect(setup.getByTestId('sort-sorted-note')).toHaveText('3 of 3 already sorted, left out this time')
  await expect(setup.getByText('All of these were already sorted')).toBeVisible()
  await expect(page.getByTestId('sort-start')).toBeDisabled()
  await setup.getByTestId('sort-exclude-sorted').uncheck()
  await expect(page.getByTestId('sort-start')).toBeEnabled()
  await expect(page.getByTestId('sort-start')).toHaveText('Sort 3 images')
  markSorted([])
})

for (const viewport of VIEWPORTS) {
  for (const lang of ['en', 'zh-CN'] as const) {
    test(`sort setup with the switch fits at ${viewport.width}x${viewport.height} in ${lang}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      markSorted([ids[0] as number])
      await openLibrary(page, TOKEN, COUNT)
      if (lang !== 'en') {
        await setLanguage(page, lang)
        const input = page.getByTestId('query-input')
        await input.fill(TOKEN)
        await input.press('Enter')
        await expect(page.getByTestId('result-count')).not.toHaveText('')
      }
      await pickAll(page, 3)
      await page.getByTestId('selection-bar').getByRole('button', { name: /More|更多/ }).click()
      await page.getByRole('menuitem', { name: /Sort into folders…|分拣这些…/ }).click()
      const group = page.getByTestId('sort-sorted')
      await expect(group).toBeVisible()
      await expect(page.getByTestId('sort-sorted-note')).toHaveText(lang === 'en' ? '1 of 3 already sorted, sorted again this time' : '已分过 1 / 3，这次也会再分一遍')
      await expect(group).toBeInViewport({ ratio: 1 })
      await expect(page.getByTestId('sort-start')).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      // the note is not cut off
      const clipped = await page.getByTestId('sort-sorted-note').evaluate((el) => el.scrollWidth > el.clientWidth)
      expect(clipped).toBe(false)
      markSorted([])
    })
  }
}

// ---- 3. the queue: sort into groups ------------------------------------------

async function apiOrder(page: Page, id = orderBatchId): Promise<number[]> {
  const batch = (await (await page.request.get(`/api/batches/${id}`)).json()) as { items: { image_id: number }[] }
  return batch.items.map((item) => item.image_id)
}

const tileIds = (page: Page): Promise<number[]> => page.getByTestId('order-tile').evaluateAll((tiles) => tiles.map((t) => Number(t.getAttribute('data-id'))))

const at = (...indexes: number[]) => indexes.map((i) => ids[i] as number)

async function openOrderStep(page: Page, lang: 'en' | 'zh-CN' = 'en'): Promise<void> {
  await page.addInitScript((l) => {
    if (sessionStorage.getItem('v4e2e-init-pb-' + l)) return
    sessionStorage.setItem('v4e2e-init-pb-' + l, '1')
    localStorage.setItem('sd-image-sorter-lang', l)
    localStorage.setItem('sd-v4-theme', 'dark')
  }, lang)
  const res = await page.goto(`/vopus/#/batch/${orderBatchId}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status()).toBe(200)
  await expect(page.getByTestId('batch-view')).toBeVisible()
  await page.locator('[data-testid="rail-step"][data-step-id="order"]').click()
  await expect(page.getByTestId('order-tile')).toHaveCount(COUNT)
}

async function chooseSort(page: Page, item: string): Promise<void> {
  await page.getByTestId('queue-sort').click()
  await page.getByTestId(item).click()
}

test('order: sorting by resolution, aesthetic score and rating groups the queue, marks the groups, and one Undo puts it back', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  const created = await page.request.post('/api/batches', { data: { kind: 'pixiv', name: `${NAME} order`, image_ids: ids } })
  expect(created.status()).toBe(201)
  orderBatchId = ((await created.json()).batch as { id: number }).id
  await openOrderStep(page)
  expect(await tileIds(page)).toEqual(ids)
  await expect(page.getByTestId('order-groups')).toHaveCount(0)

  // resolution: large (longer side 1920 or more) first, then smaller, then unknown
  await chooseSort(page, 'queue-sort-resolution')
  await expect.poll(() => apiOrder(page)).toEqual(at(0, 2, 5, 1, 3, 4))
  expect(await tileIds(page)).toEqual(at(0, 2, 5, 1, 3, 4))
  const legend = page.getByTestId('order-groups')
  await expect(legend).toContainText('Sort: By resolution')
  await expect(page.getByTestId('order-group-head')).toHaveText([/Large.*3/, /Smaller.*2/, /Size unknown.*1/])
  await expect(page.getByTestId('order-group-legend')).toHaveCount(3)
  await expect(page.getByRole('status').filter({ hasText: 'Sorted: By resolution' })).toBeVisible()

  // one Undo puts the saved order back and takes the marks away
  await page.getByTestId('order-undo').click()
  await expect.poll(() => apiOrder(page)).toEqual(ids)
  expect(await tileIds(page)).toEqual(ids)
  await expect(page.getByTestId('order-groups')).toHaveCount(0)
  await expect(page.getByTestId('order-undo')).toBeDisabled()

  // aesthetic score: 7 and up, 5 to 7, under 5, no score
  await chooseSort(page, 'queue-sort-aesthetic')
  await expect.poll(() => apiOrder(page)).toEqual(at(0, 4, 1, 5, 2, 3))
  await expect(page.getByTestId('order-group-head')).toHaveText([/Great.*2/, /Good.*2/, /Low.*1/, /No score.*1/])
  await page.keyboard.press('Control+z')
  await expect.poll(() => apiOrder(page)).toEqual(ids)

  // rating: general, sensitive, questionable, explicit, unrated (asked from the library's own search)
  await chooseSort(page, 'queue-sort-rating')
  await expect.poll(() => apiOrder(page)).toEqual(at(1, 5, 2, 3, 0, 4))
  await expect(page.getByTestId('order-group-head')).toHaveText([/General.*2/, /Sensitive.*1/, /Questionable.*1/, /Explicit.*1/, /Unrated.*1/])
  // sorting again changes nothing and says so
  await chooseSort(page, 'queue-sort-rating')
  await expect(page.getByRole('status').filter({ hasText: 'already in the order' })).toBeVisible()
  expect(await apiOrder(page)).toEqual(at(1, 5, 2, 3, 0, 4))

  // the marks can be hidden without moving anything; a reload keeps the saved order
  await page.getByTestId('order-groups-clear').click()
  await expect(page.getByTestId('order-groups')).toHaveCount(0)
  expect(await apiOrder(page)).toEqual(at(1, 5, 2, 3, 0, 4))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('order-tile')).toHaveCount(COUNT)
  expect(await tileIds(page)).toEqual(at(1, 5, 2, 3, 0, 4))
  expect(errors).toEqual([])
})

test('Ctrl K opens the queue Sort menu while the Order step is on screen', async ({ page }) => {
  await openOrderStep(page)
  await page.getByTestId('open-palette').click()
  await page.keyboard.type('sort the queue')
  await page.getByTestId('palette').getByRole('option').filter({ hasText: 'Sort the queue into groups' }).first().click()
  await expect(page.getByTestId('queue-sort-menu')).toBeVisible()
})

test('profiles: make one, save it, sort by it, and delete it; the keys are the same in the censor step', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.request.delete('/api/sort/session')
  // back to the first order
  await page.request.put(`/api/batches/${orderBatchId}/items/order`, { data: { image_ids: ids } })
  await openOrderStep(page)
  await page.evaluate((k) => localStorage.removeItem(k), PROFILES_KEY)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('order-tile')).toHaveCount(COUNT)
  await expect.poll(() => tileIds(page)).toEqual(await apiOrder(page))

  await page.getByTestId('queue-sort').click()
  await expect(page.getByTestId('queue-sort-menu')).toContainText('No profiles saved yet')
  await page.getByTestId('queue-sort-manage').click()
  const dialog = page.getByTestId('queue-profiles')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('queue-profile-new').click()
  await dialog.getByTestId('queue-profile-name').fill('Explicit first')
  const rules = dialog.getByTestId('queue-profile-rule')
  await expect(rules).toHaveCount(1)
  await rules.nth(0).getByTestId('queue-rule-name').fill('Explicit')
  await rules.nth(0).getByTestId('queue-rule-condition').fill('rating:explicit')
  await rules.nth(0).getByTestId('queue-rule-tone').selectOption('red')
  await dialog.getByTestId('queue-rule-add').click()
  await expect(rules).toHaveCount(2)
  await rules.nth(1).getByTestId('queue-rule-name').fill('General')
  await rules.nth(1).getByTestId('queue-rule-condition').fill('rating:general')

  // closing with unsaved changes asks once
  await expect(dialog.getByTestId('queue-profile-state')).toHaveText('Changes not saved yet')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('queue-profile-state')).toContainText('Press “Discard changes”')

  await dialog.getByTestId('queue-profile-save').click()
  await expect(dialog.getByTestId('queue-profile-state')).toHaveText('')
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]'), PROFILES_KEY)
  expect(stored).toHaveLength(1)
  expect(stored[0].name).toBe('Explicit first')
  expect(stored[0].rules.map((r: { condition: string }) => r.condition)).toEqual(['rating:explicit', 'rating:general'])

  // Save and sort applies it: explicit, then general, then what no rule took. The library's rating search lets a
  // never-tagged picture through for every rating, so the untagged image 4 is taken by the first rule.
  await dialog.getByTestId('queue-profile-apply').click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => apiOrder(page)).toEqual(at(0, 4, 1, 5, 2, 3))
  await expect(page.getByTestId('order-group-head')).toHaveText([/Explicit.*2/, /General.*2/, /In no group.*2/])

  // Undo, then the profile is in the menu and sorts from there
  await page.getByTestId('order-undo').click()
  await expect.poll(() => apiOrder(page)).toEqual(ids)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('order-tile')).toHaveCount(COUNT)
  await page.getByTestId('queue-sort').click()
  await page.getByTestId('queue-sort-profile').filter({ hasText: 'Explicit first' }).click()
  await expect.poll(() => apiOrder(page)).toEqual(at(0, 4, 1, 5, 2, 3))
  await page.getByTestId('order-undo').click()
  await expect.poll(() => apiOrder(page)).toEqual(ids)

  // the censor step has the same menu
  await page.locator('[data-testid="rail-step"][data-step-id="censor"]').click()
  await expect(page.getByTestId('censor-strip')).toBeVisible()
  await page.getByTestId('censor-strip').getByTestId('queue-sort').click()
  await expect(page.getByTestId('queue-sort-menu')).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: 'test-results/v4-partials-b-strip-menu.png' })
  await page.getByTestId('queue-sort-resolution').click()
  await expect.poll(() => apiOrder(page)).toEqual(at(0, 2, 5, 1, 3, 4))
  await expect(page.getByTestId('censor-strip-item').first()).toHaveAttribute('data-id', String(ids[0]))
  await page.locator('[data-testid="rail-step"][data-step-id="order"]').click()
  await page.getByTestId('order-undo').click()
  await expect.poll(() => apiOrder(page)).toEqual(ids)

  // delete the profile
  await page.getByTestId('queue-sort').click()
  await page.getByTestId('queue-sort-manage').click()
  await page.getByTestId('queue-profiles').getByTestId('queue-profile-delete').click()
  await page.getByTestId('queue-profiles').getByTestId('queue-profile-save').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('queue-profiles')).toHaveCount(0)
  expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]'), PROFILES_KEY)).toEqual([])
  await page.getByTestId('queue-sort').click()
  await expect(page.getByTestId('queue-sort-menu')).toContainText('No profiles saved yet')
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

for (const viewport of VIEWPORTS) {
  for (const lang of ['en', 'zh-CN'] as const) {
    test(`queue sort, its groups and the profile editor fit at ${viewport.width}x${viewport.height} in ${lang}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.request.put(`/api/batches/${orderBatchId}/items/order`, { data: { image_ids: ids } })
      await openOrderStep(page, lang)
      await page.evaluate(
        ([k, profile]) => localStorage.setItem(k as string, JSON.stringify([profile])),
        [
          PROFILES_KEY,
          {
            id: 'p1',
            name: lang === 'en' ? 'A profile with a rather long name to check the menu' : '一个名字相当长的方案，用来检查菜单有没有被截断',
            rules: [
              { id: 'r1', name: 'One', tone: 'green', condition: 'rating:general' },
              { id: 'r2', name: 'Two', tone: 'gold', condition: 'rating:explicit score:>5 width:>1000' },
            ],
          },
        ] as const,
      )
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('order-tile')).toHaveCount(COUNT)

      // the menu, open
      await page.getByTestId('queue-sort').click()
      await expect(page.getByTestId('queue-sort-menu')).toBeInViewport({ ratio: 1 })
      await page.keyboard.press('Escape')

      // the groups and their marks
      await chooseSort(page, 'queue-sort-rating')
      await expect(page.getByTestId('order-group-head').first()).toBeVisible()
      await expect(page.getByTestId('order-groups')).toBeInViewport({ ratio: 1 })
      await page.screenshot({ path: `test-results/v4-partials-b-order-${viewport.width}-${lang}.png` })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      const legendClipped = await page.getByTestId('order-groups').evaluate((el) => el.scrollWidth > el.clientWidth)
      expect(legendClipped).toBe(false)

      // the profile editor
      await page.getByTestId('queue-sort').click()
      await page.getByTestId('queue-sort-manage').click()
      const dialog = page.getByTestId('queue-profiles')
      await expect(dialog).toBeInViewport({ ratio: 1 })
      await expect(dialog.getByTestId('queue-profile-apply')).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      const clipped = await dialog.getByTestId('queue-profile-rules').evaluate((el) => el.scrollWidth > el.clientWidth)
      expect(clipped).toBe(false)
      await page.screenshot({ path: `test-results/v4-partials-b-profiles-${viewport.width}-${lang}.png` })
      if (lang === 'zh-CN') await expect(dialog.getByTestId('queue-profile-save')).toHaveText('保存')
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await page.getByTestId('order-undo').click()
      await page.evaluate((k) => localStorage.removeItem(k), PROFILES_KEY)
    })
  }
}
