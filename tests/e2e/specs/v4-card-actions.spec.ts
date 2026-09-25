import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, openLibrary, pageOverflow, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 card actions: the right-click menu (the selection bar's own list),
 * reaching the file (open folder / copy path in the menu, the card and the
 * big image; open-path for a finished copy), dragging a card out, the tile
 * heart, invert, a random image from the whole result, the shortcut sheet
 * and the rail's collapse / fold state.
 *
 * Opening Explorer is always stubbed: a real call would open windows on the
 * test machine. Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })
test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

const TOKEN = 'v4cacttoken'
const PREFIX = 'v4cact-'
const COUNT = 6
const DIR = 'v4-cact'
const DEST = 'v4-cact-dest'
const BULK_TOKEN = 'v4cactbulk'
const BULK_PREFIX = 'v4cactbulk-'
const BULK_COUNT = 300
const BULK_DIR = 'v4-cact-bulk'

/** Every action the selection bar offers for picks: its buttons and its More menu. */
const BAR_ACTIONS = ['batch', 'rate', 'favorite', 'tag', 'move', 'censor', 'copy', 'edit-tags', 'export', 'move-library', 'remove', 'trash']

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  seedImages({ prefix: BULK_PREFIX, token: BULK_TOKEN, count: BULK_COUNT, dir: BULK_DIR })
  fs.rmSync(path.join(tmpRoot, DEST), { recursive: true, force: true })
  fs.mkdirSync(path.join(tmpRoot, DEST), { recursive: true })
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR, DEST])
  cleanupImages(BULK_PREFIX, [BULK_DIR])
})

async function pathOf(page: Page, id: string): Promise<string> {
  return page.evaluate(async (x) => (await (await fetch(`/api/images/${x}`)).json()).image.path, id)
}

/**
 * Click and wait for the saved favourite. (The ids endpoint cannot be read back here:
 * it resolves favourites through image_path_identities, which the seed does not write.)
 */
async function clickAndSave(page: Page, click: () => Promise<void>): Promise<{ sent: unknown; saved: unknown }> {
  const response = page.waitForResponse((r) => r.url().endsWith('/api/collections/favorites') && r.request().method() === 'POST')
  await click()
  const res = await response
  expect(res.status()).toBe(200)
  return { sent: res.request().postDataJSON(), saved: await res.json() }
}

/** What the selection bar offers, by action id. */
async function barActions(page: Page): Promise<string[]> {
  const bar = page.getByTestId('selection-bar')
  const ids = await bar.locator('[data-action]').evaluateAll((els) => els.map((el) => el.getAttribute('data-action') ?? ''))
  if (await bar.getByTestId('add-to-batch').count()) ids.push('batch')
  await bar.getByRole('button', { name: 'More' }).click()
  ids.push(...(await page.getByRole('menu').locator('[data-item]').evaluateAll((els) => els.map((el) => el.getAttribute('data-item') ?? ''))))
  await page.keyboard.press('Escape')
  return ids
}

/** The right-click menu's own entries (not its submenus), in order. */
async function menuItems(page: Page): Promise<string[]> {
  return page
    .getByTestId('card-menu')
    .locator(':scope > [role="group"] > [role="menuitem"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-item') ?? ''))
}

/** Stub the two "open in Explorer" endpoints and record what they were asked. */
async function stubOpeners(page: Page) {
  const calls: { url: string; body: unknown }[] = []
  await page.route(/\/api\/open-(folder|path)$/, async (route) => {
    calls.push({ url: route.request().url(), body: route.request().postDataJSON() })
    await route.fulfill({ json: { success: true, path: 'stubbed' } })
  })
  return calls
}

