import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test } from '../fixtures/click-ledger'

/**
 * Publish Set workbench (v3.5.0 Tier 1 — Pixiv 成套發布): gallery selection →
 * drag order → censored-variant pairing ({stem}_censored.*) → sequential
 * export (01.png, 02.png, … + caption.txt).
 *
 * The fixture creates real files under .tmp/ and real library rows; exports
 * land in .tmp/ too, so nothing outside the repo is touched.
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1600, height: 900 } })

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const fixtureRoot = path.join(repoRoot, '.tmp', 'v350-publish')

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

function runBackendScript(script: string): string {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: repoRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

const SECRET = 'masterpiece, publish secret 51f3'

/**
 * 3 originals in the library; pub-2 gets a censored sibling on disk only.
 * pub-4 carries generation info (NovelAI-style text chunks) for the
 * metadata and Censor Edit hand-over tests.
 */
function resetFixture(): { ids: number[], metaId: number } {
  const script = `
import json
import shutil
import sqlite3
from pathlib import Path

from PIL import Image, PngImagePlugin

repo_root = Path(${JSON.stringify(repoRoot)})
root = repo_root / ".tmp" / "v350-publish"
shutil.rmtree(root, ignore_errors=True)
(root / "src").mkdir(parents=True, exist_ok=True)

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
ids = []
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute("DELETE FROM images WHERE filename LIKE 'v350-pub-%'")
    for index in (1, 2, 3):
        filename = f"v350-pub-{index}.png"
        image_path = (root / "src" / filename).resolve()
        Image.new("RGB", (64, 48), color=(40 * index, 90, 130)).save(image_path)
        cur.execute(
            """
            INSERT INTO images (
                path, filename, generator, width, height, file_size, source_size,
                source_mtime_ns, is_readable, metadata_status, created_at, user_rating
            ) VALUES (?, ?, 'unknown', 64, 48, ?, ?, ?, 1, 'complete', CURRENT_TIMESTAMP, 0)
            """,
            (
                str(image_path), filename,
                image_path.stat().st_size, image_path.stat().st_size,
                image_path.stat().st_mtime_ns,
            ),
        )
        ids.append(cur.lastrowid)
    meta_path = (root / "src" / "v350-pub-4.png").resolve()
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", ${JSON.stringify(SECRET)} + " Steps: 28, Seed: 7")
    info.add_text("Software", "NovelAI")
    info.add_itxt("Comment", '{"prompt": "' + ${JSON.stringify(SECRET)} + '"}')
    Image.new("RGB", (64, 48), color=(200, 120, 60)).save(meta_path, pnginfo=info)
    cur.execute(
        """
        INSERT INTO images (
            path, filename, generator, width, height, file_size, source_size,
            source_mtime_ns, is_readable, metadata_status, created_at, user_rating
        ) VALUES (?, ?, 'novelai', 64, 48, ?, ?, ?, 1, 'complete', CURRENT_TIMESTAMP, 0)
        """,
        (
            str(meta_path), "v350-pub-4.png",
            meta_path.stat().st_size, meta_path.stat().st_size,
            meta_path.stat().st_mtime_ns,
        ),
    )
    meta_id = cur.lastrowid
    conn.commit()

# Censored sibling for pub-2: disk-only (NOT indexed) — exercises the
# same-directory probe rather than the library-filename fallback.
censored = root / "src" / "v350-pub-2_censored.png"
Image.new("RGB", (64, 48), color=(0, 0, 0)).save(censored)
print(json.dumps({"ids": ids, "metaId": meta_id}))
`
  return JSON.parse(runBackendScript(script)) as { ids: number[], metaId: number }
}

type ImageReport = { pixels: string, corner: number[], infoKeys: string[], hasSecret: boolean }

