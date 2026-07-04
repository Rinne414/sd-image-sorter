import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

/**
 * Search bar v2 (owner request 2026-07-05): the key:value search grows into a
 * full query language over every existing FilterStore field, with
 *   1. comparison operators (score>=7), negation (-tag:x), narrowing
 *      (gen:nai rating:g), zh aliases, size/aspect/color/brightness/… keys;
 *   2. a live "understood as" preview line + ⚠ chips for bad values;
 *   3. a ? syntax-help modal and a filter-modal button NEXT TO the box;
 *   4. Danbooru-style fuzzy value autocomplete from the library endpoints.
 *
 * Everything maps onto existing backend params — these tests assert the
 * FilterStore state (window.App.AppState.filters), not new endpoints.
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1600, height: 900 } })

const repoRoot = path.resolve(__dirname, '..', '..', '..')

function commandExists(candidate: string): boolean {
  if (candidate.includes(path.sep) || candidate.includes('/')) {
    return fsSync.existsSync(candidate)
  }
  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    return execFileSync(lookupCommand, [candidate], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0
  } catch {
    return false
  }
}

const backendPythonCandidates = process.platform === 'win32' ? [
  path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
  path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
  'python',
] : [
  path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
  'python3',
  'python',
  path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
]

const backendPython = process.env.PW_BACKEND_PYTHON
  || backendPythonCandidates.find((candidate) => commandExists(candidate))
  || backendPythonCandidates[0]
const runtimeDatabasePath = process.env.SD_IMAGE_SORTER_DB_PATH
  || path.join(repoRoot, 'data', 'images.db')

const FIXTURE_TAG = 'v350_searchv2_silverhair'

function runBackendScript(script: string): string {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: repoRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

/** A handful of images carrying a distinctive tag for autocomplete tests. */
function resetSearchFixture(): number[] {
  const script = `
import json
import shutil
import sqlite3
from pathlib import Path
from PIL import Image

repo_root = Path(${JSON.stringify(repoRoot)})
root = repo_root / ".tmp" / "v350-search-v2"
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
ids = []
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE 'v350-search-%')"
    )
    cur.execute("DELETE FROM images WHERE filename LIKE 'v350-search-%'")
    for index in range(1, 7):
        filename = f"v350-search-{index}.png"
        image_path = (root / filename).resolve()
        Image.new("RGB", (64, 64), color=(120, 60 + index * 20, 200)).save(image_path)
        cur.execute(
            """
            INSERT INTO images (
                path, filename, generator, prompt, negative_prompt, metadata_json,
                width, height, file_size, source_size, source_mtime_ns,
                is_readable, read_error, metadata_status, created_at
            ) VALUES (?, ?, 'unknown', 'search fixture', '', NULL, 64, 64, ?, ?, ?, 1, NULL, 'complete', CURRENT_TIMESTAMP)
            """,
            (
                str(image_path), filename,
                image_path.stat().st_size, image_path.stat().st_size,
                image_path.stat().st_mtime_ns,
            ),
        )
        image_id = cur.lastrowid
        ids.append(image_id)
        cur.execute(
            "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, 0.9)",
            (image_id, ${JSON.stringify(FIXTURE_TAG)}),
        )
    conn.commit()
print(json.dumps(ids))
`
  return JSON.parse(runBackendScript(script)) as number[]
}

function cleanupSearchFixture() {
  const script = `
import shutil
import sqlite3
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE 'v350-search-%')"
    )
    cur.execute("DELETE FROM images WHERE filename LIKE 'v350-search-%'")
    conn.commit()
shutil.rmtree(repo_root / ".tmp" / "v350-search-v2", ignore_errors=True)
print("ok")
`
  runBackendScript(script)
}

async function openGallery(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const w = window as any
      return Boolean(w.App && typeof w.App.loadImages === 'function' && w.App.AppState?.isLoading === false)
    })
  }).toBe(true)
}

async function filterState(page: Page): Promise<any> {
  return await page.evaluate(() => (window as any).App.AppState.filters)
}

test.beforeAll(() => {
  const ids = resetSearchFixture()
  expect(ids.length).toBe(6)
})

