import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, dbPath, openLibrary, pageOverflow, repoRoot, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * Censoring GIFs and videos in V Opus and /next/ (slice `mediacensor`):
 * the entrance in the censor step's Detect tab, the dialog (a folder, or the
 * GIFs and videos picked in the library), the real backend job followed in the
 * Jobs drawer, Stop, a program that stops answering, a job the program no
 * longer knows, and the ffmpeg component being asked for before a video.
 *
 * The GIFs are real (Pillow); the video is real when ffmpeg exists on this
 * machine. Detection is the real NudeNet on synthetic frames, which finds
 * nothing: the job must say so (and still write the copies) instead of calling
 * it censored. Nothing is stubbed in the detection or the job; only the file
 * manager (Show in folder, Open folder) is, so no window opens on the screen,
 * and the model download / ffmpeg install questions are answered by the spec.
 *
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const PREFIX = 'v4mc-'
const TOKEN = 'v4mctoken'
const LONG_TOKEN = 'v4mclong'
const DIR = 'v4-mediacensor'
const SRC = path.join(tmpRoot, DIR, 'src')
const OUT = path.join(tmpRoot, DIR, 'out')
const PICTURES = 2
const GIFS = 2
const OWN_BATCH = 'v4mc batch'

let realVideo = false

function seedMedia(): boolean {
  const out = runBackendScript(`
import shutil, sqlite3, subprocess, sys
from pathlib import Path
from PIL import Image
sys.path.insert(0, str(Path(${JSON.stringify(repoRoot)}) / "backend"))
from utils.source_paths import indexed_image_path_casefold

root = Path(${JSON.stringify(path.join(tmpRoot, DIR))})
src = Path(${JSON.stringify(SRC)})
long_dir = root / "long"
for folder in (src, long_dir, Path(${JSON.stringify(OUT)})):
    folder.mkdir(parents=True, exist_ok=True)

def gif(path, frames, size):
    shots = [Image.new("RGB", (size, size), ((i * 37) % 255, 90 + (i * 11) % 120, 160 - (i * 5) % 150)) for i in range(frames)]
    shots[0].save(path, save_all=True, append_images=shots[1:], duration=80, loop=0)

gif(src / "v4mc-clip-a.gif", 4, 96)
gif(src / "v4mc-clip-b.gif", 3, 96)
gif(long_dir / "v4mc-long.gif", 400, 200)
# a GIF with something NudeNet really finds: three frames of the public-domain picture the other censor specs use
art = root / "art"
art.mkdir(parents=True, exist_ok=True)
still = Image.open(Path(${JSON.stringify(repoRoot)}) / "tests" / "e2e" / "fixtures" / "censor-nudenet-public-domain.jpg").convert("RGB")
shots = [still.copy() for _ in range(3)]
for i, shot in enumerate(shots):
    # a dot in the corner that moves, so the three frames are not merged into one when saved
    shot.putpixel((i * 3, 0), (255, 0, 255))
shots[0].save(art / "v4mc-art.gif", save_all=True, append_images=shots[1:], duration=100, loop=0)
real = False
ffmpeg = shutil.which("ffmpeg")
if ffmpeg:
    run = subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=12:duration=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(src / "v4mc-clip.mp4")],
        capture_output=True,
    )
    real = run.returncode == 0 and (src / "v4mc-clip.mp4").is_file()

rows = [(p, ${JSON.stringify(TOKEN)}) for p in sorted(src.iterdir())] + [(long_dir / "v4mc-long.gif", ${JSON.stringify(LONG_TOKEN)})]
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    for i, (file, token) in enumerate(rows):
        p = file.resolve()
        cur.execute(
            """INSERT INTO images (path, filename, generator, prompt, negative_prompt, metadata_json, width, height, file_size,
                   source_size, source_mtime_ns, is_readable, metadata_status, created_at, library_order_time, user_rating)
               VALUES (?, ?, 'comfyui', ?, '', '{}', 96, 96, ?, ?, ?, 1, 'complete',
                   datetime('now', ?), datetime('now', ?), 0)""",
            (str(p), p.name, f"{token}, moving {i}", p.stat().st_size, p.stat().st_size, p.stat().st_mtime_ns,
             f"-{300 + i} minutes", f"-{300 + i} minutes"),
        )
        image_id = cur.lastrowid
        cur.execute("INSERT INTO image_path_identities (image_id, path_key) VALUES (?, ?)", (image_id, indexed_image_path_casefold(str(p))))
        cur.execute("INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)", (image_id, token))
    conn.commit()
print("real" if real else "fake")
`)
  return out.endsWith('real')
}

