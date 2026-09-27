import { expect, test, type Page } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { dbPath, pageOverflow, runBackendScript, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'
import { PY_DELETE_IMAGES } from '../fixtures/e2e-db'

/**
 * V4 Home film strip (slice 6c): ★5 images first (newest first), then the
 * newest images to fill, each once; a frame (click, or arrows + Enter) opens
 * the big image on that image; "See all ★5" opens the library with the ★5
 * search; an empty library shows the plain empty state that points to Import.
 *
 * The rows live in two libraries of their own, so no other spec's images reach
 * the strip. Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const LIBRARY = 'v4home_lib'
const EMPTY_LIBRARY = 'v4home_empty'
const DIR = 'v4-home'
const PREFIX = 'v4home-'

/** name, stars, minutes ago (the library's "newest" order). */
const ROWS: [string, number, number][] = [
  ['star-a', 5, 10],
  ['star-b', 5, 20],
  ['star-c', 5, 30],
  ['new-a', 0, 1],
  ['new-b', 0, 2],
  ['new-c', 0, 3],
  ['new-d', 0, 4],
  ['three', 3, 5],
]
const STRIP_ORDER = ['star-a', 'star-b', 'star-c', 'new-a', 'new-b', 'new-c', 'new-d', 'three']

let ids: Record<string, number> = {}

function dropLibraries(): void {
  runBackendScript(`
${PY_DELETE_IMAGES}
import shutil, sqlite3
from pathlib import Path
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    for lid in (${JSON.stringify(LIBRARY)}, ${JSON.stringify(EMPTY_LIBRARY)}):
        delete_images(conn, "library_id = ?", (lid,))
        conn.execute("DELETE FROM libraries WHERE id = ?", (lid,))
    conn.commit()
shutil.rmtree(Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(DIR)}, ignore_errors=True)
print("ok")
`)
}

/** Two libraries of the spec's own; the rows (with real little PNGs) go into the first. */
function seed(): Record<string, number> {
  const out = runBackendScript(`
import json, shutil, sqlite3
from pathlib import Path
from PIL import Image
root = Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(DIR)}
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)
rows = ${JSON.stringify(ROWS)}
shapes = [(64, 96), (96, 64), (80, 80), (48, 120)]
ids = {}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    for lid, name in ((${JSON.stringify(LIBRARY)}, "V4 e2e home"), (${JSON.stringify(EMPTY_LIBRARY)}, "V4 e2e home empty")):
        conn.execute("INSERT OR IGNORE INTO libraries (id, name, is_default) VALUES (?, ?, 0)", (lid, name))
    for i, (key, stars, minutes) in enumerate(rows):
        w, h = shapes[i % len(shapes)]
        name = ${JSON.stringify(PREFIX)} + key + ".png"
        path = (root / name).resolve()
        Image.new("RGB", (w, h), (60 + i * 20, 90, 140)).save(path)
        cur = conn.execute(
            """INSERT INTO images (path, filename, generator, prompt, width, height, file_size, is_readable,
                   metadata_status, created_at, library_order_time, user_rating, library_id)
               VALUES (?, ?, 'nai', '1girl', ?, ?, ?, 1, 'complete', datetime('now', ?), datetime('now', ?), ?, ?)""",
            (str(path), name, w, h, path.stat().st_size, f"-{minutes} minutes", f"-{minutes} minutes", stars, ${JSON.stringify(LIBRARY)}),
        )
        ids[key] = cur.lastrowid
    conn.commit()
print(json.dumps(ids))
`)
  return JSON.parse(out.split('\n').at(-1) ?? '{}') as Record<string, number>
}

test.beforeAll(() => {
  dropLibraries()
  ids = seed()
})
test.afterAll(() => dropLibraries())
test.beforeEach(async ({ page }) => markModelsReady(page))

/** Open Home in English on a library, once per page (reloads keep what the test changed). */
async function openHome(page: Page, library: string, theme: 'dark' | 'light' = 'dark') {
  await page.addInitScript(
    ([lib, th]) => {
      if (sessionStorage.getItem('v4home-init')) return
      sessionStorage.setItem('v4home-init', '1')
      localStorage.setItem('sd-image-sorter-lang', 'en')
      localStorage.setItem('sd-v4-theme', th)
      localStorage.setItem('sd-v4-update-autocheck', '0')
      localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: lib }))
      localStorage.removeItem('sd-v4-browse')
    },
    [library, theme] as const,
  )
  const res = await page.goto('/v4/#/home', { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('home')).toBeVisible()
}

const frameIds = (page: Page) => page.getByTestId('home-frame').evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.imageId)))