/** Decode an exported file: pixel digest, one pixel, metadata keys, raw prompt text. */
function inspectImage(filePath: string): ImageReport {
  const script = `
import hashlib
import json
from pathlib import Path

from PIL import Image

path = Path(${JSON.stringify(filePath)})
with Image.open(path) as image:
    rgb = image.convert("RGB")
    print(json.dumps({
        "pixels": hashlib.sha256(rgb.tobytes()).hexdigest(),
        "corner": list(rgb.getpixel((5, 5))),
        "infoKeys": sorted(str(key) for key in image.info),
        "hasSecret": ${JSON.stringify(SECRET)}.encode() in path.read_bytes(),
    }))
`
  return JSON.parse(runBackendScript(script)) as ImageReport
}

function cleanupFixture() {
  const script = `
import shutil
import sqlite3
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    conn.execute("DELETE FROM images WHERE filename LIKE 'v350-pub-%'")
    conn.commit()
shutil.rmtree(repo_root / ".tmp" / "v350-publish", ignore_errors=True)
print("ok")
`
  runBackendScript(script)
}

let fixtureIds: number[] = []
let metaId = 0

test.beforeAll(() => {
  const fixture = resetFixture()
  fixtureIds = fixture.ids
  metaId = fixture.metaId
  expect(fixtureIds.length).toBe(3)
})

test.afterAll(() => {
  cleanupFixture()
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
    localStorage.removeItem('sd-sorter-publish-settings')
  })
})

test('API pairs the censored sibling and exports sequential names + caption', async ({ request }) => {
  const pairs = await (await request.post('/api/publish/censor-pairs', {
    data: { image_ids: fixtureIds },
  })).json()
  expect(pairs.total).toBe(3)
  expect(pairs.found_count).toBe(1)
  const byId = new Map(pairs.pairs.map((entry: any) => [entry.image_id, entry]))
  expect((byId.get(fixtureIds[1]) as any).found).toBe(true)
  expect((byId.get(fixtureIds[1]) as any).censored_source).toBe('disk')
  expect((byId.get(fixtureIds[1]) as any).censored_filename).toBe('v350-pub-2_censored.png')
  expect((byId.get(fixtureIds[0]) as any).found).toBe(false)

  // Export in a custom order: 3rd, 1st, then 2nd as its censored variant.
  const outDir = path.join(fixtureRoot, 'out-api')
  const result = await (await request.post('/api/publish/export', {
    data: {
      items: [
        { image_id: fixtureIds[2] },
        { image_id: fixtureIds[0] },
        { image_id: fixtureIds[1], use_censored: true },
      ],
      output_folder: outDir,
      caption_text: 'publish-set e2e caption',
    },
  })).json()
  expect(result.success).toBe(true)
  expect(result.exported.map((entry: any) => entry.output_name)).toEqual(['01.png', '02.png', '03.png'])
  expect(result.exported[2].used_censored).toBe(true)
  expect(result.caption_file).toBe('caption.txt')
  expect(result.metadata_option).toBe('strip')

  const censoredSource = path.join(fixtureRoot, 'src', 'v350-pub-2_censored.png')
  expect(inspectImage(path.join(outDir, '03.png')).pixels).toBe(inspectImage(censoredSource).pixels)
  expect(fsSync.readFileSync(path.join(outDir, 'caption.txt'), 'utf8')).toBe('publish-set e2e caption\n')
})

test('API export removes generation info by default and keeps it only when asked', async ({ request }) => {
  const source = path.join(fixtureRoot, 'src', 'v350-pub-4.png')
  expect(inspectImage(source).hasSecret).toBe(true)

  const stripDir = path.join(fixtureRoot, 'out-api-strip')
  const stripped = await (await request.post('/api/publish/export', {
    data: { items: [{ image_id: metaId, use_censored: false }], output_folder: stripDir },
  })).json()
  expect(stripped.success).toBe(true)
  const strippedReport = inspectImage(path.join(stripDir, '01.png'))
  expect(strippedReport.hasSecret).toBe(false)
  expect(strippedReport.infoKeys).not.toContain('parameters')
  expect(strippedReport.infoKeys).not.toContain('Comment')
  expect(strippedReport.pixels).toBe(inspectImage(source).pixels)

  const keepDir = path.join(fixtureRoot, 'out-api-keep')
  const kept = await (await request.post('/api/publish/export', {
    data: { items: [{ image_id: metaId }], output_folder: keepDir, metadata_option: 'keep' },
  })).json()
  expect(kept.success).toBe(true)
  expect(fsSync.readFileSync(path.join(keepDir, '01.png')).equals(fsSync.readFileSync(source))).toBe(true)
})

