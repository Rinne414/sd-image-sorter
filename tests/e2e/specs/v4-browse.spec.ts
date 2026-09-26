import { expect, test, type Page } from '@playwright/test'

import { dbPath, openLibrary, pageOverflow, runBackendScript, tmpRoot } from '../fixtures/v4-seed'
import { PY_DELETE_IMAGES } from '../fixtures/e2e-db'

/**
 * V4 browsing details on the real backend: each library keeps its own search
 * (switch and reload), the folder tree scopes a parent that only holds
 * subfolders, "any of" tags and "prompt contains" (search line and filter
 * panel), the two empty states, the grid coming back to the same place after
 * a reload and another tab, and the screen-reader labels / skip link.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4browsetoken'
const PREFIX = 'v4br-'
const DIR = 'v4-browse'
const COUNT = 300
const LIB_NAME = 'V4 e2e browse'

/**
 * 300 images: folders parent/a (i%3=0), parent/b (i%3=1), other (i%3=2);
 * tags cat_ears (i%10=0), fox_ears (i%10=1), both (i%10=2); prompt words
 * "blue eyes" (i%10=0) and "light blue eyes" (i%10=5).
 */
function seed(): void {
  runBackendScript(`
${PY_DELETE_IMAGES}
import shutil, sqlite3
from pathlib import Path
from PIL import Image
root = Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(DIR)}
shutil.rmtree(root, ignore_errors=True)
folders = [root / "parent" / "a", root / "parent" / "b", root / "other"]
for f in folders:
    f.mkdir(parents=True, exist_ok=True)
shapes = [(64, 96), (96, 64), (80, 80), (48, 120)]
prefix = ${JSON.stringify(PREFIX)}
token = ${JSON.stringify(TOKEN)}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    cur.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (prefix + "%",))
    cur.execute("DELETE FROM image_prompt_tokens WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (prefix + "%",))
    delete_images(cur, "filename LIKE ?", (prefix + "%",))
    for i in range(${COUNT}):
        w, h = shapes[i % len(shapes)]
        name = f"{prefix}{i:03d}.png"
        path = (folders[i % 3] / name).resolve()
        Image.new("RGB", (w, h), (40 + (i * 8) % 200, 90, 160 - (i * 4) % 150)).save(path)
        words = [token, "1girl", f"frame {i}"]
        if i % 10 == 0:
            words.append("blue eyes")
        if i % 10 == 5:
            words.append("light blue eyes")
        cur.execute(
            """INSERT INTO images (path, filename, generator, prompt, width, height, file_size, is_readable,
                   metadata_status, created_at, library_order_time, user_rating)
               VALUES (?, ?, 'nai', ?, ?, ?, ?, 1, 'complete', datetime('now', ?), datetime('now', ?), 0)""",
            (str(path), name, ", ".join(words), w, h, path.stat().st_size, f"-{i} minutes", f"-{i} minutes"),
        )
        image_id = cur.lastrowid
        for word in words:
            cur.execute("INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)", (image_id, word))
        tags = {0: ["cat_ears"], 1: ["fox_ears"], 2: ["cat_ears", "fox_ears"]}.get(i % 10, [])
        for tag in tags:
            cur.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, 0.9)", (image_id, tag))
    conn.commit()
print("ok")
`)
}

function cleanup(): void {
  runBackendScript(`
${PY_DELETE_IMAGES}
import shutil, sqlite3
from pathlib import Path
prefix = ${JSON.stringify(PREFIX)}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (prefix + "%",))
    conn.execute("DELETE FROM image_prompt_tokens WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (prefix + "%",))
    delete_images(conn, "filename LIKE ?", (prefix + "%",))
    for (lid,) in conn.execute("SELECT id FROM libraries WHERE name = ? AND id != 'main'", (${JSON.stringify(LIB_NAME)},)).fetchall():
        delete_images(conn, "library_id = ?", (lid,))
        conn.execute("DELETE FROM libraries WHERE id = ?", (lid,))
    conn.commit()
shutil.rmtree(Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(DIR)}, ignore_errors=True)
print("ok")
`)
}

