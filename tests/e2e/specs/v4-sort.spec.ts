import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, openLibrary, pageOverflow, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 Sort tab (WASD into folders): start from picks or from the library
 * filter, real moves and copies into temp folders, undo that really moves the
 * file back, a session that survives a reload, the finished summary, and keys
 * that never act while typing. Runs on the isolated test server only.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4sorttoken'
const PREFIX = 'v4sort-'
const COUNT = 8
const DIR = 'v4-sort'
const FILTER_TOKEN = 'v4sortfilter'
const FILTER_PREFIX = 'v4sortf-'
const FILTER_COUNT = 5
const FILTER_DIR = 'v4-sort-filter'
const DEST = 'v4-sort-dest'
const SLOTS = ['w', 'a', 's', 'd'] as const
const destOf = (slot: string) => path.join(tmpRoot, DEST, `to-${slot}`)
const inSource = (name: string) => fs.existsSync(path.join(tmpRoot, DIR, name))
const inSlot = (slot: string, name: string) => fs.existsSync(path.join(destOf(slot), name))

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  seedImages({ prefix: FILTER_PREFIX, token: FILTER_TOKEN, count: FILTER_COUNT, dir: FILTER_DIR })
  fs.rmSync(path.join(tmpRoot, DEST), { recursive: true, force: true })
  for (const slot of [...SLOTS, 'copies']) fs.mkdirSync(destOf(slot), { recursive: true })
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR, DEST])
  cleanupImages(FILTER_PREFIX, [FILTER_DIR])
})

test.beforeEach(async ({ page }) => {
  // One saved session per server: start every test without one.
  await page.request.delete('/api/sort/session')
})

async function pick(page: Page, count: number): Promise<{ ids: string[]; names: string[] }> {
  const tiles = page.getByTestId('tile')
  const ids: string[] = []
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    await tiles.nth(i).click({ modifiers: ['Control'] })
    ids.push((await tiles.nth(i).getAttribute('data-id'))!)
    names.push((await tiles.nth(i).getAttribute('title'))!)
  }
  return { ids, names }
}

/** Choose a key's folder in the folder browser by typing its path. */
async function chooseFolder(page: Page, opener: string, folder: string) {
  await page.getByTestId(opener).click()
  const picker = page.getByTestId('sort-folder-picker')
  const input = picker.getByTestId('folder-path')
  await input.fill(folder)
  await input.press('Enter')
  await expect(picker.getByTestId('folder-target')).toContainText(folder)
  await picker.getByRole('button', { name: 'Use this folder' }).click()
  await expect(picker).toHaveCount(0)
}

async function press(page: Page, key: string, expectPos: string) {
  await page.keyboard.press(key)
  await expect(page.getByTestId('sort-pos')).toHaveText(expectPos)
}

