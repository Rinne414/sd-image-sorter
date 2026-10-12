import { expect, test, type Locator, type Page } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, dbPath, pageOverflow, runBackendScript, scrollToMiddle, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 at launch (slice 6l): a plain /v4/ opens Home, as V3.5 opens on its
 * entry page; Settings › Appearance › "Open at start" can make it the library;
 * an address that names a page opens that page either way. "Show the ★5 film
 * strip on Home" off: Home shows no film and asks for none of its images, the
 * rest of Home stays.
 *
 * The rows (★5, so the film would show them) live in a library of their own.
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const PREFIX = 'v4launch-'
const TOKEN = 'v4launchtoken'
const DIR = 'v4-launch'
const LIBRARY = 'v4launch_lib'
let ids: number[] = []

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: 4, dir: DIR })
  const out = runBackendScript(`
import json, sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("INSERT OR IGNORE INTO libraries (id, name, is_default) VALUES (?, 'V4 e2e launch', 0)", (${JSON.stringify(LIBRARY)},))
    conn.execute(
        "UPDATE images SET library_id = ?, user_rating = 5 WHERE filename LIKE ? AND filename NOT LIKE ?",
        (${JSON.stringify(LIBRARY)}, ${JSON.stringify(PREFIX + '%')}, ${JSON.stringify(PREFIX + 'cache%')}),
    )
    conn.commit()
    rows = [r[0] for r in conn.execute("SELECT id FROM images WHERE library_id = ? ORDER BY id", (${JSON.stringify(LIBRARY)},))]
print(json.dumps(rows))
`)
  ids = JSON.parse(out.split('\n').at(-1) ?? '[]') as number[]
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR])
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("DELETE FROM libraries WHERE id = ?", (${JSON.stringify(LIBRARY)},))
    conn.commit()
print("ok")
`)
})

test.beforeEach(async ({ page }) => markModelsReady(page))

/** A fresh V4 (no preferences stored) in English, in the spec's library, at `address`. */
async function launch(page: Page, address: string) {
  await page.addInitScript((library) => {
    if (sessionStorage.getItem('v4launch-init')) return
    sessionStorage.setItem('v4launch-init', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.setItem('sd-v4-update-autocheck', '0')
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: library }))
    localStorage.removeItem('sd-v4-prefs')
  }, LIBRARY)
  const res = await page.goto(address, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

/** Click one choice of a setting (the radio is the whole label). */
const choose = (setting: Locator, name: string) => setting.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()

const storedPrefs = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('sd-v4-prefs') || '{}'))

test('a plain launch opens Home by default; an address that names a page opens that page', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await launch(page, '/v4/')
  await expect(page.getByTestId('home')).toBeVisible()
  await expect(page.getByTestId('home-film')).toBeVisible()
  expect(new URL(page.url()).hash).toBe('')

  await page.goto('/v4/#/library')
  await expect(page.getByTestId('query-input')).toBeVisible()
  await expect(page.getByTestId('home')).toHaveCount(0)
  await page.goto('/v4/#/settings/appearance')
  await expect(page.getByTestId('settings-page')).toBeVisible()
  // a reload of a plain address opens the start page again
  await page.goto('/v4/')
  await expect(page.getByTestId('home')).toBeVisible()
})

test('"Open at start: Library" makes a plain launch open the library; Home is still one address away', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await launch(page, '/v4/#/settings/appearance')
  const start = page.getByTestId('setting-start')
  await expect(start.locator('label[data-checked]')).toHaveText('Home')
  await choose(start, 'Library')
  await expect(start.getByRole('status')).toHaveText('Saved')
  expect((await storedPrefs(page)).startPage).toBe('library')

  await page.goto('/v4/')
  await expect(page.getByTestId('query-input')).toBeVisible()
  await expect(page.getByTestId('home')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('query-input')).toBeVisible()
  await page.goto('/v4/#/home')
  await expect(page.getByTestId('home')).toBeVisible()

  // and back to Home
  await page.goto('/v4/#/settings/appearance')
  await choose(page.getByTestId('setting-start'), 'Home')
  await page.goto('/v4/')
  await expect(page.getByTestId('home')).toBeVisible()
})

test('film off: Home shows no film and asks for none of its images, the rest stays; on again, the film is back', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await launch(page, '/v4/#/settings/appearance')
  const film = page.getByTestId('setting-film')
  await expect(film.locator('label[data-checked]')).toHaveText('Show')
  await choose(film, 'Hide')
  await expect(film.getByRole('status')).toHaveText('Saved')
  expect((await storedPrefs(page)).homeFilm).toBe(false)

  // every request the film would make: the image lists, and the spec's images
  const asked: string[] = []
  const filmRequest = (url: string) => {
    const { pathname } = new URL(url)
    return pathname === '/api/images' || ids.some((id) => pathname === `/api/image-thumbnail/${id}` || pathname === `/api/image-file/${id}`)
  }
  page.on('request', (r) => {
    if (filmRequest(r.url())) asked.push(r.url())
  })
  await page.goto('/v4/')
  await expect(page.getByTestId('home')).toBeVisible()
  await expect(page.getByTestId('home-start-sort')).toBeVisible()
  await expect(page.getByTestId('home')).toContainText('V4 e2e launch')
  await page.waitForLoadState('networkidle')
  await expect(page.getByTestId('home-film')).toHaveCount(0)
  expect(asked).toEqual([])

  await page.goto('/v4/#/settings/appearance')
  await choose(page.getByTestId('setting-film'), 'Show')
  await page.goto('/v4/#/home')
  await expect(page.getByTestId('home-film')).toBeVisible()
  await expect.poll(() => asked.some((u) => new URL(u).pathname === '/api/images')).toBe(true)
})

for (const viewport of VIEWPORTS) {
  test(`the two rows and Home without the film fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await launch(page, '/v4/#/settings/appearance')
    for (const id of ['setting-start', 'setting-film']) {
      const row = page.getByTestId(id)
      await scrollToMiddle(row)
      await expect(row).toBeInViewport({ ratio: 1 })
    }
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    await choose(page.getByTestId('setting-film'), 'Hide')
    await page.goto('/v4/#/home')
    await expect(page.getByTestId('home-start-sort')).toBeInViewport()
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  })
}