test.beforeAll(() => {
  cleanup()
  seed()
})
test.afterAll(cleanup)

const count = (page: Page) => page.getByTestId('result-count')
const grid = (page: Page) => page.locator('[data-testid="gallery-scroller"]:not([aria-busy])')

async function search(page: Page, text: string, expected: number) {
  const input = page.getByTestId('query-input')
  await input.fill(text)
  await input.press('Enter')
  await expect(count(page)).toHaveText(`${expected.toLocaleString('en-US')} images`)
}

async function switchLibrary(page: Page, name: RegExp) {
  await page.getByTestId('library-switch').click()
  await page.getByRole('menu').getByRole('menuitemradio', { name }).click()
}

test('each library keeps its own search; a reload keeps it; both empty states offer the way out', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const created = await page.request.post('/api/libraries', { data: { name: LIB_NAME } })
  expect(created.ok()).toBe(true)
  const input = page.getByTestId('query-input')

  // a new library opens on everything it has: nothing yet, so it offers the import
  await page.reload()
  await switchLibrary(page, new RegExp(LIB_NAME))
  await expect(input).toHaveValue('')
  const empty = page.getByTestId('library-empty')
  await expect(empty).toContainText('This library has no images yet')
  await expect(empty.getByRole('button', { name: 'Import images…' })).toBeInViewport()
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)

  // a search there that finds nothing: "no matches", and Clear filters goes back to everything
  await search(page, 'nothingatall', 0)
  const noMatch = page.getByTestId('no-matches')
  await expect(noMatch).toContainText('No images match')
  await page.getByTestId('clear-filters').click()
  await expect(input).toHaveValue('')
  await expect(empty).toBeVisible()
  await search(page, 'kept-in-new-library', 0)

  // back in the main library: its own search, not the one typed in the other library
  await switchLibrary(page, /Main library/)
  await expect(input).toHaveValue(TOKEN)
  await expect(count(page)).toHaveText('300 images')

  // a reload keeps the search (and which library is open)
  await page.reload()
  await expect(input).toHaveValue(TOKEN)
  await expect(count(page)).toHaveText('300 images')
  await switchLibrary(page, new RegExp(LIB_NAME))
  await expect(input).toHaveValue('kept-in-new-library')
  await switchLibrary(page, /Main library/)
  await expect(input).toHaveValue(TOKEN)

  // "no matches" in a full library: Clear filters shows the whole library again
  await search(page, `${TOKEN} nothingatall`, 0)
  await page.getByTestId('clear-filters').click()
  await expect(input).toHaveValue('')
  await expect(grid(page)).toBeVisible()
  await expect(page.getByTestId('no-matches')).toHaveCount(0)
})

test('folder tree: a parent that only holds subfolders can be chosen, and scopes everything under it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const tree = page.getByTestId('folder-tree')
  const parent = tree.getByRole('button', { name: /^parent$/ })
  // alone in the database, the chain down to .tmp/v4-browse is one open top row;
  // next to other specs' folders it is a closed row under .tmp
  await expect(tree.getByRole('button', { name: /v4-browse$/ })).toBeVisible()
  const opener = tree.getByRole('button', { name: /v4-browse: folders inside$/ })
  if ((await opener.count()) && (await opener.getAttribute('aria-expanded')) === 'false') await opener.click()
  await expect(parent).toBeVisible()
  // parent's own subfolders start closed
  await expect(tree.getByRole('button', { name: /^a$/ })).toHaveCount(0)

  await parent.click()
  await expect(parent).toHaveAttribute('aria-pressed', 'true')
  await expect(count(page)).toHaveText('200 images')

  await tree.getByRole('button', { name: 'parent: folders inside' }).click()
  const a = tree.getByRole('button', { name: /^a$/ })
  await a.click()
  await expect(count(page)).toHaveText('100 images')
  // choosing it again shows every folder
  await a.click()
  await expect(a).toHaveAttribute('aria-pressed', 'false')
  await expect(count(page)).toHaveText('300 images')

  // a chosen folder is remembered with the search, and its row is open after a reload
  await a.click()
  await expect(count(page)).toHaveText('100 images')
  await page.reload()
  await expect(count(page)).toHaveText('100 images')
  await expect(tree.getByRole('button', { name: /^a$/ })).toHaveAttribute('aria-pressed', 'true')
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
})