test.beforeAll(() => {
  cleanBatches(false)
  cleanupImages(PREFIX, [DIR])
  seedImages({ prefix: PREFIX, token: TOKEN, count: PICTURES, dir: DIR })
  realVideo = seedMedia()
})
test.afterAll(() => {
  cleanBatches(false)
  cleanupImages(PREFIX, [DIR])
})

const VIDEOS = () => (realVideo ? 1 : 0)
const FOUND = () => `Found ${GIFS} GIFs and ${VIDEOS()} ${VIDEOS() === 1 ? 'video' : 'videos'}.`

// ---- helpers ----

async function boot(page: Page, hash: string, lang: 'en' | 'zh-CN' = 'en', ui: 'vopus' | 'next' = 'vopus', nudenetReady = true): Promise<void> {
  // NudeNet's weights are not in this test data folder; the program's own detector runs from the package copy
  if (nudenetReady) await markModelsReady(page, ['censor-nudenet'])
  await page.addInitScript(
    ({ language, source, out }) => {
      const flag = 'v4mc-init-' + language
      if (sessionStorage.getItem(flag)) return
      sessionStorage.setItem(flag, '1')
      localStorage.setItem('sd-image-sorter-lang', language)
      localStorage.setItem('sd-v4-theme', 'dark')
      localStorage.setItem('sd-v4-update-autocheck', '0')
      for (const key of Object.keys(localStorage)) if (key.startsWith('sd-v4-censor-')) localStorage.removeItem(key)
      localStorage.setItem('sd-v4-censor-media-source', source)
      localStorage.setItem('sd-v4-censor-media-output', out)
    },
    { language: lang, source: SRC, out: OUT },
  )
  // the file manager is the one thing never opened for real
  await page.route('**/api/open-path', (route) => route.fulfill({ json: { status: 'ok' } }))
  await page.route('**/api/censor/media/jobs/*/reveal/*', (route) => route.fulfill({ json: { status: 'ok' } }))
  const res = await page.goto(`/${ui === 'next' ? 'next' : 'vopus'}/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

async function createCensorBatch(page: Page): Promise<number> {
  const ids = runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    rows = conn.execute("SELECT id FROM images WHERE filename LIKE ? AND filename LIKE '%.png' ORDER BY id", (${JSON.stringify(PREFIX + '%')},)).fetchall()
print(" ".join(str(r[0]) for r in rows))
`)
    .split(' ')
    .map(Number)
  expect(ids).toHaveLength(PICTURES)
  const created = await page.request.post('/api/batches', { data: { kind: 'pixiv', name: OWN_BATCH, image_ids: ids } })
  expect(created.status()).toBe(201)
  const batch = (await created.json()).batch as { id: number; revision: number }
  await page.request.patch(`/api/batches/${batch.id}`, { data: { revision: batch.revision, current_step: 'censor' } })
  return batch.id
}

async function openDialogFromCensorStep(page: Page, batchId: number, lang: 'en' | 'zh-CN' = 'en', ui: 'vopus' | 'next' = 'vopus', nudenetReady = true) {
  await boot(page, `#/batch/${batchId}`, lang, ui, nudenetReady)
  await expect(page.getByTestId('censor-editor')).toBeVisible()
  await page.getByTestId('censor-tab-detect').click()
  await page.getByTestId('mediacensor-open').click()
  await expect(page.getByTestId('mediacensor-dialog')).toBeVisible()
}

const headline = (page: Page) => page.getByTestId('job').first().locator('strong')

/** Batches the library's Censor… made from the seeded pictures (this spec does not name them). */
function cleanBatches(keepOwn = true): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(
        "DELETE FROM batches WHERE (? = 0 OR name != ?) AND id IN (SELECT batch_id FROM batch_items WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?))",
        (${keepOwn ? 1 : 0}, ${JSON.stringify(OWN_BATCH)}, ${JSON.stringify(PREFIX + '%')}),
    )
    conn.commit()