test('workbench renders pairs, drag reorders, and exports through the UI', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  await page.evaluate((ids) => (window as any).PublishSet.open(ids), fixtureIds)
  await expect(page.locator('#publish-set-modal.visible')).toBeVisible()
  const rows = page.locator('.pub-item')
  await expect(rows).toHaveCount(3)

  // Master toggle defaults on: the paired row pre-selects its censored variant.
  // The pair line names the censored file it resolved, and carries the paired
  // state as a class rather than as a glyph in the text, so this survives icon
  // and locale sweeps while still failing if the affordance disappears.
  const pairedRow = page.locator(`.pub-item[data-image-id="${fixtureIds[1]}"]`)
  await expect(pairedRow.locator('.pub-item-pair')).toHaveText('v350-pub-2_censored.png')
  await expect(pairedRow.locator('.pub-item-pair')).toHaveClass(/is-paired/)
  await expect(pairedRow.locator('.pub-variant-btn.active')).toHaveText('Censored')
  const unpairedRow = page.locator(`.pub-item[data-image-id="${fixtureIds[0]}"]`)
  await expect(unpairedRow.locator('.pub-item-pair')).toHaveClass(/is-unpaired/)
  await expect(unpairedRow.locator('.pub-variant-btn.active')).toHaveText('Original')

  // Drag the first row below the last one → order becomes [2, 3, 1].
  const firstRow = page.locator(`.pub-item[data-image-id="${fixtureIds[0]}"]`)
  const lastRow = page.locator(`.pub-item[data-image-id="${fixtureIds[2]}"]`)
  const lastBox = await lastRow.boundingBox()
  await firstRow.dragTo(lastRow, {
    targetPosition: { x: 40, y: Math.max(1, (lastBox?.height ?? 20) - 4) },
  })
  await expect(page.locator('.pub-item').first()).toHaveAttribute(
    'data-image-id', String(fixtureIds[1]))
  await expect(page.locator('.pub-item').last()).toHaveAttribute(
    'data-image-id', String(fixtureIds[0]))
  await expect(page.locator('.pub-item').first().locator('.pub-item-number')).toHaveText('#01')

  // Export via the form. Two rows have no censored version, so the check
  // names them first and Cancel is the default: nothing is written.
  const outDir = path.join(fixtureRoot, 'out-ui')
  await page.locator('#pub-folder').fill(outDir)
  await page.locator('#pub-prefix').fill('set_')
  await page.locator('#btn-pub-export').click()
  const check = page.locator('#pub-uncensored-check')
  await expect(check).toBeInViewport()
  await expect(check.locator('li')).toHaveCount(2)
  await expect(check.locator('li').first()).toContainText('v350-pub-3.png')
  await expect(page.locator('#btn-pub-uncensored-cancel')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(check).toBeHidden()
  await expect(page.locator('#publish-set-modal.visible')).toBeVisible()
  expect(fsSync.existsSync(outDir)).toBe(false)

  // "Leave these out" exports only the censored image, numbered from 01.
  const censoredOnlyDir = path.join(fixtureRoot, 'out-ui-censored-only')
  await page.locator('#pub-folder').fill(censoredOnlyDir)
  await page.locator('#btn-pub-export').click()
  await page.locator('#btn-pub-uncensored-skip').click()
  await expect(page.locator('.pub-result-line.pub-result-ok')).toBeVisible()
  await expect.poll(() => fsSync.existsSync(path.join(censoredOnlyDir, 'set_01.png'))).toBe(true)
  expect(fsSync.readdirSync(censoredOnlyDir)).toEqual(['set_01.png'])

  // Exporting them as they are is an explicit choice, and the result says
  // which files went out uncensored.
  await page.locator('#pub-folder').fill(outDir)
  await page.locator('#btn-pub-export').click()
  await page.locator('#btn-pub-uncensored-include').click()
  await expect(page.locator('.pub-result-line.pub-result-ok')).toBeVisible()
  await expect(page.locator('.pub-result-file.pub-result-warn')).toHaveCount(2)

  await expect.poll(() => fsSync.existsSync(path.join(outDir, 'set_01.png'))).toBe(true)
  expect(fsSync.existsSync(path.join(outDir, 'set_02.png'))).toBe(true)
  expect(fsSync.existsSync(path.join(outDir, 'set_03.png'))).toBe(true)
  // Position 1 exported the censored variant of pub-2 (master toggle default).
  const censoredSource = path.join(fixtureRoot, 'src', 'v350-pub-2_censored.png')
  expect(inspectImage(path.join(outDir, 'set_01.png')).pixels).toBe(inspectImage(censoredSource).pixels)

  // "Open folder" selects the first written file (no real file manager in tests).
  const reveals: string[] = []
  await page.route('**/api/output-folders/reveal', async (route) => {
    reveals.push((route.request().postDataJSON() as { path: string }).path)
    await route.fulfill({ json: { status: 'ok' } })
  })
  await page.locator('.pub-result-open').click()
  await expect.poll(() => reveals.length).toBe(1)
  expect(path.resolve(path.dirname(reveals[0])).toLowerCase()).toBe(path.resolve(outDir).toLowerCase())

  // An empty folder exports into the program's output/publish (owner 2026-10-04).
  await page.locator('#pub-folder').fill('')
  const placeholder = await page.locator('#pub-folder').getAttribute('placeholder')
  expect(placeholder).toMatch(/^Empty = .*output.publish$/)
  const builtinPublish = String(placeholder).replace(/^Empty = /, '')
  await page.locator('#pub-prefix').fill('blank_')
  await page.locator('#btn-pub-export').click()
  await page.locator('#btn-pub-uncensored-include').click()
  await expect(page.locator('.pub-result-line.pub-result-ok')).toContainText(builtinPublish)
  await expect.poll(() => fsSync.existsSync(path.join(builtinPublish, 'blank_01.png'))).toBe(true)

  // Watermark is applied only to the publish copy, never to the selected
  // library source. The interaction stays in the same workbench flow.
  const watermarkOut = path.join(fixtureRoot, 'out-ui-watermark')
  await page.locator('#pub-folder').fill(watermarkOut)
  await page.locator('#pub-prefix').fill('wm_')
  await page.locator('#pub-watermark-enabled').check()
  await page.locator('#pub-watermark-text').fill('@artist')
  await page.locator('#pub-watermark-opacity').fill('90')
  await page.locator('#pub-overwrite').check()
  await page.locator('#btn-pub-export').click()
  await page.locator('#btn-pub-uncensored-include').click()
  await expect(page.locator('.pub-result-line.pub-result-ok')).toBeVisible()
  await expect.poll(() => fsSync.existsSync(path.join(watermarkOut, 'wm_01.png'))).toBe(true)
  expect(inspectImage(path.join(watermarkOut, 'wm_01.png')).pixels).not.toBe(inspectImage(censoredSource).pixels)
})