test('6e: the folders opened and closed by hand stay so after a reload, per library', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const tree = page.getByTestId('folder-tree')
  const opener = tree.getByRole('button', { name: /v4-browse: folders inside$/ })
  if ((await opener.count()) && (await opener.getAttribute('aria-expanded')) === 'false') await opener.click()
  const parentOpener = tree.getByRole('button', { name: 'parent: folders inside' })
  await expect(parentOpener).toHaveAttribute('aria-expanded', 'false')
  await parentOpener.click()
  await expect(tree.getByRole('button', { name: /^a$/ })).toBeVisible()

  // nothing chosen, only opened: after a reload the same rows are open
  await page.reload()
  await expect(tree.getByRole('button', { name: 'parent: folders inside' })).toHaveAttribute('aria-expanded', 'true')
  await expect(tree.getByRole('button', { name: /^a$/ })).toBeVisible()
  // and closing it by hand is kept too
  await tree.getByRole('button', { name: 'parent: folders inside' }).click()
  await page.reload()
  await expect(tree.getByRole('button', { name: 'parent: folders inside' })).toHaveAttribute('aria-expanded', 'false')
  await expect(tree.getByRole('button', { name: /^a$/ })).toHaveCount(0)
  // kept under this library
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sd-v4-folder-tree') ?? '{}'))
  expect(Object.keys(stored)).toEqual(['main'])
})

test('"any of" tags and "prompt contains": search line, chips and the filter panel', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, TOKEN, COUNT)
  const input = page.getByTestId('query-input')
  const tiles = page.getByTestId('tile')

  // both tags: 30; either: 90, each image once even when it has both
  await search(page, `${TOKEN} tag:cat_ears tag:fox_ears`, 30)
  await search(page, `${TOKEN} tag:cat_ears|fox_ears`, 90)
  await expect(page.getByTestId('query-chips')).toContainText('any of')
  await grid(page).waitFor()
  const ids = await tiles.evaluateAll((els) => els.map((el) => el.getAttribute('data-id')))
  expect(new Set(ids).size).toBe(ids.length)

  // the filter panel writes the same thing: back to "all of them", then "any of them"
  await page.getByTestId('filter-button').click()
  const panel = page.getByTestId('filter-panel')
  await panel.getByTestId('filter-tag-mode').getByRole('button', { name: 'All of them' }).click()
  await expect(input).toHaveValue(`${TOKEN} tag:cat_ears tag:fox_ears`)
  await expect(count(page)).toHaveText('30 images')
  await panel.getByTestId('filter-tag-mode').getByRole('button', { name: 'Any of them' }).click()
  await expect(input).toHaveValue(`${TOKEN} tag:cat_ears|fox_ears`)
  await expect(count(page)).toHaveText('90 images')
  await page.keyboard.press('Escape')

  // prompt: whole words find "blue eyes" only; contains also finds "light blue eyes"
  await search(page, `${TOKEN} prompt:"*blue eyes*"`, 60)
  await expect(page.getByTestId('query-chips')).toContainText('contains')
  await page.getByTestId('filter-button').click()
  await panel.getByTestId('filter-prompt-mode').getByRole('button', { name: 'Whole words' }).click()
  await expect(input).toHaveValue(`${TOKEN} prompt:"blue eyes"`)
  await grid(page).waitFor()
  await expect(tiles).toHaveCount(30)
  // 6e: the backend counts "light blue eyes" too before it checks whole words; every image is here, so the count is theirs
  await expect(count(page)).toHaveText('30 images')

  // adding a word in the panel follows the mode shown
  await panel.getByTestId('filter-prompt-mode').getByRole('button', { name: 'Contains the text' }).click()
  await expect(count(page)).toHaveText('60 images')
  await panel.getByTestId('filter-prompt-input').fill('light')
  await panel.getByTestId('filter-prompt-input').press('Enter')
  await expect(input).toHaveValue(`${TOKEN} prompt:"*blue eyes*" prompt:*light*`)
  await expect(count(page)).toHaveText('30 images')
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
})