test.afterAll(() => {
  cleanupSearchFixture()
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('parser maps the full grammar onto FilterStore shapes', async ({ page }) => {
  await openGallery(page)

  const parsed = await page.evaluate(() => {
    const q = (window as any).GallerySearchQuery
    return {
      score: q.parse('score>=7').scalars,
      scoreSpaced: q.parse('score >= 7').scalars,
      scoreRange: q.parse('score:6..8').scalars,
      scoreNone: q.parse('score:none').scalars,
      size: q.parse('size:1024x1536').scalars,
      widthZh: q.parse('宽>=1024').scalars,
      negTag: q.parse('-tag:blurry').excludeTags,
      notEq: q.parse('tag!=blurry').excludeTags,
      narrow: { gen: q.parse('gen:nai').generators, rating: q.parse('rating:g').ratings },
      model: q.parse('model:noobai').checkpoints,
      colorZh: q.parse('主题:暖').scalars,
      contains: q.parse('contains(red)').freeText,
      quoted: q.parse('prompt:"long hair"').prompts,
      hueRed: q.parse('color:red').colorHues,
      hueZh: q.parse('color:蓝').colorHues,
      negHue: q.parse('-color:粉').excludeColorHues,
      warnColor: q.parse('color:sparkly').warnings.length,
      warnStars: q.parse('stars<=2').warnings.length,
      starsOk: q.parse('stars>=4').scalars,
      hasNo: { has: q.parse('has:params').scalars, no: q.parse('no:caption').scalars },
      unknownKeyFree: q.parse('re:zero').freeText,
    }
  })

  expect(parsed.score.minAesthetic).toBe(7)
  expect(parsed.scoreSpaced.minAesthetic).toBe(7)
  expect(parsed.scoreRange).toMatchObject({ minAesthetic: 6, maxAesthetic: 8 })
  expect(parsed.scoreNone.aestheticUnscored).toBe(true)
  expect(parsed.size).toMatchObject({ minWidth: 1024, maxWidth: 1024, minHeight: 1536, maxHeight: 1536 })
  expect(parsed.widthZh.minWidth).toBe(1024)
  expect(parsed.negTag).toEqual(['blurry'])
  expect(parsed.notEq).toEqual(['blurry'])
  expect(parsed.narrow.gen).toEqual(['nai'])
  expect(parsed.narrow.rating).toEqual(['general'])
  expect(parsed.model).toEqual(['noobai'])
  expect(parsed.colorZh.colorTemperature).toBe('warm')
  expect(parsed.contains).toEqual(['red'])
  expect(parsed.quoted).toEqual(['long hair'])
  expect(parsed.hueRed).toEqual(['red'])
  expect(parsed.hueZh).toEqual(['blue'])
  expect(parsed.negHue).toEqual(['pink'])
  expect(parsed.warnColor).toBe(1)
  expect(parsed.warnStars).toBe(1)
  expect(parsed.starsOk.minUserRating).toBe(4)
  expect(parsed.hasNo.has.hasMetadata).toBe(true)
  expect(parsed.hasNo.no.noCaption).toBe(true)
  expect(parsed.unknownKeyFree).toEqual(['re:zero'])
})

test('typing a compound query applies filters; clearing restores box-owned fields only', async ({ page }) => {
  await openGallery(page)
  const input = page.locator('#gallery-search-input')

  await input.fill('score>=7 width>=1024 -tag:blurry gen:nai rating:g aspect:portrait color:warm color:red -color:粉 no:caption')
  await input.press('Enter')

  await expect.poll(async () => (await filterState(page)).minAesthetic).toBe(7)
  const applied = await filterState(page)
  expect(applied.minWidth).toBe(1024)
  expect(applied.excludeTags).toContain('blurry')
  expect(applied.generators).toEqual(['nai'])
  expect(applied.ratings).toEqual(['general'])
  expect(applied.aspectRatio).toBe('portrait')
  expect(applied.colorTemperature).toBe('warm')
  expect(applied.colorHues).toEqual(['red'])
  expect(applied.excludeColorHues).toEqual(['pink'])
  expect(applied.noCaption).toBe(true)

  // The preview line narrates the parse.
  await expect(page.locator('#gallery-search-preview')).toBeVisible()
  expect(await page.locator('#gallery-search-preview .gsq-chip').count()).toBeGreaterThanOrEqual(7)

  // Clearing the box resets everything the box wrote — scalars and the
  // narrowed generator/rating sets — but ADDITIVE list entries stay until
  // removed via the sidebar (documented semantics).
  await page.locator('#gallery-search-clear').click()
  await expect.poll(async () => (await filterState(page)).minAesthetic).toBe(null)
  const cleared = await filterState(page)
  expect(cleared.minWidth).toBe(null)
  expect(cleared.generators.length).toBeGreaterThan(1)
  expect(cleared.ratings.length).toBe(4)
  expect(cleared.aspectRatio).toBe('')
  expect(cleared.colorTemperature).toBe('')
  expect(cleared.noCaption).toBe(null)
  expect(cleared.excludeTags).toContain('blurry')

  // Modal/chip-set values survive box edits: arm the aesthetic chip, then
  // type unrelated text — the chip's filter must NOT be cleared by the box.
  await page.locator('#chip-aesthetic-7').click()
  await expect.poll(async () => (await filterState(page)).minAesthetic).toBe(7)
  await input.fill('plain words')
  await input.press('Enter')
  await expect.poll(async () => (await filterState(page)).search).toBe('plain words')
  expect((await filterState(page)).minAesthetic).toBe(7)
})

test('color:red reaches the backend as color_hues', async ({ page }) => {
  await openGallery(page)
  const urls: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/api/images')) urls.push(req.url())
  })
  const input = page.locator('#gallery-search-input')
  await input.fill('color:red -color:gray')
  await input.press('Enter')
  await expect.poll(async () => (await filterState(page)).colorHues).toEqual(['red'])
  await expect.poll(() => urls.some((u) => u.includes('color_hues=red') && u.includes('exclude_color_hues=gray'))).toBe(true)
})