print("ok")
`)
}

let batchId = 0

// ---- tests ----

test('the censor step has the entrance and the dialog reads the folder', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  batchId = await createCensorBatch(page)
  await openDialogFromCensorStep(page, batchId)
  const dialog = page.getByTestId('mediacensor-dialog')
  // the last folder is remembered, and the listing says what is in it
  await expect(page.getByTestId('mediacensor-folder')).toHaveValue(SRC)
  await expect(page.getByTestId('mediacensor-found')).toHaveText(FOUND())
  await expect(page.getByTestId('mediacensor-start')).toHaveText(`Start (${GIFS + VIDEOS()} files)`)
  // a folder that does not exist is said, and start is off
  await page.getByTestId('mediacensor-folder').fill(path.join(SRC, 'nope'))
  await expect(page.getByTestId('mediacensor-found')).toContainText('This folder cannot be read')
  await expect(page.getByTestId('mediacensor-start')).toBeDisabled()
  await page.getByTestId('mediacensor-folder').fill(tmpRoot)
  await expect(page.getByTestId('mediacensor-found')).toHaveText('This folder has no GIFs or videos.')
  // Esc closes the dialog, and only that
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('censor-editor')).toBeVisible()
  // the detection settings are the Detect tab's own
  await page.getByTestId('mediacensor-open').click()
  await page.getByTestId('mediacensor-confidence').fill('70')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('censor-confidence')).toHaveValue('70')
})

for (const viewport of VIEWPORTS) {
  test(`the dialog fits at ${viewport.width}x${viewport.height} in both languages`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const lang of ['en', 'zh-CN'] as const) {
      await openDialogFromCensorStep(page, batchId, lang)
      const dialog = page.getByTestId('mediacensor-dialog')
      await expect(page.getByTestId('mediacensor-found')).not.toHaveText('')
      await page.getByTestId('mediacensor-style-blur').scrollIntoViewIfNeeded()
      await expect(page.getByTestId('mediacensor-start')).toBeInViewport({ ratio: 1 })
      const box = await dialog.boundingBox()
      expect(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height).toBe(true)
      // nothing in the dialog is cut off sideways
      const sideways = await dialog.evaluate((el) => [...el.querySelectorAll<HTMLElement>('*')].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX === 'visible').map((n) => n.className))
      expect(sideways).toEqual([])
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.goto('about:blank')
    }
  })
}

test('a folder job runs for real: progress in Jobs, honest end, the files written, Show in folder', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openDialogFromCensorStep(page, batchId)
  fs.rmSync(OUT, { recursive: true, force: true })
  await page.getByTestId('mediacensor-style-black').click()
  await page.getByTestId('mediacensor-start').click()
  // the dialog hands over to the Jobs drawer
  await expect(page.getByTestId('mediacensor-dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('jobs-drawer')).toBeVisible()
  const expected = GIFS + VIDEOS()
  // synthetic frames hold nothing to cover: the job says so, and still writes the copies
  await expect(headline(page)).toContainText(new RegExp(`^(Nothing to cover was found in ${expected} files|Censored ${expected} files)`), { timeout: 180_000 })
  await expect(page.getByTestId('mediacensor-file')).toHaveCount(expected)
  await expect.poll(() => fs.readdirSync(OUT).sort()).toEqual(
    ['v4mc-clip-a_censored.gif', 'v4mc-clip-b_censored.gif', ...(realVideo ? ['v4mc-clip_censored.mp4'] : [])].sort(),
  )
  const reveal = page.waitForRequest((req) => /\/reveal\/0$/.test(req.url()))
  await page.getByTestId('mediacensor-reveal').first().click()
  await reveal
  const opened = page.waitForRequest((req) => req.url().endsWith('/api/open-path'))
  await page.getByTestId('mediacensor-open-folder').click()
  expect((await opened).postDataJSON()).toEqual({ path: OUT })
  // the GIF keeps its frames
  const gif = runBackendScript(`