test('6e: a whole-word prompt count the backend can only estimate says "about" until every page is here', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  // 300 images, 240 a page: the first page cannot tell how many really have the word
  const input = page.getByTestId('query-input')
  await input.fill(`${TOKEN} prompt:1girl`)
  await input.press('Enter')
  await expect(count(page)).toHaveText('about 300 images')
  // the rest loads as the grid scrolls to its end: now it is a count
  await grid(page).waitFor()
  const scroller = page.getByTestId('gallery-scroller')
  await expect
    .poll(async () => {
      await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
      return count(page).textContent()
    })
    .toBe('300 images')
  // "contains" is counted exactly by the backend: no "about"
  await input.fill(`${TOKEN} prompt:*1girl*`)
  await input.press('Enter')
  await expect(count(page)).toHaveText('300 images')
})

async function topSpot(page: Page): Promise<{ id: number; index: number } | null> {
  return page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('sd-v4-scroll') ?? '{}') as Record<string, { id: number; index: number }>
    return raw.main ?? null
  })
}

test('the grid comes back to the same images after a reload and after another tab', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const scroller = page.getByTestId('gallery-scroller')

  // deep enough that coming back needs the second page of results (240 per page)
  const last = page.locator('[data-testid="tile"][aria-posinset="300"]')
  await expect
    .poll(async () => {
      await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
      return last.count()
    })
    .toBe(1)
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight * 0.92 }))
  await expect.poll(async () => (await topSpot(page))?.index ?? 0).toBeGreaterThan(240)
  const spot = (await topSpot(page))!

  await page.reload()
  await expect(count(page)).toHaveText('300 images')
  const tile = page.locator(`[data-testid="tile"][data-id="${spot.id}"]`)
  await expect(tile).toBeInViewport()
  await expect(page.getByRole('status').filter({ hasText: 'Back where you left off' })).toBeVisible()

  // another tab and back
  await page.getByRole('navigation', { name: 'main' }).getByRole('button', { name: 'Batches' }).click()
  await expect(page.getByTestId('gallery-scroller')).toHaveCount(0)
  await page.getByRole('navigation', { name: 'main' }).getByRole('button', { name: 'Library' }).click()
  await expect(tile).toBeInViewport()

  // a new search starts at the top
  await search(page, `${TOKEN} tag:cat_ears`, 60)
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0)
})

test('screen readers: tiles say their place and name; the skip link jumps past the top bar', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, TOKEN, COUNT)
  const list = page.getByRole('list', { name: 'Images' })
  await expect(list).toBeVisible()
  const first = list.getByRole('listitem').first()
  await expect(first).toHaveAttribute('aria-label', /^Image 1 of 300: v4br-000\.png/)
  await expect(first).toHaveAttribute('aria-setsize', '300')

  // moving with the keys is announced
  const announce = page.getByTestId('grid-announce')
  await page.getByTestId('tile').first().click()
  await expect(announce).toHaveText('Image 1 of 300: v4br-000.png')
  // → goes to the next column at the same height (masonry), wherever that is in the list
  await page.keyboard.press('ArrowRight')
  const moved = await page.locator('[data-testid="tile"][data-inspected]').getAttribute('aria-posinset')
  expect(moved).not.toBe('1')
  await expect(announce).toHaveText(new RegExp(`^Image ${moved} of 300: v4br-\\d{3}\\.png$`))

  // the first Tab from the page start lands on the skip link, which moves focus to the main area
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Tab')
  const skip = page.getByTestId('skip-link')
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport()
  await expect(skip).toHaveText('Skip to main content')
  // Enter presses the focused link even with an image inspected (it used to open the big image)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('query-input')).toBeFocused()
  // with focus off the controls, Enter still opens the inspected image
  await page.getByTestId('tile').first().click()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('lightbox')).toBeVisible()
})
