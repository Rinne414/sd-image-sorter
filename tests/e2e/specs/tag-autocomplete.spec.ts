import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

/**
 * Tag autocomplete v2 (owner request 2026-07-05): the caption-editor style
 * type-ahead grows a unified backend (GET /api/tags/suggest — library tags
 * merged with the bundled danbooru vocabulary, alias-aware) and attaches to
 * every comma-separated tag input: dataset editor textarea, image detail tag
 * editor, mass tag add/remove boxes, export-preview textareas.
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

const FIXTURE_TAG = 'v350_tagac_zzzunique'

function runBackendScript(script: string): string {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: repoRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

function resetFixture(): number[] {
  const script = `
import json
import shutil
import sqlite3
from pathlib import Path
from PIL import Image

repo_root = Path(${JSON.stringify(repoRoot)})
root = repo_root / ".tmp" / "v350-tag-autocomplete"
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
ids = []
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE 'v350-tagac-%')"
    )
    cur.execute("DELETE FROM images WHERE filename LIKE 'v350-tagac-%'")
    for index in range(1, 4):
        filename = f"v350-tagac-{index}.png"
        image_path = (root / filename).resolve()
        Image.new("RGB", (64, 64), color=(200, 90 + index * 30, 60)).save(image_path)
        cur.execute(
            """
            INSERT INTO images (
                path, filename, generator, prompt, negative_prompt, metadata_json,
                width, height, file_size, source_size, source_mtime_ns,
                is_readable, read_error, metadata_status, created_at
            ) VALUES (?, ?, 'unknown', 'tagac fixture', '', NULL, 64, 64, ?, ?, ?, 1, NULL, 'complete', CURRENT_TIMESTAMP)
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

function cleanupFixture() {
  const script = `
import shutil
import sqlite3
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE 'v350-tagac-%')"
    )
    cur.execute("DELETE FROM images WHERE filename LIKE 'v350-tagac-%'")
    conn.commit()
shutil.rmtree(repo_root / ".tmp" / "v350-tag-autocomplete", ignore_errors=True)
print("ok")
`
  runBackendScript(script)
}

test.beforeAll(() => {
  const ids = resetFixture()
  expect(ids.length).toBe(3)
})

test.afterAll(() => {
  cleanupFixture()
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

async function openDetailTagEditor(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible({ timeout: 20_000 })
  await page.locator('#gallery-grid .gallery-item').first().click()
  await expect(page.locator('#image-modal.visible')).toBeVisible({ timeout: 10_000 })
  await page.locator('#btn-edit-modal-tags').click()
  const input = page.locator('#modal-tags-add-input')
  await expect(input).toBeVisible()
  return input
}

test('suggest API merges library tags with the danbooru vocabulary', async ({ request }) => {
  // Library fixture tag ranks first for its own prefix.
  const lib = await (await request.get(`/api/tags/suggest?q=v350_tagac&limit=10`)).json()
  expect(lib.suggestions.length).toBeGreaterThan(0)
  expect(lib.suggestions[0].tag).toBe(FIXTURE_TAG)
  expect(lib.suggestions[0].source).toBe('library')
  expect(lib.suggestions[0].count).toBe(3)

  // Bundled vocabulary answers for tags the library has never seen.
  const dan = await (await request.get(`/api/tags/suggest?q=hatsune&limit=10`)).json()
  expect(dan.danbooru_loaded).toBe(true)
  const miku = dan.suggestions.find((s: any) => s.tag === 'hatsune_miku')
  expect(miku).toBeTruthy()
  expect(miku.source).toBe('danbooru')
  expect(miku.category).toBe('character')

  // Alias matching: "boobs" is a danbooru alias of "breasts".
  const alias = await (await request.get(`/api/tags/suggest?q=boobs&limit=10`)).json()
  expect(alias.suggestions.map((s: any) => s.tag)).toContain('breasts')
})

test('detail-modal tag editor: typing opens suggestions, Enter accepts into the input', async ({ page }) => {
  const input = await openDetailTagEditor(page)
  const chips = page.locator('#modal-tags-edit-chips .tag-editable')
  const chipsBefore = await chips.count()

  await input.fill('v350_tagac')
  const dropdown = page.locator('.caption-autocomplete-dropdown')
  await expect(dropdown).toBeVisible({ timeout: 5_000 })
  await expect(dropdown.locator('.caption-autocomplete-item').first()).toContainText(FIXTURE_TAG)

  await input.press('Enter')
  // Accept replaced the token in the input — and did NOT fire the modal's
  // own Enter handler (which would have converted it into a chip).
  await expect(input).toHaveValue(`${FIXTURE_TAG}, `)
  expect(await chips.count()).toBe(chipsBefore)
  await expect(dropdown).toBeHidden()

  // With the dropdown closed, Enter belongs to the modal handler again:
  // a brand-new token becomes a chip and the input clears.
  await input.fill('v350_never_suggested_zz')
  await input.press('Enter')
  await expect(chips).toHaveCount(chipsBefore + 1)
  await expect(input).toHaveValue('')
})

test('danbooru suggestions carry category dots; Escape closes only the dropdown', async ({ page }) => {
  const input = await openDetailTagEditor(page)

  await input.fill('hatsune')
  const dropdown = page.locator('.caption-autocomplete-dropdown')
  await expect(dropdown).toBeVisible({ timeout: 5_000 })
  await expect(
    dropdown.locator('.caption-autocomplete-item .cap-ac-dot-character').first()
  ).toBeVisible()

  await input.press('Escape')
  await expect(dropdown).toBeHidden()
  // The image modal stays open — Escape was consumed by the dropdown.
  await expect(page.locator('#image-modal.visible')).toBeVisible()
})

test('mass tag editor add box is attached to the shared autocomplete', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  const attached = await page.evaluate(() => {
    const add = document.getElementById('mass-tag-add-tags') as HTMLElement | null
    const remove = document.getElementById('mass-tag-remove-tags') as HTMLElement | null
    return {
      add: add?.dataset.captionAutocomplete === '1',
      remove: remove?.dataset.captionAutocomplete === '1',
    }
  })
  expect(attached.add).toBe(true)
  expect(attached.remove).toBe(true)
})
