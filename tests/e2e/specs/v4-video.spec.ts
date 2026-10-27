import path from 'node:path'

import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { PY_DELETE_IMAGES } from '../fixtures/e2e-db'
import { cleanupImages, dbPath, openLibrary, pageOverflow, repoRoot, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * Video in V Opus and /next/ (slice `video`): the All / Pictures / Videos
 * toggle (a media: token in the search line, so every list, count and "select
 * all matches" request carries it), the play mark and length on a tile, the
 * player in the big image (native controls, Loop, Sound, frame steps, keys, a
 * converted preview for a codec the browser cannot play), and video support
 * (Settings row, library banner, install as a job).
 *
 * The video is real when ffmpeg exists on this machine (a 2 s clip made by
 * ffmpeg); the install itself is never run: /api/video-support is answered by
 * the spec so nothing downloads 77 MB.
 *
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const LIB = 'lib_v4e2e_video'
const PREFIX = 'v4video-'
const TOKEN = 'v4videotoken'
const DIR = 'v4-video'
const PICTURES = 6
const VIDEOS = 3
const TOTAL = PICTURES + VIDEOS
const CLIP_A = `${PREFIX}clip-a.webm`
const CLIP_B = `${PREFIX}clip-b.webm`
const CLIP_C = `${PREFIX}clip-c.webm`

let realVideo = false

function seedVideos(): boolean {
  const out = runBackendScript(`
import shutil, sqlite3, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(${JSON.stringify(repoRoot)}) / "backend"))
from utils.source_paths import indexed_image_path_casefold
root = Path(${JSON.stringify(path.join(tmpRoot, DIR))})
root.mkdir(parents=True, exist_ok=True)
a = root / ${JSON.stringify(CLIP_A)}
b = root / ${JSON.stringify(CLIP_B)}
c = root / ${JSON.stringify(CLIP_C)}
real = False
ffmpeg = shutil.which("ffmpeg")
if ffmpeg:
    run = subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=12:duration=2",
         "-c:v", "libvpx-vp9", "-b:v", "200k", "-an", str(a)],
        capture_output=True,
    )
    real = run.returncode == 0 and a.is_file() and a.stat().st_size > 0
if not real:
    a.write_bytes(b"not a real video")
shutil.copyfile(a, b)
shutil.copyfile(a, c)
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    cur.execute("INSERT OR IGNORE INTO libraries (id, name, is_default) VALUES (?, 'V4 e2e video', 0)", (${JSON.stringify(LIB)},))
    for i, (name, codec) in enumerate([(${JSON.stringify(CLIP_A)}, "vp9"), (${JSON.stringify(CLIP_B)}, "prores"), (${JSON.stringify(CLIP_C)}, "vp9")]):
        p = (root / name).resolve()
        cur.execute(
            """INSERT INTO images (path, filename, generator, prompt, negative_prompt, metadata_json, width, height, file_size,
                   source_size, source_mtime_ns, is_readable, metadata_status, created_at, library_order_time, user_rating,
                   library_id, duration_seconds, video_codec, video_fps, video_has_audio, video_probe_state)
               VALUES (?, ?, 'comfyui', ?, '', '{}', 160, 120, ?, ?, ?, 1, 'complete',
                   datetime('now', ?), datetime('now', ?), 0, ?, 2.0, ?, 12.0, 0, 'ready')""",
            (str(p), name, f"${TOKEN}, clip {i}", p.stat().st_size, p.stat().st_size, p.stat().st_mtime_ns,
             f"-{200 + i} minutes", f"-{200 + i} minutes", ${JSON.stringify(LIB)}, codec),
        )
        image_id = cur.lastrowid
        cur.execute("INSERT INTO image_path_identities (image_id, path_key) VALUES (?, ?)", (image_id, indexed_image_path_casefold(str(p))))
        cur.execute("INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)", (image_id, ${JSON.stringify(TOKEN)}))
    conn.commit()
print("real" if real else "fake")
`)
  return out.endsWith('real')
}

function dropLibrary(): void {
  runBackendScript(`
${PY_DELETE_IMAGES}
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    delete_images(conn, "library_id = ?", (${JSON.stringify(LIB)},))
    conn.execute("DELETE FROM libraries WHERE id = ?", (${JSON.stringify(LIB)},))
    conn.commit()
print("ok")
`)
}

test.beforeAll(() => {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("INSERT OR IGNORE INTO libraries (id, name, is_default) VALUES (?, 'V4 e2e video', 0)", (${JSON.stringify(LIB)},))
    conn.commit()
print("ok")
`)
  seedImages({ prefix: PREFIX, token: TOKEN, count: PICTURES, dir: DIR, library: LIB })
  realVideo = seedVideos()
})
test.afterAll(() => {
  cleanupImages(PREFIX, [DIR])
  dropLibrary()
})

interface SupportState {
  available: boolean
  install: { state: 'idle' | 'running' | 'failed' | 'done'; phase?: string; downloaded?: number; total?: number | null; error?: string }
}

/** Answer GET /api/video-support from `state()` and the install POST with a running download; nothing real is installed. */
async function stubSupport(page: Page, state: () => SupportState, onInstall?: () => void) {
  await page.route(/\/api\/video-support(\?.*)?$/, (route: Route) => {
    const s = state()
    return route.fulfill({
      json: {
        available: s.available,
        source: s.available ? 'path' : null,
        can_install: true,
        estimated_mb: 77,
        download_from: 'github.com/BtbN/FFmpeg-Builds',
        install: s.install,
        indexing: false,
        videos: VIDEOS,
        pending: 0,
        unreadable: 0,
      },
    })
  })
  await page.route('**/api/video-support/install', (route: Route) => {
    onInstall?.()
    return route.fulfill({ json: { state: 'running', phase: 'looking', downloaded: 0, total: null } })
  })
}

async function openVideoLibrary(page: Page) {
  await markModelsReady(page)
  await openLibrary(page, TOKEN, TOTAL, 'dark', LIB)
}

/** Switch the language and reload (openLibrary seeds English once per session, so the choice survives the reload). */
async function inChinese(page: Page) {
  await page.evaluate(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('gallery-scroller')).toBeVisible()
}

const tileOf = (page: Page, name: string) => page.locator(`[data-testid="tile"][title="${name}"]`)

test('the toggle narrows the list to pictures or videos and the count follows', async ({ page }) => {
  await openVideoLibrary(page)
  const toggle = page.getByTestId('media-toggle')
  await expect(toggle).toBeVisible()
  await expect(page.getByTestId('media-all')).toHaveAttribute('aria-pressed', 'true')

  const videosOnly = page.waitForRequest((req) => req.url().includes('/api/images?') && req.url().includes('media_type=video'))
  await page.getByTestId('media-video').click()
  await videosOnly
  await expect(page.getByTestId('result-count')).toHaveText(`${VIDEOS} images`)
  await expect(page.getByTestId('tile')).toHaveCount(VIDEOS)
  await expect(page.getByTestId('video-badge')).toHaveCount(VIDEOS)
  await expect(page.getByTestId('query-input')).toHaveValue(`${TOKEN} media:video`)
  await expect(page.getByTestId('query-chips')).toContainText('Type')
  await expect(page.getByTestId('media-video')).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('media-image').click()
  await expect(page.getByTestId('result-count')).toHaveText(`${PICTURES} images`)
  await expect(page.getByTestId('video-badge')).toHaveCount(0)
  await expect(page.getByTestId('query-input')).toHaveValue(`${TOKEN} media:image`)

  await page.getByTestId('media-all').click()
  await expect(page.getByTestId('result-count')).toHaveText(`${TOTAL} images`)
  await expect(page.getByTestId('query-input')).toHaveValue(TOKEN)
})

test('typing media:video does the same, and a wrong value says what is allowed', async ({ page }) => {
  await openVideoLibrary(page)
  const input = page.getByTestId('query-input')
  await input.fill(`${TOKEN} media:video`)
  await input.press('Enter')
  await expect(page.getByTestId('result-count')).toHaveText(`${VIDEOS} images`)
  await expect(page.getByTestId('media-video')).toHaveAttribute('aria-pressed', 'true')
  await input.fill(`${TOKEN} media:gif`)
  await input.press('Enter')
  await expect(page.getByTestId('query-chips')).toContainText('Write image or video')
  await expect(page.getByTestId('result-count')).toHaveText(`${TOTAL} images`)
})

test('"select all matches" carries the media filter, so a video-only pick is only videos', async ({ page }) => {
  await openVideoLibrary(page)
  await page.getByTestId('media-video').click()
  await expect(page.getByTestId('tile')).toHaveCount(VIDEOS)
  await tileOf(page, CLIP_A).click({ modifiers: ['Control'] })
  const bodies: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/selection-ids')) bodies.push(req.postData() ?? '')
  })
  await page.getByTestId('select-all-matching').click()
  await expect(page.getByTestId('selection-bar')).toContainText(String(VIDEOS))
  expect(bodies.length).toBeGreaterThan(0)
  expect(JSON.parse(bodies[0]!)).toMatchObject({ mediaType: 'video' })
})

test('a video tile shows its play mark and length, and says so to a screen reader', async ({ page }) => {
  await openVideoLibrary(page)
  const tile = tileOf(page, CLIP_A)
  await expect(tile.getByTestId('video-badge')).toContainText('0:02')
  await expect(tile).toHaveAttribute('aria-label', /Video 0:02/)
  // pictures carry no mark
  await expect(page.getByTestId('tile').filter({ has: page.getByTestId('video-badge') })).toHaveCount(VIDEOS)
})

test('opening a video plays it: controls, loop, sound, frame steps and keys', async ({ page }) => {
  test.skip(!realVideo, 'ffmpeg is not on this machine, so no real clip could be made')
  await openVideoLibrary(page)
  await tileOf(page, CLIP_A).dblclick()
  const stage = page.getByTestId('lightbox-video')
  await expect(stage).toBeVisible()
  const video = page.getByTestId('video-element')
  await expect(video).toHaveAttribute('src', /\/api\/image-file\/\d+/)
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  expect(await video.evaluate((v: HTMLVideoElement) => Math.round(v.duration))).toBe(2)
  await expect(page.getByTestId('video-facts')).toContainText('160×120')
  await expect(page.getByTestId('video-facts')).toContainText('0:02')
  await expect(page.getByTestId('video-facts')).toContainText('VP9')
  await expect(page.getByTestId('lightbox-zoom-toggle')).toHaveCount(0)

  // Loop: on by default, flips both ways, remembered
  const loop = page.getByTestId('video-loop')
  await expect(loop).toHaveText('Loop: on')
  expect(await video.evaluate((v: HTMLVideoElement) => v.loop)).toBe(true)
  await loop.click()
  await expect(loop).toHaveText('Loop: off')
  expect(await video.evaluate((v: HTMLVideoElement) => v.loop)).toBe(false)
  // Sound
  const sound = page.getByTestId('video-sound')
  await expect(sound).toHaveText('Sound: on')
  await sound.click()
  await expect(sound).toHaveText('Sound: off')
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true)

  // Space pauses and plays; period and comma step one frame (12 per second)
  await page.keyboard.press('Space')
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  const t0 = await video.evaluate((v: HTMLVideoElement) => v.currentTime)
  await page.keyboard.press('.')
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(t0 + 1 / 12, 1)
  const t1 = await video.evaluate((v: HTMLVideoElement) => v.currentTime)
  await page.getByTestId('video-prev-frame').click()
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(t1)
  await page.keyboard.press('k')
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)

  // the choices were saved
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sd-v4-video-viewer') ?? '{}'))).toEqual({ loop: false, muted: true })
  // Esc closes only the lightbox
  await page.keyboard.press('Escape')
  await expect(stage).toHaveCount(0)
  await expect(page.getByTestId('gallery-scroller')).toBeVisible()
})

test('a codec the browser cannot play gets a converted preview, made for real', async ({ page }) => {
  test.skip(!realVideo, 'ffmpeg is not on this machine, so no real clip could be made')
  test.setTimeout(120_000)
  await openVideoLibrary(page)
  await tileOf(page, CLIP_B).dblclick()
  await expect(page.getByTestId('lightbox-video')).toBeVisible()
  // ProRes is not played from the original: the preview is asked for and followed
  await expect(page.getByTestId('video-note')).toContainText(/playable preview|converted preview/, { timeout: 15_000 })
  await expect(page.getByTestId('video-note')).toContainText('Playing a converted preview', { timeout: 90_000 })
  await expect(page.getByTestId('video-element')).toHaveAttribute('src', /\/api\/videos\/\d+\/converted/)
  const video = page.getByTestId('video-element')
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
})

test('without ffmpeg an unplayable video says so and offers the install', async ({ page }) => {
  await stubSupport(page, () => ({ available: false, install: { state: 'idle' } }))
  await page.route(/\/api\/videos\/\d+\/playback$/, (route: Route) =>
    route.fulfill({
      json: {
        id: 0, codec: 'prores', duration: 2, fps: 12, has_audio: false, probe_state: 'ready', probe_error: null,
        plays_in_browser: false, tools_available: false, converted: { status: 'none', progress: 0, error: null }, converted_url: '',
      },
    }),
  )
  await openVideoLibrary(page)
  await tileOf(page, CLIP_B).dblclick()
  const note = page.getByTestId('video-note')
  await expect(note).toContainText('The browser cannot play this video')
  await expect(note).toContainText('Install video support (about 77 MB)')
  await expect(page.getByTestId('video-note-install')).toBeVisible()
})

test('the banner offers video support when the library has videos and ffmpeg is missing, and the install runs as a job', async ({ page }) => {
  let phase: 'idle' | 'running' | 'failed' = 'idle'
  await stubSupport(
    page,
    () => ({
      available: false,
      install:
        phase === 'running' ? { state: 'running', phase: 'downloading', downloaded: 38_000_000, total: 77_000_000 }
        : phase === 'failed' ? { state: 'failed', error: '<urlopen error [WinError 10061] ...>', error_code: 'video_install_unreachable', error_params: {} }
        : { state: 'idle' },
    }),
    () => {
      phase = 'running'
    },
  )
  await openVideoLibrary(page)
  const banner = page.getByTestId('video-banner')
  await expect(banner).toContainText(`${VIDEOS} videos have no frames or generation info yet`)
  await expect(banner).toContainText('github.com/BtbN/FFmpeg-Builds')
  await expect(page.getByTestId('video-banner-install')).toHaveText('Install video support (about 77 MB)')

  await page.getByTestId('video-banner-install').click()
  await expect(banner).toContainText('Downloading ffmpeg: 38 of 77 MB...')
  await expect(page.getByTestId('video-banner-install')).toBeDisabled()
  // it is a job: the drawer says what it does
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer')).toContainText('Installing video support')
  await page.keyboard.press('Escape')

  // the download fails: said plainly, and it can be tried again
  phase = 'failed'
  await expect(banner).toContainText('The install failed: The download site could not be reached', { timeout: 10_000 })
  await expect(banner).not.toContainText('WinError')
  await expect(banner).not.toContainText('video_install')
  await expect(page.getByTestId('video-banner-install')).toHaveText('Try again')
  await expect(page.getByTestId('video-banner-install')).toBeEnabled()

  await page.getByTestId('video-banner-dismiss').click()
  await expect(banner).toHaveCount(0)
})

test('Settings › Models has the video support row in both languages', async ({ page }) => {
  let phase: 'idle' | 'running' | 'failed' = 'idle'
  await stubSupport(
    page,
    () => ({
      available: false,
      install:
        phase === 'running' ? { state: 'running', phase: 'downloading', downloaded: 20_000_000, total: 77_000_000 }
        : phase === 'failed' ? { state: 'failed', error: 'checksum did not match', error_code: 'video_install_site_refused', error_params: { status: 403 } }
        : { state: 'idle' },
    }),
    () => {
      phase = 'running'
    },
  )
  await markModelsReady(page)
  await page.addInitScript(() => {
    // English the first time only: the test switches the language and reloads
    if (!sessionStorage.getItem('v4video-init')) {
      sessionStorage.setItem('v4video-init', '1')
      localStorage.setItem('sd-image-sorter-lang', 'en')
    }
    localStorage.setItem('sd-v4-update-autocheck', '0')
  })
  await page.goto('/vopus/#/settings/models', { waitUntil: 'domcontentloaded' })
  const row = page.getByTestId('video-support')
  await expect(row).toBeVisible()
  await expect(page.getByTestId('video-support-status')).toContainText('Not installed')
  await page.getByTestId('video-support-install').click()
  await expect(page.getByTestId('video-support-status')).toContainText('Downloading ffmpeg: 20 of 77 MB...')
  await expect(page.getByTestId('video-support-progress')).toBeVisible()
  phase = 'failed'
  await expect(page.getByTestId('video-support-status')).toContainText('The install failed: The download site answered 403 instead of the file', { timeout: 10_000 })
  await expect(page.getByTestId('video-support-status')).not.toContainText('checksum did not match')
  await expect(page.getByTestId('video-support-install')).toHaveText('Try again')

  await page.evaluate(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('video-support')).toContainText('视频支持')
  await expect(page.getByTestId('video-support-status')).toContainText('安装失败：下载站点返回了 403')
  await expect(page.getByTestId('video-support-install')).toHaveText('重试')
})

test('the real status: with ffmpeg on this machine the row says it is ready', async ({ page }) => {
  test.skip(!realVideo, 'ffmpeg is not on this machine')
  await markModelsReady(page)
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-update-autocheck', '0')
  })
  await page.goto('/vopus/#/settings/models', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('video-support-status')).toContainText('Ready: ffmpeg', { timeout: 15_000 })
  await expect(page.getByTestId('video-support-install')).toHaveCount(0)
})

test('the toggle is not there when the library has no videos', async ({ page }) => {
  await markModelsReady(page)
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-update-autocheck', '0')
    localStorage.setItem('sd-v4-prefs', JSON.stringify({ startPage: 'library' }))
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' }))
  })
  const stats = page.waitForResponse((res) => res.url().includes('/api/stats') && res.ok())
  await page.goto('/vopus/', { waitUntil: 'domcontentloaded' })
  const answer = (await (await stats).json()) as { video_count?: number }
  await expect(page.getByTestId('query-input')).toBeVisible()
  // the main library of the isolated test database holds no videos (this spec's are in a library of their own)
  expect(answer.video_count ?? 0).toBe(0)
  await expect(page.getByTestId('media-toggle')).toHaveCount(0)
  await expect(page.getByTestId('video-banner')).toHaveCount(0)
})

const idOf = async (page: Page, name: string) => Number(await tileOf(page, name).getAttribute('data-id'))
const toastWith = (page: Page, text: string | RegExp) => page.locator('[role="status"]', { hasText: text })

test('picture-only actions are shown disabled for a video, with the reason; a picture keeps them', async ({ page }) => {
  await openVideoLibrary(page)
  await tileOf(page, CLIP_A).click({ button: 'right' })
  const menu = page.getByTestId('card-menu')
  await expect(menu).toBeVisible()
  for (const id of ['similar', 'near', 'tag']) await expect(menu.locator(`[data-item="${id}"]`)).toBeDisabled()
  await expect(menu.locator('[data-item="similar"]')).toContainText('Not for videos')
  // what a video can do stays on; Censor sends it to the GIF and video censor
  await expect(menu.locator('[data-item="censor"]')).toBeEnabled()
  await expect(menu.locator('[data-item="censor"]')).not.toContainText('Not for videos')
  await expect(menu.locator('[data-item="open"]')).toBeEnabled()
  await expect(menu.locator('[data-item="move"]')).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.getByTestId('tile').filter({ hasNot: page.getByTestId('video-badge') }).first().click({ button: 'right' })
  for (const id of ['similar', 'near', 'tag', 'censor']) await expect(menu.locator(`[data-item="${id}"]`)).toBeEnabled()
  await page.keyboard.press('Escape')
})

test('the card of a video disables find-similar and style identification', async ({ page }) => {
  await openVideoLibrary(page)
  await tileOf(page, CLIP_A).click()
  await expect(page.getByTestId('card-find-similar')).toBeDisabled()
  await expect(page.getByTestId('card-find-similar')).toHaveAttribute('title', /pictures only/)
  await expect(page.getByTestId('card-identify-artist')).toBeDisabled()
  await page.getByTestId('tile').filter({ hasNot: page.getByTestId('video-badge') }).first().click()
  await expect(page.getByTestId('card-find-similar')).toBeEnabled()
})

test('a picked video: the bar disables Tag (Censor goes to the video censor), and Ctrl K lists Tag with the reason, says why and sends nothing', async ({ page }) => {
  const sent: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/(batches|censor|artists|aesthetic|tag)/.test(req.url())) sent.push(req.url())
  })
  await openVideoLibrary(page)
  await tileOf(page, CLIP_A).click({ modifiers: ['Control'] })
  const bar = page.getByTestId('selection-bar')
  await expect(bar.locator('[data-action="tag"]')).toBeDisabled()
  await bar.getByRole('button', { name: 'More' }).click()
  await expect(page.locator('[data-item="censor"]')).toBeEnabled()
  await page.keyboard.press('Escape')

  await page.getByTestId('open-palette').click()
  await page.keyboard.type('tag')
  const palette = page.getByTestId('palette')
  const entry = palette.getByRole('option').filter({ hasText: 'Not for videos' }).first()
  await expect(entry).toBeVisible()
  await entry.click()
  await expect(toastWith(page, /Nothing was done: 1 video was left out/)).toBeVisible()
  expect(sent).toEqual([])
})

test('Censor on a mixed pick sends the picture to the censor step and the video to the GIF and video censor', async ({ page }) => {
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/batches', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    bodies.push(route.request().postDataJSON() as Record<string, unknown>)
    return route.fulfill({ status: 500, json: { detail: 'stubbed: nothing is created by this test' } })
  })
  await openVideoLibrary(page)
  const picture = page.getByTestId('tile').filter({ hasNot: page.getByTestId('video-badge') }).first()
  const pictureId = Number(await picture.getAttribute('data-id'))
  await picture.click({ modifiers: ['Control'] })
  await tileOf(page, CLIP_A).click({ modifiers: ['Control'] })
  await expect(page.getByTestId('selection-bar')).toContainText('2')
  await page.getByTestId('open-palette').click()
  await page.keyboard.type('censor')
  const entry = page.getByTestId('palette').getByRole('option').first()
  await expect(entry).not.toContainText('Not for videos')
  await entry.click()
  // the video is not dropped: it waits in the GIF and video censor
  await expect(page.getByTestId('mediacensor-dialog')).toBeVisible()
  await expect(page.getByTestId('mediacensor-picks')).toContainText('1 video')
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]!.image_ids).toEqual([pictureId])
})

test('Tag on a mixed pick opens for the pictures and names the videos it left out', async ({ page }) => {
  await markModelsReady(page)
  await openLibrary(page, TOKEN, TOTAL, 'dark', LIB)
  await tileOf(page, CLIP_C).click({ modifiers: ['Control'] })
  await page.getByTestId('tile').filter({ hasNot: page.getByTestId('video-badge') }).first().click({ modifiers: ['Control'] })
  await page.getByTestId('selection-bar').locator('[data-action="tag"]').click()
  await expect(toastWith(page, /1 video was left out/)).toBeVisible()
  await expect(page.getByRole('dialog').first()).toBeVisible()
  await page.keyboard.press('Escape')
})

test('the play mark shows wherever a video tile shows: the big image strip, Home and a batch', async ({ page }) => {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("UPDATE images SET user_rating = 5 WHERE filename = ?", (${JSON.stringify(CLIP_A)},))
    conn.commit()
print("ok")
`)
  await openVideoLibrary(page)
  const clipId = await idOf(page, CLIP_A)
  // the big image's film strip
  await page.getByTestId('tile').filter({ hasNot: page.getByTestId('video-badge') }).first().dblclick()
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await expect(page.getByTestId('lightbox').getByTestId('video-badge').first()).toBeVisible()
  await page.keyboard.press('Escape')
  // Home's starred film
  await page.evaluate(() => {
    location.hash = '#/home'
  })
  await expect(page.getByTestId('home-frame').filter({ has: page.getByTestId('video-badge') }).first()).toBeVisible({ timeout: 15_000 })
  // a batch's pick step
  const id = await page.evaluate(
    async ({ lib, imageId }) => {
      const res = await fetch('/api/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SD-Library-Id': lib },
        body: JSON.stringify({ kind: 'custom', name: 'v4video e2e batch', image_ids: [imageId] }),
      })
      return ((await res.json()) as { batch: { id: number } }).batch.id
    },
    { lib: LIB, imageId: clipId },
  )
  {
    await page.evaluate((batchId) => {
      location.hash = `#/batch/${batchId}`
    }, id)
    await expect(page.getByTestId('pick-tile').getByTestId('video-badge')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('step-next').click()
    await expect(page.getByTestId('order-tile').getByTestId('video-badge')).toBeVisible({ timeout: 15_000 })
    await page.evaluate(async ({ lib, batchId }) => {
      await fetch(`/api/batches/${batchId}`, { method: 'DELETE', headers: { 'X-SD-Library-Id': lib } })
    }, { lib: LIB, batchId: id })
  }
})