from PIL import Image
im = Image.open(${JSON.stringify(path.join(OUT, 'v4mc-clip-a_censored.gif'))})
print(im.n_frames)
`)
  expect(gif).toBe('4')
})

test('a GIF with something to find is really censored: the covered frames are counted and the pixels differ', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const art = path.join(tmpRoot, DIR, 'art')
  const out = path.join(tmpRoot, DIR, 'out-art')
  fs.rmSync(out, { recursive: true, force: true })
  await openDialogFromCensorStep(page, batchId)
  await page.getByTestId('mediacensor-folder').fill(art)
  await expect(page.getByTestId('mediacensor-found')).toHaveText('Found 1 GIF and 0 videos.')
  await page.getByTestId('mediacensor-output').fill(out)
  await page.getByTestId('mediacensor-every').evaluate((el) => (el.closest('details') as HTMLDetailsElement).setAttribute('open', ''))
  await page.getByTestId('mediacensor-every').fill('1')
  await page.getByTestId('mediacensor-start').click()
  await expect(headline(page)).toContainText(/^Censored 1 file\. Saved in /, { timeout: 120_000 })
  await expect(page.getByTestId('mediacensor-file')).toContainText(/Done, \d+ frames? covered/)
  const changed = runBackendScript(`
from PIL import Image, ImageChops
before = Image.open(${JSON.stringify(path.join(art, 'v4mc-art.gif'))}).convert("RGB")
after_gif = Image.open(${JSON.stringify(path.join(out, 'v4mc-art_censored.gif'))})
frames = after_gif.n_frames
after = after_gif.convert("RGB")
box = (140, 214, 265, 309)
print(frames, ImageChops.difference(before.crop(box), after.crop(box)).getbbox() is not None)
`)
  expect(changed).toBe('3 True')
})

test('picked GIFs and videos from the library go to the dialog, the pictures to the censor step', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await boot(page, '')
  await openLibrary(page, TOKEN, PICTURES + GIFS + VIDEOS())
  await page.getByTestId('tile').first().click()
  await page.keyboard.press('Control+a')
  const bar = page.getByTestId('selection-bar')
  await bar.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Censor…' }).click()
  await expect(page.getByTestId('mediacensor-picks')).toHaveText(`Your selection: ${GIFS} GIFs and ${VIDEOS()} ${VIDEOS() === 1 ? 'video' : 'videos'}`)
  await expect(page.getByTestId('mediacensor-folder')).toHaveCount(0)
  // the two stills became a batch on its censor step, behind the dialog
  await expect(page).toHaveURL(/#\/batch\/\d+/)
  await expect(page.getByTestId('censor-position')).toHaveText(`1 / ${PICTURES}`)
  // a video can be left out
  if (realVideo) {
    await page.getByTestId('mediacensor-videos').uncheck()
    await expect(page.getByTestId('mediacensor-start')).toHaveText(`Start (${GIFS} files)`)
    await page.getByTestId('mediacensor-videos').check()
  }
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('mediacensor-dialog')).toHaveCount(0)
  cleanBatches()
})

test('a picked GIF runs as a job with Stop, and Stop keeps what was done', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await boot(page, '')
  await openLibrary(page, LONG_TOKEN, 1)
  await page.getByTestId('tile').first().click()
  await page.keyboard.press('Control+a')
  const bar = page.getByTestId('selection-bar')
  await bar.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Censor…' }).click()
  await expect(page.getByTestId('mediacensor-picks')).toHaveText('Your selection: 1 GIF and 0 videos')
  await expect(page.getByTestId('mediacensor-start')).toHaveText('Start (1 file)')
  await page.getByTestId('mediacensor-start').click()
  const job = page.getByTestId('job').first()
  await expect(job).toContainText('Censoring v4mc-long.gif…', { timeout: 30_000 })
  const cancel = page.waitForRequest((req) => /\/cancel$/.test(req.url()) && req.method() === 'POST')
  await job.getByRole('button', { name: 'Stop' }).click()
  await cancel
  // stopped, or it had already finished: never left running
  await expect(headline(page)).toContainText(/^(Stopped before any file was finished|Nothing to cover was found in 1 file|Censored 1 file)/, { timeout: 25_000 })
  await expect(job.getByRole('button', { name: 'Stop' })).toHaveCount(0)
})

test('a program that stops answering is said, and a job it no longer knows ends honestly', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await boot(page, '')
  await openLibrary(page, LONG_TOKEN, 1)
  await page.getByTestId('tile').first().click()
  await page.keyboard.press('Control+a')
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Censor…' }).click()
  const started = page.waitForResponse((res) => res.url().endsWith('/api/censor/media/start'))
  await page.getByTestId('mediacensor-start').click()
  const jobId = ((await (await started).json()) as { job_id: string }).job_id
  const job = page.getByTestId('job').first()
  await expect(job).toContainText('Censoring v4mc-long.gif…', { timeout: 30_000 })
  const jobUrl = '**/api/censor/media/jobs/*'
  const quiet = (route: import('@playwright/test').Route) => (route.request().method() === 'GET' ? route.abort() : route.fallback())
  await page.route(jobUrl, quiet)
  await expect(page.getByText('Lost contact with the program. Still trying')).toBeVisible({ timeout: 20_000 })
  await expect(headline(page)).toContainText('lost contact with the program')
  await page.unroute(jobUrl, quiet)
  await expect(page.getByText('In contact with the program again.')).toBeVisible({ timeout: 20_000 })
  await expect(headline(page)).not.toContainText('lost contact')
  // the program restarted: it answers 404 for a job it does not know
  const gone = (route: import('@playwright/test').Route) => (route.request().method() === 'GET' ? route.fulfill({ status: 404, json: { detail: 'Unknown job.' } }) : route.fallback())
  await page.route(jobUrl, gone)
  await expect(headline(page)).toContainText('The censoring job is gone (the program was restarted)', { timeout: 20_000 })
  await expect(job.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  // free the backend's worker for whatever runs next
  await page.unroute(jobUrl, gone)
  expect((await page.request.post(`/api/censor/media/jobs/${jobId}/cancel`)).ok()).toBe(true)
})

test('a video asks for ffmpeg first when it is not installed', async ({ page }) => {
  test.skip(!realVideo, 'needs ffmpeg on this machine to make a video')
  await page.setViewportSize({ width: 1920, height: 1080 })
  const prepared: Record<string, unknown>[] = []
  await page.route('**/api/models/status', (route) =>
    route.fulfill({ json: { models: [{ id: 'censor-nudenet', status: 'ready', available: true }, { id: 'video-ffmpeg', status: 'missing', available: false }] } }),
  )
  await page.route('**/api/censor/media/list', async (route) => {
    const real = await route.fetch()
    await route.fulfill({ response: real, json: { ...(await real.json()), video_ready: false } })
  })
  await page.route('**/api/models/prepare', async (route) => {
    prepared.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: 'downloading', model_id: 'video-ffmpeg', run_id: 1 } })
  })
  // nothing downloads: the question is answered, and the download only shows once it was asked for
  await page.route('**/api/models/download-progress', (route) =>
    route.fulfill({
      json: prepared.length
        ? { active: true, downloaded: 1, total: 10, prepare_result: { active: true, model_id: 'video-ffmpeg', run_id: 1 } }
        : { active: false, downloaded: 0, total: 0, prepare_result: { active: false, run_id: 0 } },
    }),
  )
  await openDialogFromCensorStep(page, batchId, 'en', 'vopus', false)
  await expect(page.getByTestId('mediacensor-video-note')).toContainText('Videos need the ffmpeg component first')
  await page.getByTestId('mediacensor-start').click()
  await expect.poll(() => prepared.map((p) => p.model_id)).toEqual(['video-ffmpeg'])
  await expect(page.getByTestId('mediacensor-dialog')).toHaveCount(0)
  await expect(page.getByText('Installing ffmpeg first')).toBeVisible()
  // GIFs alone need nothing installed
  await page.getByTestId('mediacensor-open').click()
  await page.getByTestId('mediacensor-videos').uncheck()
  await expect(page.getByTestId('mediacensor-video-note')).toHaveCount(0)
})

test('the new interface opens the same dialog for picked GIFs', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await boot(page, '', 'en', 'next')
  const input = page.getByTestId('query-input')
  await input.fill(TOKEN)
  await input.press('Enter')
  await expect(page.getByTestId('result-count')).toHaveText(`${PICTURES + GIFS + VIDEOS()} images`)
  await page.getByTestId('tile').first().click()
  await page.keyboard.press('Control+a')
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Censor…' }).click()
  await expect(page.getByTestId('mediacensor-dialog')).toBeVisible()
  await expect(page.getByTestId('mediacensor-picks')).toContainText(`${GIFS} GIFs`)
  await page.keyboard.press('Escape')
  cleanBatches()
})

test('the new interface reaches it from the censor step too', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openDialogFromCensorStep(page, batchId, 'zh-CN', 'next')
  await expect(page.getByTestId('mediacensor-start')).toBeVisible()
  await expect(page.getByTestId('mediacensor-dialog')).toContainText('GIF 与视频打码')
  cleanBatches()
})