test('six picks go into four folders by key; undo moves back; a reload keeps the session; the summary says where', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const opened: string[] = []
  await page.route('**/api/open-path', async (route) => {
    opened.push(route.request().postDataJSON().path)
    await route.fulfill({ json: { status: 'ok' } })
  })
  await openLibrary(page, TOKEN, COUNT)
  const { names } = await pick(page, 6)

  // "Sort into folders…" in the selection bar's More menu
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Sort into folders…' }).click()
  const setup = page.getByTestId('sort-setup')
  await expect(setup).toBeVisible()
  await expect(setup.getByRole('radio', { name: /The 6 picked/ })).toBeChecked()
  await expect(page.getByTestId('sort-start')).toBeDisabled()
  for (const slot of SLOTS) await chooseFolder(page, `sort-choose-${slot}`, destOf(slot))
  // a new sort copies until the user picks move (ADR-2026-05-16-copy-default)
  await expect(page.getByTestId('sort-op-copy')).toBeChecked()
  await page.getByTestId('sort-op-move').check()
  await expect(page.getByTestId('sort-start')).toHaveText('Sort 6 images')
  await page.getByTestId('sort-start').click()

  // W A S D send the first four to their folders, for real
  const session = page.getByTestId('sort-session')
  await expect(session).toBeVisible()
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 6')
  await press(page, 'w', 'Image 2 of 6')
  await press(page, 'a', 'Image 3 of 6')
  await press(page, 's', 'Image 4 of 6')
  await press(page, 'd', 'Image 5 of 6')
  SLOTS.forEach((slot, i) => {
    expect(inSlot(slot, names[i]!), `${names[i]} in ${slot}`).toBe(true)
    expect(inSource(names[i]!)).toBe(false)
  })
  await expect(page.getByTestId('sort-slot-d').locator('..')).toHaveAttribute('data-count', '1')

  // typing in the folder browser never sorts anything
  await page.getByTestId('sort-change-w').click()
  const picker = page.getByTestId('sort-folder-picker')
  await picker.getByTestId('folder-path').pressSequentially('wasd wasd', { delay: 10 })
  await page.keyboard.press('Backspace')
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 5 of 6')
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(session).toBeVisible()
  expect(inSource(names[4]!)).toBe(true)

  // Backspace undoes: the last file goes back where it was
  await press(page, 'Backspace', 'Image 4 of 6')
  await expect(page.getByTestId('sort-status')).toContainText('Undone')
  expect(inSource(names[3]!)).toBe(true)
  expect(inSlot('d', names[3]!)).toBe(false)
  await expect(page.getByTestId('sort-slot-d').locator('..')).toHaveAttribute('data-count', '0')

  // a reload comes back to the same image with the same tallies
  await page.reload()
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 4 of 6')
  await expect(page.getByTestId('sort-slot-w').locator('..')).toHaveAttribute('data-count', '1')
  await expect(page.getByTestId('sort-slot-s').locator('..')).toHaveAttribute('data-count', '1')

  // finish: D, skip one, W
  await press(page, 'd', 'Image 5 of 6')
  await press(page, 'Space', 'Image 6 of 6')
  await page.keyboard.press('w')
  const summary = page.getByTestId('sort-summary')
  await expect(summary).toBeVisible()
  await expect(page.getByTestId('sort-summary-body')).toHaveText('6 images: 5 put in folders, 1 skipped.')
  await expect(summary.locator('[data-slot="w"]')).toHaveAttribute('data-count', '2')
  await expect(summary.locator('[data-slot="d"]')).toHaveAttribute('data-count', '1')
  expect(inSlot('d', names[3]!)).toBe(true)
  expect(inSource(names[4]!)).toBe(true)
  expect(inSlot('w', names[5]!)).toBe(true)

  // the summary survives a reload too, and Backspace there still undoes
  await page.reload()
  await expect(summary).toBeVisible()
  await page.keyboard.press('Backspace')
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 6 of 6')
  expect(inSource(names[5]!)).toBe(true)
  await page.keyboard.press('w')
  await expect(summary).toBeVisible()

  await summary.locator('[data-slot="a"]').getByRole('button', { name: 'Open folder' }).click()
  await expect.poll(() => opened).toEqual([destOf('a')])

  // back to the library: the session is gone, and so is "Continue" on Home
  await page.getByTestId('sort-back').click()
  await expect(page.getByTestId('gallery-scroller')).toBeVisible()
  const current = await (await page.request.get('/api/sort/current')).json()
  expect(current.active).toBe(false)
  await page.goto('/v4/#/home')
  await expect(page.getByTestId('home')).toBeVisible()
  await expect(page.getByTestId('home-sort')).toHaveCount(0)
})