for (const viewport of VIEWPORTS) {
  test(`menu, shortcut sheet and bar fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      await openLibrary(page, TOKEN, COUNT, theme)
      const tiles = page.getByTestId('tile')
      await tiles.nth(0).click({ modifiers: ['Control'] })
      await tiles.nth(1).click({ modifiers: ['Control'] })
      const bar = page.getByTestId('selection-bar')
      await expect(bar.getByTestId('invert-picks')).toBeInViewport({ ratio: 1 })
      expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)

      // right-click near the bottom-right corner: the menu flips to stay on screen
      const box = (await tiles.nth(1).boundingBox())!
      await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4, { button: 'right' })
      const menu = page.getByTestId('card-menu')
      await expect(menu).toBeVisible()
      for (const item of await menu.locator(':scope > [role="group"] > [role="menuitem"]').all()) {
        await expect(item).toBeInViewport({ ratio: 1 })
      }
      await menu.getByRole('menuitem', { name: 'Add to batch' }).hover()
      for (const item of await page.locator('[data-ctx-sub] [role="menuitem"]').all()) {
        await expect(item).toBeInViewport({ ratio: 1 })
      }
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)

      await page.getByTestId('open-palette').click()
      await expect(page.getByTestId('palette')).toBeVisible()
      await page.keyboard.type('keyboard shortcuts')
      await page.keyboard.press('Enter')
      const sheet = page.getByTestId('shortcut-sheet')
      await expect(sheet).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
    }
  })
}

test('right-click on a pick offers the selection bar\'s actions; on another card it acts on that card', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await tiles.nth(1).click({ modifiers: ['Control'] })
  const bar = page.getByTestId('selection-bar')
  await expect(bar).toContainText('2 picked')

  const offered = await barActions(page)
  expect([...offered].sort()).toEqual([...BAR_ACTIONS].sort())

  await tiles.nth(1).click({ button: 'right' })
  const menu = page.getByTestId('card-menu')
  await expect(menu).toContainText('Acts on the 2 picked images')
  const items = await menuItems(page)
  for (const id of BAR_ACTIONS) expect(items, id).toContain(id)
  // the danger group comes last, under its own divider, and says again what it acts on
  expect(items.slice(-2)).toEqual(['remove', 'trash'])
  const lastGroup = menu.locator(':scope > [role="group"]').last()
  await expect(lastGroup).toHaveAttribute('data-divider', 'true')
  await expect(lastGroup).toContainText('Acts on the 2 picked images')

  // submenus: Add to batch and Rate; Esc closes the submenu first, then the menu
  await menu.getByRole('menuitem', { name: 'Add to batch' }).hover()
  await expect(page.locator('[data-ctx-sub]').getByRole('menuitem', { name: 'New Pixiv post…' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-ctx-sub]')).toHaveCount(0)
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(bar).toContainText('2 picked')

  // rate the two picks from the menu
  const pickedIds = await Promise.all([0, 1].map((i) => tiles.nth(i).getAttribute('data-id')))
  await tiles.nth(0).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Rate' }).click()
  await page.locator('[data-ctx-sub]').getByRole('menuitem', { name: '4 stars' }).click()
  await expect(menu).toHaveCount(0)
  for (const id of pickedIds) {
    await expect.poll(() => page.evaluate(async (x) => (await (await fetch(`/api/images/${x}`)).json()).image.user_rating, id)).toBe(4)
  }

  // an unpicked card: the menu names its file and moves only it
  const name = await tiles.nth(3).getAttribute('title')
  await tiles.nth(3).click({ button: 'right' })
  await expect(menu).toContainText(name!)
  await expect(menu).not.toContainText('picked')
  await menu.getByRole('menuitem', { name: 'Move to…' }).click()
  const picker = page.getByTestId('folder-picker')
  await expect(picker.getByRole('button', { name: 'Move 1 here' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(bar).toContainText('2 picked')

  // the keyboard: Shift+F10 opens the menu of the inspected card with the first entry focused
  await tiles.nth(2).click()
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[role="menuitem"]').first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.locator('[role="menuitem"]').nth(1)).toBeFocused()
  await page.keyboard.press('Enter')
  // the second entry is Pick: the inspected card joins the picks
  await expect(menu).toHaveCount(0)
  await expect(bar).toContainText('3 picked')
})

test('copy path and open the folder from the menu, the card and the big image', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, TOKEN, COUNT)
  const calls = await stubOpeners(page)
  const tile = page.getByTestId('tile').nth(0)
  const id = (await tile.getAttribute('data-id'))!
  const file = await pathOf(page, id)

  await tile.click({ button: 'right' })
  await page.getByTestId('card-menu').getByRole('menuitem', { name: 'Copy path' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(file)
  await expect(page.getByText(`Copied: Path`)).toBeVisible()

  await tile.click({ button: 'right' })
  await page.getByTestId('card-menu').getByRole('menuitem', { name: 'Open containing folder' }).click()
  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0]!.url).toMatch(/\/api\/open-folder$/)
  expect(calls[0]!.body).toEqual({ image_id: Number(id) })

  // the generation card shows the folder and offers both
  const card = page.getByTestId('generation-card')
  await expect(card).toContainText(DIR)
  await page.evaluate(() => navigator.clipboard.writeText(''))
  await card.getByTestId('card-copy-path').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(file)
  await card.getByTestId('card-open-folder').click()
  await expect.poll(() => calls.length).toBe(2)

  // and so does the big image
  await page.keyboard.press('Enter')
  const lightbox = page.getByTestId('lightbox')
  await expect(lightbox).toBeVisible()
  await lightbox.getByTestId('lightbox-open-folder').click()
  await expect.poll(() => calls.length).toBe(3)
  expect(calls[2]!.body).toEqual({ image_id: Number(id) })
  await page.evaluate(() => navigator.clipboard.writeText(''))
  await lightbox.getByTestId('lightbox-copy-path').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(file)
  await page.keyboard.press('Escape')
})

test('a finished copy offers to open the destination (open-path)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const calls = await stubOpeners(page)
  const dest = path.join(tmpRoot, DEST)
  const tile = page.getByTestId('tile').nth(4)
  const name = (await tile.getAttribute('title'))!

  await tile.click({ button: 'right' })
  await page.getByTestId('card-menu').getByRole('menuitem', { name: 'Copy to…' }).click()
  const pathInput = page.getByTestId('folder-path')
  // it opens where the image lives; wait for that listing before typing over it
  await expect(pathInput).toHaveValue(path.join(tmpRoot, DIR))
  await pathInput.fill(dest)
  await pathInput.press('Enter')
  await expect(page.getByTestId('folder-target')).toContainText(dest)
  await page.getByTestId('folder-picker').getByRole('button', { name: 'Copy 1 here' }).click()
  await expect.poll(() => fs.existsSync(path.join(dest, name))).toBe(true)

  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  await expect(job).toContainText('Copied 1')
  await job.getByTestId('job-open-folder').click()
  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0]!.url).toMatch(/\/api\/open-path$/)
  expect(calls[0]!.body).toEqual({ path: dest })
})

test('dragging a card carries the original file; a click never starts a drag', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const tile = page.getByTestId('tile').nth(0)
  const id = (await tile.getAttribute('data-id'))!
  const name = (await tile.getAttribute('title'))!

  const data = await tile.evaluate((el) => {
    const dt = new DataTransfer()
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    return { download: dt.getData('DownloadURL'), uri: dt.getData('text/uri-list'), types: [...dt.types] }
  })
  const url = new URL(`/api/image-file/${id}`, page.url()).href
  expect(data.download).toBe(`image/png:${name}:${url}`)
  expect(data.uri).toBe(url)
  await expect(tile).toHaveAttribute('draggable', 'true')
  // the URL serves the full-size original
  const res = await page.request.get(url)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('image/png')

  // a plain click inspects and never starts a drag
  await tile.evaluate((el) => {
    ;(window as unknown as { __drags: number }).__drags = 0
    el.addEventListener('dragstart', () => {
      ;(window as unknown as { __drags: number }).__drags += 1
    })
  })
  await tile.click()
  await expect(tile).toHaveAttribute('data-inspected', 'true')
  expect(await page.evaluate(() => (window as unknown as { __drags: number }).__drags)).toBe(0)

  // dropped on our own search box it is refused, not pasted in as a URL
  const input = page.getByTestId('query-input')
  await tile.dragTo(input)
  await expect(input).toHaveValue(TOKEN)
})

test('the tile heart: offered on hover, stays while favourited, never opens the image', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const tile = page.getByTestId('tile').nth(5)
  const id = Number(await tile.getAttribute('data-id'))
  const heart = tile.getByTestId('tile-heart')
  await page.getByTestId('tile').nth(0).click()

  await expect(heart).toHaveCSS('opacity', '0')
  await tile.hover()
  await expect(heart).toHaveCSS('opacity', '1')
  const on = await clickAndSave(page, () => heart.click())
  expect(on).toEqual({ sent: { image_id: id, favorited: true }, saved: { favorited: true } })
  await expect(heart).toHaveAttribute('aria-pressed', 'true')
  // the click did not inspect or open the tile
  await expect(tile).not.toHaveAttribute('data-inspected', 'true')
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
  await page.mouse.move(2, 2)
  await expect(heart).toHaveCSS('opacity', '1')

  await tile.hover()
  const off = await clickAndSave(page, () => heart.click())
  expect(off).toEqual({ sent: { image_id: id, favorited: false }, saved: { favorited: false } })
  await expect(heart).toHaveAttribute('aria-pressed', 'false')
})

test('invert within the filter: the bar button, Ctrl+I and Ctrl K', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, TOKEN, COUNT)
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await tiles.nth(1).click({ modifiers: ['Control'] })
  const bar = page.getByTestId('selection-bar')

  await bar.getByTestId('invert-picks').click()
  await expect(bar).toContainText(`${COUNT - 2} picked`)
  await expect(tiles.nth(0)).not.toHaveAttribute('data-picked', 'true')
  await expect(tiles.nth(2)).toHaveAttribute('data-picked', 'true')

  await page.keyboard.press('Control+i')
  await expect(bar).toContainText('2 picked')
  await expect(tiles.nth(0)).toHaveAttribute('data-picked', 'true')

  await page.keyboard.press('Control+k')
  await page.keyboard.type('invert')
  await page.keyboard.press('Enter')
  await expect(bar).toContainText(`${COUNT - 2} picked`)
})

test('random: opens an image beyond the loaded page and steps on through the result', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, BULK_TOKEN, BULK_COUNT)
  const asked: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/images?') && r.url().includes('limit=1')) asked.push(r.url())
  })
  // the first page holds 240 of 300: pick the 298th
  await page.evaluate(() => {
    Math.random = () => 0.99
  })
  await page.keyboard.press('Control+k')
  await page.keyboard.type('random')
  await page.keyboard.press('Enter')

  const lightbox = page.getByTestId('lightbox')
  await expect(lightbox).toBeVisible()
  await expect(lightbox).toContainText('298 / 300')
  await expect(lightbox).toContainText(`${BULK_PREFIX}297.png`)
  expect(asked.some((u) => /[?&]offset=297(&|$)/.test(u) && u.includes(BULK_TOKEN))).toBe(true)

  await page.keyboard.press('ArrowRight')
  await expect(lightbox).toContainText('299 / 300')
  await expect(lightbox).toContainText(`${BULK_PREFIX}298.png`)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(lightbox).toContainText(`${BULK_PREFIX}296.png`)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('generation-card')).toContainText(`${BULK_PREFIX}296.png`)
})

test('the shortcut sheet lists the library and big-image keys', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  await page.keyboard.press('Control+k')
  await page.keyboard.type('keyboard shortcuts')
  await page.keyboard.press('Enter')
  const sheet = page.getByTestId('shortcut-sheet')
  await expect(sheet).toBeInViewport({ ratio: 1 })
  for (const key of ['Enter', 'Space', '1–5', 'F', 'I', 'Z', '/', 'Ctrl+A', 'Ctrl+I', 'Ctrl+K', 'Shift+F10', 'Delete', 'Right-click', 'Ctrl+click']) {
    await expect(sheet.locator('kbd', { hasText: key }).first()).toBeVisible()
  }
  await expect(sheet).toContainText('Big image')
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
})

test('the rail: a collapse button, folding sections, both remembered after a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const rail = page.getByRole('navigation', { name: 'Library' })

  // fold Folders: its list goes, and stays gone after a reload
  const folders = rail.getByRole('button', { name: 'Folders' })
  const folderRow = rail.getByRole('button', { name: /v4-cact$/ })
  await expect(folders).toHaveAttribute('aria-expanded', 'true')
  await expect(folderRow).toBeVisible()
  await folders.click()
  await expect(folders).toHaveAttribute('aria-expanded', 'false')
  await expect(folderRow).toHaveCount(0)

  // hide the whole rail; the query bar offers it back
  await page.getByTestId('rail-collapse').click()
  await expect(rail).toHaveCount(0)
  await expect(page.getByTestId('rail-expand')).toBeInViewport()

  await page.reload()
  await expect(page.getByTestId('rail-expand')).toBeVisible()
  await expect(rail).toHaveCount(0)
  await page.getByTestId('rail-expand').click()
  await expect(rail).toBeVisible()
  await expect(folders).toHaveAttribute('aria-expanded', 'false')
  await expect(folderRow).toHaveCount(0)
  await folders.click()
  await expect(folderRow).toBeVisible()
})