test('the film shows the ★5 images first, newest first, then the newest ones, each once', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openHome(page, LIBRARY)
  await expect(page.locator('[data-testid="home-film"]:not([aria-busy])')).toBeVisible()
  await expect(page.getByTestId('home-frame')).toHaveCount(ROWS.length)
  expect(await frameIds(page)).toEqual(STRIP_ORDER.map((key) => ids[key]))

  const frames = page.getByTestId('home-frame')
  await expect(frames.nth(0)).toHaveAttribute('aria-label', `Image 1 of 8: ${PREFIX}star-a.png, 5 stars`)
  await expect(frames.nth(3)).toHaveAttribute('aria-label', `Image 4 of 8: ${PREFIX}new-a.png`)
  await expect(frames.nth(7)).toHaveAttribute('aria-label', `Image 8 of 8: ${PREFIX}three.png, 3 stars`)
  await expect(page.getByTestId('home-film-all')).toContainText('See all ★5 in the library')
  await expect(page.getByTestId('home-film-all')).toContainText('3 images')
  // one frame in the Tab order: the first
  await expect(frames.nth(0)).toHaveAttribute('tabindex', '0')
  await expect(frames.nth(1)).toHaveAttribute('tabindex', '-1')
})

test('a frame opens the big image on that image; arrows and Enter do the same', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openHome(page, LIBRARY)
  const frames = page.getByTestId('home-frame')
  await expect(frames.first()).toBeVisible()

  await frames.nth(1).click()
  const lightbox = page.getByTestId('lightbox')
  await expect(lightbox).toBeVisible()
  await expect(lightbox.locator('header').first()).toContainText(`2 / 8`)
  await expect(lightbox.locator('header').first()).toContainText(`${PREFIX}star-b.png`)
  await page.keyboard.press('ArrowRight')
  await expect(lightbox.locator('header').first()).toContainText(`${PREFIX}star-c.png`)
  await page.keyboard.press('Escape')
  await expect(lightbox).toHaveCount(0)
  await expect(page.getByTestId('home')).toBeVisible()

  await frames.first().focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(frames.nth(3)).toBeFocused()
  await expect(frames.nth(3)).toHaveAttribute('tabindex', '0')
  await page.keyboard.press('ArrowLeft')
  await expect(frames.nth(2)).toBeFocused()
  await page.keyboard.press('End')
  await expect(frames.last()).toBeFocused()
  await page.keyboard.press('Home')
  await expect(frames.first()).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await expect(lightbox).toBeVisible()
  await expect(lightbox.locator('header').first()).toContainText(`${PREFIX}star-b.png`)
  await page.keyboard.press('Escape')
  await expect(lightbox).toHaveCount(0)
})

test('"See all ★5" opens the library with the ★5 search', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openHome(page, LIBRARY)
  await page.getByTestId('home-film-all').click()
  await expect(page.getByTestId('query-input')).toHaveValue('★5')
  await expect(page.getByTestId('result-count')).toHaveText('3 images')
  await page.locator('[data-testid="gallery-scroller"]:not([aria-busy])').waitFor()
  const tiles = await page.getByTestId('tile').evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.id)))
  expect(tiles).toEqual(['star-a', 'star-b', 'star-c'].map((key) => ids[key]))
})

test('an empty library shows a plain note that points to Import', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openHome(page, EMPTY_LIBRARY)
  const empty = page.getByTestId('home-empty')
  await expect(empty).toBeVisible()
  await expect(empty).toContainText('This library has no images yet')
  await expect(page.getByTestId('home-film')).toHaveCount(0)
  await expect(page.getByTestId('home-start-sort')).toBeInViewport({ ratio: 1 })
  await page.getByTestId('home-empty-import').click()
  await expect(page.getByTestId('import-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('import-dialog')).toHaveCount(0)
})

for (const viewport of VIEWPORTS) {
  for (const theme of ['dark', 'light'] as const) {
    test(`the film fits at ${viewport.width}x${viewport.height} (${theme})`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await openHome(page, LIBRARY, theme)
      await expect(page.getByTestId('home-frame')).toHaveCount(ROWS.length)
      await expect(page.getByTestId('home-film-all')).toBeInViewport({ ratio: 1 })
      await expect(page.getByTestId('home-start-sort')).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      // every frame and the end sit whole on the film, in one row, none over another; the film spans the window
      const film = await page.getByTestId('home-film').evaluate((el) => {
        const box = el.getBoundingClientRect()
        const parts = [...el.querySelectorAll('[data-testid="home-frame"], [data-testid="home-film-all"]')].map((p) => p.getBoundingClientRect())
        return {
          inside: parts.every((p) => p.left >= box.left && p.right <= box.right && p.top >= box.top && p.bottom <= box.bottom),
          apart: parts.every((p, i) => i === 0 || p.left >= parts[i - 1]!.right - 0.5),
          spans: Math.abs(box.left) < 1 && Math.abs(box.right - window.innerWidth) < 1,
        }
      })
      expect(film).toEqual({ inside: true, apart: true, spans: true })
    })
  }
}