test('starting from the library filter sorts every match, copying when asked; the setup is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const copies = destOf('copies')
  await page.addInitScript((folder) => {
    if (sessionStorage.getItem('v4sort-setup')) return
    sessionStorage.setItem('v4sort-setup', '1')
    localStorage.setItem('sd-v4-sort-setup:main', JSON.stringify({ folders: { a: folder }, operation: 'copy' }))
  }, copies)
  await openLibrary(page, FILTER_TOKEN, FILTER_COUNT)

  await page.keyboard.press('Control+k')
  await page.getByTestId('palette').locator('input').fill('filter matches into folders')
  await page.keyboard.press('Enter')
  const setup = page.getByTestId('sort-setup')
  await expect(setup.getByRole('radio', { name: /All 5 the library filter matches/ })).toBeChecked()
  await expect(setup).toContainText(FILTER_TOKEN)
  await expect(page.getByTestId('sort-op-copy')).toBeChecked()
  await expect(page.getByTestId('sort-slots').locator('[data-slot="a"]')).toContainText('to-copies')
  await page.getByTestId('sort-start').click()

  await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 5')
  // W has no folder: it says so and nothing happens
  await page.keyboard.press('w')
  await expect(page.getByTestId('sort-status')).toContainText('W has no folder yet')
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 5')
  for (let i = 2; i <= FILTER_COUNT; i++) await press(page, 'a', `Image ${i} of 5`)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('sort-summary-body')).toHaveText('5 images: 4 copied to folders, 1 skipped.')

  const copied = fs.readdirSync(copies).filter((f) => f.startsWith(FILTER_PREFIX))
  expect(copied).toHaveLength(4)
  for (const name of copied) expect(fs.existsSync(path.join(tmpRoot, FILTER_DIR, name))).toBe(true)

  // "Sort another set" clears it and opens the setup with the same folders
  await page.getByTestId('sort-again').click()
  await expect(setup).toBeVisible()
  await expect(page.getByTestId('sort-slots').locator('[data-slot="a"]')).toContainText('to-copies')
  await expect(page.getByTestId('sort-resume')).toHaveCount(0)
})

test('a new sort over an unfinished one asks first; Home and the setup offer to continue it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript((folder) => {
    if (sessionStorage.getItem('v4sort-setup')) return
    sessionStorage.setItem('v4sort-setup', '1')
    localStorage.setItem('sd-v4-sort-setup:main', JSON.stringify({ folders: { s: folder }, operation: 'copy' }))
  }, destOf('copies'))
  await openLibrary(page, FILTER_TOKEN, FILTER_COUNT)
  await pick(page, 3)
  await page.keyboard.press('Control+k')
  await page.getByTestId('palette').locator('input').fill('sort the 3 picked')
  await page.keyboard.press('Enter')
  await page.getByTestId('sort-start').click()
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 3')
  await press(page, 'Space', 'Image 2 of 3')

  await page.goto('/v4/#/home')
  const card = page.getByTestId('home-sort')
  await expect(card).toContainText('image 2 of 3')
  await expect(card.getByRole('button', { name: 'Continue' })).toBeInViewport({ ratio: 1 })
  await page.getByTestId('home-start-sort').click()
  await expect(page.getByTestId('sort-resume')).toContainText('image 2 of 3')

  await page.getByTestId('sort-start').click()
  const confirm = page.getByTestId('sort-confirm')
  await expect(confirm).toContainText('2 images left')
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(page.getByTestId('sort-setup')).toBeVisible()

  await page.getByTestId('sort-continue').click()
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 2 of 3')
  // Esc on the page never leaves it
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('sort-session')).toBeVisible()

  await page.getByTestId('sort-end').click()
  await page.getByTestId('sort-confirm').getByRole('button', { name: 'End sort' }).click()
  await expect(page.getByTestId('sort-setup')).toBeVisible()
  await expect(page.getByTestId('sort-resume')).toHaveCount(0)
})

const LIB = { 'X-SD-Library-Id': 'main' }

async function favoriteIds(page: Page): Promise<number[]> {
  return ((await (await page.request.get('/api/collections/favorites/ids', { headers: LIB })).json()) as { image_ids: number[] }).image_ids
}