test('hovering a video tile plays it muted, scrubs across the tile, and only one plays at a time', async ({ page }) => {
  test.skip(!realVideo, 'ffmpeg is not on this machine, so no real clip could be made')
  await openVideoLibrary(page)
  await page.getByTestId('media-video').click()
  await expect(page.getByTestId('tile')).toHaveCount(VIDEOS)
  const a = tileOf(page, CLIP_A)
  const c = tileOf(page, CLIP_C)
  // nothing is loaded until the pointer rests on a tile
  await expect(page.getByTestId('video-hover')).toHaveCount(0)
  const box = (await a.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const hover = a.getByTestId('video-hover')
  await expect(hover).toHaveAttribute('data-playing', 'true', { timeout: 10_000 })
  expect(await hover.evaluate((v: HTMLVideoElement) => v.muted && v.loop)).toBe(true)
  // scrub: the right edge is near the end, the left edge near the start
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2)
  await expect.poll(() => hover.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1.5)
  await page.mouse.move(box.x + 3, box.y + box.height / 2)
  await expect.poll(() => hover.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(0.5)
  // a second tile takes over: the first stops
  const other = (await c.boundingBox())!
  await page.mouse.move(other.x + other.width / 2, other.y + other.height / 2)
  await expect(c.getByTestId('video-hover')).toHaveCount(1, { timeout: 10_000 })
  await expect(page.getByTestId('video-hover')).toHaveCount(1)
  // leaving every tile stops the playing one
  await page.mouse.move(2, 400)
  await expect(page.getByTestId('video-hover')).toHaveCount(0)
})

test('a codec the browser cannot play keeps its still frame on hover', async ({ page }) => {
  await openVideoLibrary(page)
  await page.getByTestId('media-video').click()
  const b = tileOf(page, CLIP_B)
  const box = (await b.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(700)
  await expect(page.getByTestId('video-hover')).toHaveCount(0)
})

test('with the card open at 1366x768 the search line, chips and counts fit in both languages', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openVideoLibrary(page)
  for (const lang of ['en', 'zh-CN'] as const) {
    if (lang === 'zh-CN') await inChinese(page)
    const input = page.getByTestId('query-input')
    await input.fill(`${TOKEN} media:video width>=100 height>=100 date:30d`)
    await input.press('Enter')
    await tileOf(page, CLIP_A).click()
    await expect(page.getByTestId('generation-card')).toBeVisible()
    const bar = page.getByTestId('query-bar')
    const barBox = (await bar.boundingBox())!
    for (const id of ['query-input', 'media-toggle', 'query-chips', 'result-count']) {
      const box = (await page.getByTestId(id).boundingBox())!
      expect(box.x, `${id} (${lang}) starts inside the bar`).toBeGreaterThanOrEqual(barBox.x - 1)
      expect(box.x + box.width, `${id} (${lang}) ends inside the bar`).toBeLessThanOrEqual(barBox.x + barBox.width + 1)
    }
    // the chips lie in rows under the controls, not stacked one to a line beside a squeezed box
    const chips = page.getByTestId('query-chips').locator('button')
    const first = (await chips.first().boundingBox())!
    const last = (await chips.last().boundingBox())!
    expect(last.y - first.y, `chips (${lang}) wrap into at most two rows`).toBeLessThan(60)
    expect((await input.boundingBox())!.width).toBeGreaterThanOrEqual(130)
    expect(await bar.evaluate((el: HTMLElement) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  }
})

for (const viewport of VIEWPORTS) {
  test(`the toolbar and the player fit at ${viewport.width}x${viewport.height} in both languages`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await markModelsReady(page)
    await openLibrary(page, TOKEN, TOTAL, 'dark', LIB)
    for (const lang of ['en', 'zh-CN'] as const) {
      if (lang !== 'en') {
        await page.evaluate((language) => localStorage.setItem('sd-image-sorter-lang', language), lang)
        await page.reload({ waitUntil: 'domcontentloaded' })
      }
      await expect(page.getByTestId('gallery-scroller')).toBeVisible()
      await expect(page.getByTestId('media-toggle')).toBeInViewport({ ratio: 1 })
      for (const id of ['media-all', 'media-image', 'media-video', 'query-input', 'result-count']) {
        await expect(page.getByTestId(id)).toBeInViewport()
      }
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      // the toggle's own buttons are not clipped by it
      const box = await page.getByTestId('media-toggle').boundingBox()
      const last = await page.getByTestId('media-video').boundingBox()
      expect(last!.x + last!.width).toBeLessThanOrEqual(box!.x + box!.width + 1)

      await page.getByTestId('tile').filter({ has: page.getByTestId('video-badge') }).first().dblclick()
      await expect(page.getByTestId('lightbox-video')).toBeVisible()
      for (const id of ['video-element', 'video-loop', 'video-sound', 'video-prev-frame', 'video-next-frame']) {
        await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
      }
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('lightbox-video')).toHaveCount(0)
    }
  })
}

test('/next/ has the toggle, the badge and the player too', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-update-autocheck', '0')
    localStorage.setItem('sd-v4-update-autocheck', '0')
  })
  await page.addInitScript((lib) => {
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: lib }))
  }, LIB)
  await markModelsReady(page)
  const res = await page.goto('/next/', { waitUntil: 'domcontentloaded' })
  expect(res?.status()).toBe(200)
  const input = page.getByTestId('query-input')
  await input.fill(TOKEN)
  await input.press('Enter')
  await expect(page.getByTestId('result-count')).toHaveText(`${TOTAL} images`)
  await expect(page.getByTestId('media-toggle')).toBeVisible()
  await page.getByTestId('media-video').click()
  await expect(page.getByTestId('result-count')).toHaveText(`${VIDEOS} images`)
  await expect(page.getByTestId('video-badge')).toHaveCount(VIDEOS)
  await tileOf(page, CLIP_A).dblclick()
  await expect(page.getByTestId('lightbox-video')).toBeVisible()
  await expect(page.getByTestId('video-loop')).toBeVisible()
  await page.keyboard.press('Escape')
})