test('Censor Edit hands its censored result to the set: censored pixels, its name, no generation info', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  // One queued image, censored with a black bar and renamed in Censor Edit.
  await page.evaluate((id) => {
    const state = (window as any).__CENSOR_STATE__
    state.queue = [{
      id,
      originalFilename: 'v350-pub-4.png',
      outputFilename: 'cover_01.png',
      width: 64,
      height: 48,
      editOperations: [{
        kind: 'geometry_effect',
        style: 'black_bar',
        block_size: 16,
        blur_radius: 8,
        regions: [{ box: [0, 0, 32, 24], label: 'manual', confidence: 1 }],
      }],
    }]
  }, metaId)
  await page.evaluate(() => (window as any).App.switchView('censor'))
  await page.locator('#btn-censor-to-publish-set').click()

  await expect(page.locator('#publish-set-modal.visible')).toBeVisible()
  const row = page.locator(`.pub-item[data-image-id="${metaId}"]`)
  await expect(row.locator('.pub-item-pair')).toHaveClass(/is-paired/)
  await expect(row.locator('.pub-variant-btn.active')).toHaveText('Censored')
  await expect(page.locator('#pub-use-censor-names')).toBeChecked()
  await expect(row.locator('.pub-item-outname')).toContainText('cover_01.png')
  await expect(page.locator('#pub-metadata-option')).toHaveValue('strip')

  const outDir = path.join(fixtureRoot, 'out-handover')
  await page.locator('#pub-folder').fill(outDir)
  await page.locator('#btn-pub-export').click()
  await expect(page.locator('.pub-result-line.pub-result-ok')).toBeVisible()
  // Every image was censored, so nothing had to be asked.
  await expect(page.locator('#pub-uncensored-check')).toBeHidden()
  await expect(page.locator('.pub-result-file')).toHaveText(/cover_01\.png/)

  const exported = path.join(outDir, 'cover_01.png')
  await expect.poll(() => fsSync.existsSync(exported)).toBe(true)
  const report = inspectImage(exported)
  const original = inspectImage(path.join(fixtureRoot, 'src', 'v350-pub-4.png'))
  expect(original.corner).toEqual([200, 120, 60])
  expect(report.corner).toEqual([0, 0, 0])
  expect(report.pixels).not.toBe(original.pixels)
  expect(report.hasSecret).toBe(false)
  expect(report.infoKeys).not.toContain('parameters')
  expect(report.infoKeys).not.toContain('Comment')
  expect(report.infoKeys).not.toContain('Software')
})