test('a key can add the image to Favorites instead of moving its file; undo takes out only what the key added', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript((folder) => {
    if (sessionStorage.getItem('v4sort-setup')) return
    sessionStorage.setItem('v4sort-setup', '1')
    localStorage.setItem('sd-v4-sort-setup:main', JSON.stringify({ folders: { s: folder }, operation: 'move' }))
  }, destOf('copies'))
  await openLibrary(page, FILTER_TOKEN, FILTER_COUNT)
  const { ids, names } = await pick(page, 2)
  const [first, second] = ids.map(Number) as [number, number]
  // the second picture is a favorite already
  expect((await page.request.post('/api/collections/favorites', { data: { image_id: second, favorited: true }, headers: LIB })).ok()).toBe(true)
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Sort into folders…' }).click()

  await page.getByTestId('sort-favorites-w').click()
  const row = page.getByTestId('sort-slots').locator('[data-slot="w"]')
  await expect(row.getByTestId('sort-slot-favorites')).toBeVisible()
  await expect(row).toContainText('Favorites')
  await expect(page.getByTestId('sort-favorites-w')).toBeDisabled()
  await page.getByTestId('sort-start').click()

  await expect(page.getByTestId('sort-slot-w')).toContainText('Favorites')
  await press(page, 'w', 'Image 2 of 2')
  await expect(page.getByTestId('sort-status')).toHaveText('Added to Favorites (W)')
  // the heart's own list shows it, and no file moved even with "move" chosen
  expect(await favoriteIds(page)).toContain(first)
  expect(fs.existsSync(path.join(tmpRoot, FILTER_DIR, names[0]!))).toBe(true)
  await page.keyboard.press('w')
  await expect(page.getByTestId('sort-summary-body')).toBeVisible()

  // undo the second: it was a favorite before the key, so it stays one
  await page.keyboard.press('Backspace')
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 2 of 2')
  expect(await favoriteIds(page)).toContain(second)
  // undo the first: the key added it, so it goes
  await page.keyboard.press('Backspace')
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 2')
  await expect.poll(() => favoriteIds(page)).not.toContain(first)
  expect(await favoriteIds(page)).toContain(second)

  // the next sort in this library starts with W on Favorites again
  await page.getByTestId('sort-new').click()
  await expect(page.getByTestId('sort-slots').locator('[data-slot="w"]')).toContainText('Favorites')
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  expect((await page.request.post('/api/collections/favorites', { data: { image_id: second, favorited: false }, headers: LIB })).ok()).toBe(true)
})

for (const viewport of VIEWPORTS) {
  test(`setup, session and summary fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.addInitScript((folder) => {
      if (sessionStorage.getItem('v4sort-setup')) return
      sessionStorage.setItem('v4sort-setup', '1')
      localStorage.setItem('sd-v4-sort-setup:main', JSON.stringify({ folders: { w: folder }, operation: 'copy' }))
    }, destOf('copies'))
    for (const theme of ['dark', 'light'] as const) {
      await page.request.delete('/api/sort/session')
      await openLibrary(page, FILTER_TOKEN, FILTER_COUNT, theme)
      await pick(page, 2)
      await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
      await page.getByRole('menuitem', { name: 'Sort into folders…' }).click()
      await expect(page.getByTestId('sort-start')).toBeInViewport({ ratio: 1 })
      for (const slot of SLOTS) await expect(page.getByTestId(`sort-choose-${slot}`)).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)

      await page.getByTestId('sort-start').click()
      await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 2')
      for (const id of ['sort-undo', 'sort-new', 'sort-end', 'sort-skip', ...SLOTS.map((s) => `sort-slot-${s}`)]) {
        await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
      }
      const frame = await page.getByTestId('sort-image').boundingBox()
      expect(frame!.height).toBeGreaterThan(viewport.height * 0.4)
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)

      await press(page, 'w', 'Image 2 of 2')
      await page.keyboard.press('w')
      await expect(page.getByTestId('sort-back')).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    }
  })
}