test('bad values surface warning chips instead of silently vanishing', async ({ page }) => {
  await openGallery(page)
  const input = page.locator('#gallery-search-input')
  await input.fill('color:sparkly')
  const warn = page.locator('#gallery-search-preview .gsq-chip-warn')
  await expect(warn).toBeVisible()
  await expect(warn).toContainText('color:sparkly')
})

test('tag autocomplete suggests from the library and accepts via keyboard', async ({ page }) => {
  await openGallery(page)
  const input = page.locator('#gallery-search-input')
  const suggest = page.locator('#gallery-search-suggest')

  await input.click()
  await input.pressSequentially('tag:v350_search', { delay: 20 })
  await expect(suggest).toBeVisible({ timeout: 5000 })
  await expect(suggest.locator('.gsq-suggest-item').first()).toContainText(FIXTURE_TAG)

  await input.press('Enter')
  await expect(suggest).toBeHidden()
  await expect(input).toHaveValue(new RegExp(`tag:${FIXTURE_TAG}\\s*$`))
  await expect.poll(async () => (await filterState(page)).tags).toContain(FIXTURE_TAG)

  // Enum keys suggest locally (no fetch): gen: lists generators.
  await input.fill('')
  await input.pressSequentially('gen:', { delay: 20 })
  await expect(suggest).toBeVisible({ timeout: 5000 })
  await expect(suggest.locator('.gsq-suggest-item', { hasText: 'comfyui' })).toHaveCount(1)

  // ESC closes ONLY the dropdown — never jumps to the entry page.
  await input.press('Escape')
  await expect(suggest).toBeHidden()
  await expect(page.locator('#entry-page')).toBeHidden()
})

test('help button opens the syntax doc; filter button opens the filter modal', async ({ page }) => {
  await openGallery(page)

  await page.locator('#btn-search-help').click()
  await expect(page.locator('#search-help-modal')).toBeVisible()
  const rows = await page.locator('#search-help-rows .search-help-row').count()
  const expected = await page.evaluate(() => (window as any).GallerySearchQuery.SYNTAX_ROWS.length)
  expect(rows).toBe(expected)
  await page.locator('#btn-close-search-help').click()
  await expect(page.locator('#search-help-modal')).toBeHidden()

  await page.locator('#btn-toolbar-filters').click()
  await expect(page.locator('#filter-modal')).toBeVisible()
  await page.locator('#btn-close-filter-modal').click()
  await expect(page.locator('#filter-modal')).toBeHidden()
})
