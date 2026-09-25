import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

/**
 * V4 library page (served by the same backend at /v4/, next to V3.5 at /).
 * Seeds its own images into the isolated test database, tagged with a search
 * token so other specs' rows never leak in, and removes them afterwards.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const TOKEN = 'v4e2etoken'
const COUNT = 24
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]

function backendPython(): string {
  const candidates = process.platform === 'win32'
    ? [path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'), 'python']
    : [path.join(repoRoot, 'backend', 'venv', 'bin', 'python'), 'python3']
  return process.env.PW_BACKEND_PYTHON || candidates.find((c) => !c.includes(path.sep) || fsSync.existsSync(c)) || candidates[0]!
}

function runBackendScript(script: string): string {
  return execFileSync(backendPython(), ['-X', 'utf8', '-c', script], { cwd: repoRoot, stdio: 'pipe' })
    .toString('utf8')
    .trim()
}

const dbPath = process.env.SD_IMAGE_SORTER_DB_PATH || path.join(repoRoot, 'data', 'images.db')

function seed(): void {
  runBackendScript(`
import json, shutil, sqlite3
from pathlib import Path
from PIL import Image

root = Path(${JSON.stringify(repoRoot)}) / ".tmp" / "v4-e2e"
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)
shapes = [(64, 96), (96, 64), (80, 80), (48, 120)]
meta = json.dumps({"_parsed": {"generation_params": {"steps": 28, "sampler": "k_euler", "seed": 424242, "cfg_scale": 5}}})
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    cur.execute("DELETE FROM image_prompt_tokens WHERE image_id IN (SELECT id FROM images WHERE filename LIKE 'v4e2e-%')")
    cur.execute("DELETE FROM images WHERE filename LIKE 'v4e2e-%'")
    for i in range(${COUNT}):
        w, h = shapes[i % len(shapes)]
        name = f"v4e2e-{i:02d}.png"
        path = (root / name).resolve()
        Image.new("RGB", (w, h), (40 + i * 8, 90, 160 - i * 4)).save(path)
        prompt = f"${TOKEN}, 1girl, (silver hair:1.2), smile, frame {i}"
        cur.execute(
            """INSERT INTO images (path, filename, generator, prompt, negative_prompt, metadata_json,
                   width, height, file_size, source_size, source_mtime_ns, is_readable, metadata_status,
                   created_at, library_order_time, user_rating)
               VALUES (?, ?, 'nai', ?, 'lowres', ?, ?, ?, ?, ?, ?, 1, 'complete',
                   datetime('now', ?), datetime('now', ?), 0)""",
            (str(path), name, prompt, meta, w, h, path.stat().st_size, path.stat().st_size,
             path.stat().st_mtime_ns, f"-{i} minutes", f"-{i} minutes"),
        )
        image_id = cur.lastrowid
        for token in ("${TOKEN}", "1girl", "silver hair", "smile"):
            cur.execute("INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)", (image_id, token))
    conn.commit()
print("ok")
`)
}

function cleanup(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("DELETE FROM image_prompt_tokens WHERE image_id IN (SELECT id FROM images WHERE filename LIKE 'v4e2e-%')")
    conn.execute("DELETE FROM images WHERE filename LIKE 'v4e2e-%'")
    conn.commit()
print("ok")
`)
}

async function openLibrary(page: Page, theme: 'dark' | 'light' = 'dark') {
  // Seed language and theme once per page, so a later reload keeps what the test changed.
  await page.addInitScript((th) => {
    const flag = 'v4e2e-init-' + th
    if (sessionStorage.getItem(flag)) return
    sessionStorage.setItem(flag, '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', th)
  }, theme)
  const res = await page.goto('/v4/', { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  const input = page.getByTestId('query-input')
  await input.fill(TOKEN)
  await input.press('Enter')
  await expect(page.getByTestId('result-count')).toHaveText(`${COUNT} images`)
  await expect(page.locator('[data-testid="gallery-scroller"]:not([aria-busy])')).toBeVisible()
}

async function ratingOf(page: Page, id: string): Promise<number> {
  return page.evaluate(async (x) => (await (await fetch(`/api/images/${x}`)).json()).image.user_rating, id)
}

test.beforeAll(() => seed())
test.afterAll(() => cleanup())

for (const viewport of VIEWPORTS) {
  test(`layout fits at ${viewport.width}x${viewport.height} in both themes`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      await openLibrary(page, theme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await page.getByTestId('tile').first().click()
      await expect(page.getByTestId('generation-card')).toContainText('v4e2e-')
      for (const id of ['query-input', 'result-count', 'open-palette', 'theme-toggle']) {
        await expect(page.getByTestId(id)).toBeInViewport()
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    }
  })
}

test('keys: arrows move, number keys rate, space picks', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  await page.getByTestId('tile').first().click()
  const inspected = page.locator('[data-testid="tile"][data-inspected]')
  const first = await inspected.getAttribute('data-id')
  await page.keyboard.press('ArrowRight')
  const second = await inspected.getAttribute('data-id')
  expect(second).not.toBe(first)

  await page.keyboard.press('4')
  await expect.poll(() => ratingOf(page, second!)).toBe(4)
  await page.keyboard.press('0')
  await expect.poll(() => ratingOf(page, second!)).toBe(0)

  await page.keyboard.press('Space')
  await expect(page.getByTestId('selection-bar')).toBeInViewport()
  await expect(page.getByTestId('selection-bar')).toContainText('1 picked')
})

test('Esc closes only the topmost layer', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page)
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await tiles.nth(1).click({ modifiers: ['Control'] })
  await expect(page.getByTestId('selection-bar')).toContainText('2 picked')

  // lightbox, then the palette on top of it
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('palette')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('palette')).toHaveCount(0)
  await expect(page.getByTestId('lightbox')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
  await expect(page.getByTestId('selection-bar')).toContainText('2 picked')

  // a menu is a layer too: Esc closes it and leaves the picks alone
  await page.getByRole('button', { name: /^Sort\s*[:：]/ }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByTestId('selection-bar')).toContainText('2 picked')

  // nothing floating: Esc clears the picks
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)
})

test('lightbox shows tall images whole', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  // v4e2e-03 is 48x120, the tallest shape
  await page.locator('[data-testid="tile"]').filter({ has: page.locator('img') }).nth(3).dblclick()
  await expect(page.getByTestId('lightbox')).toBeVisible()
  const fits = await page.evaluate(() => {
    const stage = document.querySelector('[data-testid="lightbox"] [class*="stage"]')
    const wrap = stage?.querySelector('[class*="imgWrap"]')
    if (!stage || !wrap) return false
    const s = stage.getBoundingClientRect()
    const w = wrap.getBoundingClientRect()
    return w.top >= s.top - 1 && w.bottom <= s.bottom + 1 && w.left >= s.left - 1 && w.right <= s.right + 1
  })
  expect(fits).toBe(true)
})

test('theme toggle cycles and survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, 'dark')
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('search: suggestions, chips and warnings', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  const input = page.getByTestId('query-input')

  // library values: prompt tokens come with counts; Esc closes only the list
  await input.fill(`${TOKEN} prompt:silv`)
  const suggest = page.getByTestId('query-suggest')
  await expect(suggest).toContainText('silver hair')
  await page.keyboard.press('Escape')
  await expect(suggest).toHaveCount(0)
  await expect(input).toHaveValue(`${TOKEN} prompt:silv`)

  // typing again reopens it; Enter takes the highlighted value (quoted, it has a space)
  await input.press('End')
  await input.pressSequentially('e')
  await expect(suggest).toContainText('silver hair')
  await input.press('Enter')
  await expect(input).toHaveValue(`${TOKEN} prompt:"silver hair" `)
  await expect(page.getByTestId('result-count')).toHaveText('24 images')

  // enum keys suggest their fixed values
  await input.fill(`${TOKEN} gen:n`)
  await expect(suggest).toContainText('nai')
  await input.press('Enter')
  await expect(input).toHaveValue(`${TOKEN} gen:nai `)

  // a chip removes its own condition
  const chips = page.getByTestId('query-chips')
  await chips.getByRole('button', { name: /Source/ }).click()
  await expect(input).toHaveValue(TOKEN)

  // a value the language doesn't know becomes a warning, not a silent filter
  await input.fill(`${TOKEN} rating:blue`)
  await expect(chips).toContainText('unknown rating')
  await expect(page.getByTestId('result-count')).toHaveText('24 images')

  // the ? panel lists the syntax and an example adds itself
  await page.getByTestId('query-help').click()
  await page.getByRole('button', { name: 'score>=7' }).click()
  await expect(input).toHaveValue(/score>=7$/)
})