test('Escape closes the workbench and it reopens; the More-menu item is gone', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  // Owner 2026-07-07: 成套发布 left the More menu — the Pixiv mission, the
  // gallery batch bar's publish button, and the function catalog are its
  // entrances now (the always-empty modal entrance was the complaint).
  await page.locator('#nav-tools-toggle').click()
  await expect(page.locator('#nav-tools-publish-set')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.evaluate((ids) => (window as any).PublishSet.open(ids), fixtureIds)
  await expect(page.locator('#publish-set-modal.visible')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.locator('#publish-set-modal.visible')).toHaveCount(0)
  await expect(page.locator('#view-gallery')).toBeVisible()

  // Reopening still works after an Escape-close.
  await page.evaluate((ids) => (window as any).PublishSet.open(ids), fixtureIds)
  await expect(page.locator('#publish-set-modal.visible')).toBeVisible()
})

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]) {
  test(`the not-censored check, metadata choice and export stay on screen at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#view-gallery')).toBeVisible()
    await page.evaluate((ids) => (window as any).PublishSet.open(ids), fixtureIds)
    await expect(page.locator('.pub-item')).toHaveCount(3)

    await expect(page.locator('#pub-metadata-option')).toBeInViewport()
    await expect(page.locator('#btn-pub-export')).toBeInViewport()
    await page.locator('#pub-folder').fill(path.join(fixtureRoot, 'out-layout'))
    await page.locator('#btn-pub-export').click()
    for (const id of ['#btn-pub-uncensored-cancel', '#btn-pub-uncensored-skip', '#btn-pub-uncensored-include']) {
      await expect(page.locator(id)).toBeInViewport()
    }
    const overflow = await page.evaluate(() => {
      const content = document.querySelector('.publish-set-content') as HTMLElement
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        modal: content.scrollWidth - content.clientWidth,
      }
    })
    expect(overflow.page).toBeLessThanOrEqual(0)
    expect(overflow.modal).toBeLessThanOrEqual(0)
    await page.screenshot({
      path: path.join(repoRoot, '.tmp', 'v35-fix', `publish-check-${viewport.width}x${viewport.height}.png`),
    })
    await page.locator('#btn-pub-uncensored-cancel').click()
  })
}
