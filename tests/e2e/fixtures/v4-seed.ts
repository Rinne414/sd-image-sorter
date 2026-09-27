import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, type Locator, type Page } from '@playwright/test'

import { PY_DELETE_IMAGES } from './e2e-db'

/**
 * Shared set-up for the V4 specs (V4 is served at /v4/ by the same backend).
 * Each spec seeds its own rows into the isolated test database under its own
 * filename prefix and search token, so specs never see each other's images,
 * and removes them (and their folders) afterwards.
 */

export const repoRoot = path.resolve(__dirname, '..', '..', '..')
export const tmpRoot = path.join(repoRoot, '.tmp')
export const dbPath = process.env.SD_IMAGE_SORTER_DB_PATH || path.join(repoRoot, 'data', 'images.db')
/** The backend under test (same rule as playwright.config.ts). */
const serverBase = process.env.BASE_URL || `http://127.0.0.1:${process.env.PW_WEB_SERVER_PORT || process.env.SD_IMAGE_SORTER_PORT || '19087'}`

export const VIEWPORTS = [
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

export function runBackendScript(script: string): string {
  return execFileSync(backendPython(), ['-X', 'utf8', '-c', script], { cwd: repoRoot, stdio: 'pipe' })
    .toString('utf8')
    .trim()
}

export interface SeedSpec {
  /** Filename prefix, e.g. "v4e2e-"; also what cleanup deletes by. */
  prefix: string
  /** Word in every prompt (and in image_prompt_tokens) so a search finds only these rows. */
  token: string
  count: number
  /** Folder under .tmp/ the files are written to. */
  dir: string
}

/**
 * Write `count` small PNGs and their rows. Minutes-apart times keep "newest" order stable.
 * Each row gets its path identity like a real import (favourites resolve through it on
 * Windows). The server caches library facets (the generator list) for a minute; a
 * throwaway row removed through its own API makes it drop them, so the rail sees the seed.
 */
export function seedImages(spec: SeedSpec): void {
  runBackendScript(`
import json, shutil, sqlite3, sys, urllib.request
from pathlib import Path
from PIL import Image
sys.path.insert(0, str(Path(${JSON.stringify(repoRoot)}) / "backend"))
from utils.source_paths import indexed_image_path_casefold
${PY_DELETE_IMAGES}

root = Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(spec.dir)}
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)
shapes = [(64, 96), (96, 64), (80, 80), (48, 120)]
meta = json.dumps({"_parsed": {"generation_params": {"steps": 28, "sampler": "k_euler", "seed": 424242, "cfg_scale": 5}}})
prefix = ${JSON.stringify(spec.prefix)}
token = ${JSON.stringify(spec.token)}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    delete_images(cur, "filename LIKE ?", (prefix + "%",))
    for i in range(${spec.count}):
        w, h = shapes[i % len(shapes)]
        name = f"{prefix}{i:02d}.png"
        path = (root / name).resolve()
        Image.new("RGB", (w, h), (40 + (i * 8) % 200, 90, 160 - (i * 4) % 150)).save(path)
        prompt = f"{token}, 1girl, (silver hair:1.2), smile, frame {i}"
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
        cur.execute(
            "INSERT INTO image_path_identities (image_id, path_key) VALUES (?, ?) "
            "ON CONFLICT(image_id) DO UPDATE SET path_key = excluded.path_key",
            (image_id, indexed_image_path_casefold(str(path))),
        )
        for word in (token, "1girl", "silver hair", "smile"):
            cur.execute("INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)", (image_id, word))
    sentinel_name = f"{prefix}cache-sentinel.png"
    cur.execute(
        "INSERT INTO images (path, filename, generator, prompt, is_readable, metadata_status, created_at) "
        "VALUES (?, ?, 'nai', '', 1, 'complete', datetime('now'))",
        (str(root / sentinel_name), sentinel_name),
    )
    sentinel = cur.lastrowid
    conn.commit()
request = urllib.request.Request(
    ${JSON.stringify(serverBase)} + "/api/images/remove-selected",
    data=json.dumps({"image_ids": [sentinel], "background": False}).encode(),
    headers={"Content-Type": "application/json", "X-SD-Library-Id": "main"},
    method="POST",
)
try:
    urllib.request.urlopen(request, timeout=15).read()
except Exception as exc:
    print(f"warning: the server kept its cached facets: {exc}", file=sys.stderr)
print("ok")
`)
}

/** Delete the rows with this prefix and the given folders under .tmp/. */
export function cleanupImages(prefix: string, dirs: string[]): void {
  runBackendScript(`
import shutil, sqlite3
from pathlib import Path
${PY_DELETE_IMAGES}
prefix = ${JSON.stringify(prefix)}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    delete_images(conn, "filename LIKE ?", (prefix + "%",))
    conn.commit()
for d in ${JSON.stringify(dirs)}:
    shutil.rmtree(Path(${JSON.stringify(tmpRoot)}) / d, ignore_errors=True)
print("ok")
`)
}

/** Open /v4/ in English with a fixed theme, search for `query` and wait for `count` results. */
export async function openLibrary(page: Page, query: string, count: number, theme: 'dark' | 'light' = 'dark') {
  // Seed language and theme once per page, so a later reload keeps what the test changed.
  await page.addInitScript((th) => {
    const flag = 'v4e2e-init-' + th
    if (sessionStorage.getItem(flag)) return
    sessionStorage.setItem(flag, '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', th)
    // no update check half a minute after start: the test server would ask GitHub (v4-about.spec.ts stubs and tests it)
    localStorage.setItem('sd-v4-update-autocheck', '0')
    // these specs start in the library: a plain /v4/ opens the start page (Home unless Settings says otherwise)
    const prefs = JSON.parse(localStorage.getItem('sd-v4-prefs') || '{}')
    localStorage.setItem('sd-v4-prefs', JSON.stringify({ ...prefs, startPage: 'library' }))
  }, theme)
  const res = await page.goto('/v4/', { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  const input = page.getByTestId('query-input')
  await input.fill(query)
  await input.press('Enter')
  // English counts of 1 are singular (i18n/plural.ts)
  await expect(page.getByTestId('result-count')).toHaveText(`${count.toLocaleString('en-US')} ${count === 1 ? 'image' : 'images'}`)
  await expect(page.locator('[data-testid="gallery-scroller"]:not([aria-busy])')).toBeVisible()
}

/**
 * Scroll an element to the middle of its scroller before a "wholly on screen"
 * check. scrollIntoViewIfNeeded stops as soon as the element's edge meets the
 * scroller's edge, and with fractional line heights that edge can sit a part
 * of a pixel outside, which reads as not wholly visible.
 */
export async function scrollToMiddle(target: Locator): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
}

/** Horizontal overflow of the whole page, in px (0 or less is fine). */
export async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}
