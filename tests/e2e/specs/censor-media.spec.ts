import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/click-ledger'

/**
 * GIF / video auto-censor dialog on the Censor page (2026-09-28).
 * The folder listing is real; the job endpoints are stubbed so no detector
 * model has to run. The job must carry the Censor page's detector settings.
 */

test.describe.configure({ mode: 'serial' })

function mediaFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-media-censor-'))
  fs.writeFileSync(path.join(folder, 'anim.gif'), Buffer.from('GIF89a'))
  fs.writeFileSync(path.join(folder, 'clip.mp4'), Buffer.from('not a real video'))
  return folder
}

async function openDialog(page: Page, ffmpeg: 'ready' | 'missing' = 'ready'): Promise<void> {
  // which ffmpeg video censoring would use is the program's answer; the other tests need videos to be possible
  await page.route('**/api/censor/media/status', (route) =>
    route.fulfill({ json: ffmpeg === 'ready' ? { video_ready: true, video_source: 'video_support' } : { video_ready: false, video_source: null } }),
  )
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1' && Boolean((window as any).MediaCensor))
  await page.evaluate(() => {
    ;(window as any).EntryPage?.hide?.()
    document.getElementById('nav-tab-censor')?.click()
    ;(window as any).ensureFeatureModel = async () => ({ ok: true })
  })
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await page.locator('#btn-media-censor-open').scrollIntoViewIfNeeded()
  await page.locator('#btn-media-censor-open').click()
  await expect(page.locator('#media-censor-modal')).toBeVisible()
}

test('the dialog lists the folder, starts a job with the Censor page settings and follows it', async ({ page }) => {
  const folder = mediaFolder()
  await openDialog(page)
  const started: Array<Record<string, unknown>> = []
  const revealed: string[] = []
  let polls = 0
  await page.route('**/api/censor/media/start', async (route) => {
    started.push(route.request().postDataJSON())
    await route.fulfill({
      json: {
        job_id: 'job1', id: 'job1', status: 'queued', output_folder: path.join(folder, 'censored'), done: 0, total: 2,
        files: [
          { name: 'anim.gif', status: 'queued', frames_done: 0, frames_total: 0, censored_frames: 0, output: '', error: '' },
          { name: 'clip.mp4', status: 'queued', frames_done: 0, frames_total: 0, censored_frames: 0, output: '', error: '' },
        ],
      },
    })
  })
  await page.route('**/api/censor/media/jobs/job1', async (route) => {
    polls += 1
    const done = polls >= 2
    await route.fulfill({
      json: {
        id: 'job1', status: done ? 'done' : 'running', done: done ? 2 : 1, total: 2, error: '',
        files: [
          { name: 'anim.gif', status: 'done', frames_done: 12, frames_total: 12, censored_frames: 7, output: path.join(folder, 'censored', 'anim_censored.gif'), error: '' },
          { name: 'clip.mp4', status: done ? 'done' : 'running', frames_done: done ? 50 : 20, frames_total: 50, censored_frames: done ? 31 : 0, output: done ? path.join(folder, 'censored', 'clip_censored.mp4') : '', error: '' },
        ],
      },
    })
  })
  await page.route('**/api/censor/media/jobs/job1/reveal/*', async (route) => {
    revealed.push(route.request().url())
    await route.fulfill({ json: { status: 'ok' } })
  })

  await page.locator('#media-censor-folder').fill(folder)
  await page.locator('#media-censor-folder').dispatchEvent('change')
  await expect(page.locator('#media-censor-found')).toContainText('Found 1 GIF and 1 video.')
  await page.locator('#media-censor-style').selectOption('blur')
  await page.locator('#media-censor-every').fill('3')
  await page.locator('#media-censor-start').click()

  await expect.poll(() => started.length).toBe(1)
  expect(started[0]).toMatchObject({
    folder, output_folder: '', include_videos: true, style: 'blur', detect_every: 3, hold: 8,
    face_guard: true, shape: 'precise', expand_percent: 0, block_size: 0,
  })
  // An empty save folder stays empty after the start: it means the output
  // root's video-censor folder, which Settings can move (owner 2026-10-04).
  await expect(page.locator('#media-censor-output')).toHaveValue('')
  await expect(page.locator('.media-censor-row.is-done')).toHaveCount(2)
  await expect(page.locator('.media-censor-row').first()).toContainText('Done · 7 frames censored')
  await expect(page.locator('#media-censor-stop')).toBeHidden()
  await page.locator('.media-censor-row').first().getByRole('button').click()
  await expect.poll(() => revealed.length).toBe(1)
  expect(revealed[0]).toMatch(/\/reveal\/0$/)
})

const fileRow = (status: string) => ({ name: 'anim.gif', status, frames_done: 12, frames_total: 12, censored_frames: 7, output: '', error: '' })

async function startJob(page: Page, folder: string, jobId: string): Promise<void> {
  await page.route('**/api/censor/media/start', (route) => route.fulfill({
    json: { job_id: jobId, id: jobId, status: 'queued', output_folder: folder, done: 0, total: 1, files: [fileRow('queued')] },
  }))
  await page.locator('#media-censor-folder').fill(folder)
  await page.locator('#media-censor-folder').dispatchEvent('change')
  await expect(page.locator('#media-censor-found')).toContainText('Found 1 GIF')
  await page.locator('#media-censor-start').click()
}

test('no answer for a while: the dialog says it lost contact, keeps asking, and finishes when the program answers', async ({ page }) => {
  const folder = mediaFolder()
  await openDialog(page)
  let polls = 0
  await page.route('**/api/censor/media/jobs/job2', async (route) => {
    polls += 1
    // Six polls get no answer (a busy or restarting program), then it finishes.
    if (polls <= 6) return route.abort('connectionrefused')
    return route.fulfill({ json: { id: 'job2', status: 'done', done: 1, total: 1, error: '', files: [fileRow('done')] } })
  })
  await startJob(page, folder, 'job2')
  await expect(page.locator('#media-censor-start')).toBeDisabled()
  await expect(page.locator('#toast-container')).toContainText('Lost contact with the program. Still trying', { timeout: 15000 })
  await expect(page.locator('#toast-container')).toContainText('Finished 1 of 1 file.', { timeout: 15000 })
  await expect(page.locator('#toast-container')).toContainText('In contact with the program again.')
  await expect(page.locator('#media-censor-start')).toBeEnabled()
  await expect(page.locator('#media-censor-stop')).toBeHidden()
})

test('a job the program no longer knows (it restarted) says so and the dialog can start again', async ({ page }) => {
  const folder = mediaFolder()
  await openDialog(page)
  await page.route('**/api/censor/media/jobs/job3', (route) => route.fulfill({ status: 404, json: { error: 'No such job' } }))
  await startJob(page, folder, 'job3')
  await expect(page.locator('#toast-container')).toContainText('The censoring job is no longer running (the program was restarted)')
  await expect(page.locator('#media-censor-start')).toBeEnabled()
  await expect(page.locator('#media-censor-stop')).toBeHidden()
})

/** Video support as the program reports it; `installs` counts the install requests the page made. */
async function stubVideoSupport(page: Page, options: { canInstall: boolean; installs: number[]; prepared: string[] }): Promise<void> {
  const state = () => ({
    available: options.installs.length > 0,
    source: options.installs.length > 0 ? 'installed' : null,
    can_install: options.canInstall,
    estimated_mb: 77,
    download_from: 'github.com/BtbN/FFmpeg-Builds',
    install: { state: options.installs.length > 0 ? 'done' : 'idle' },
    indexing: false, videos: 0, pending: 0, unreadable: 0,
  })
  await page.route('**/api/video-support', (route) => route.fulfill({ json: state() }))
  await page.route('**/api/video-support/install', (route) => {
    options.installs.push(Date.now())
    return route.fulfill({ json: { state: 'running', phase: 'looking', downloaded: 0, total: null } })
  })
  // once it is installed the program answers that videos can be censored
  await page.route('**/api/censor/media/status', (route) =>
    route.fulfill({ json: { video_ready: options.installs.length > 0, video_source: options.installs.length > 0 ? 'video_support' : null } }),
  )
  // the folder listing reports it the same way (this machine may well have an ffmpeg of its own)
  await page.route('**/api/censor/media/list', async (route) => {
    const real = await route.fetch()
    await route.fulfill({ response: real, json: { ...(await real.json()), video_ready: false, video_source: null } })
  })
  await page.route('**/api/models/prepare', (route) => {
    options.prepared.push(String(route.request().postData()))
    return route.fallback()
  })
}

async function stubStart(page: Page, folder: string, started: Array<Record<string, unknown>>): Promise<void> {
  await page.route('**/api/censor/media/start', (route) => {
    started.push(route.request().postDataJSON())
    return route.fulfill({ json: { job_id: 'jobv', id: 'jobv', status: 'queued', output_folder: folder, done: 0, total: 1, files: [fileRow('queued')] } })
  })
  await page.route('**/api/censor/media/jobs/jobv', (route) =>
    route.fulfill({ json: { id: 'jobv', status: 'done', done: 1, total: 1, error: '', files: [fileRow('done')] } }),
  )
}

test('videos with no ffmpeg ask for video support, one download, and go on by themselves when it is installed', async ({ page }) => {
  const folder = mediaFolder()
  const installs: number[] = []
  const prepared: string[] = []
  const started: Array<Record<string, unknown>> = []
  await openDialog(page, 'missing')
  await stubVideoSupport(page, { canInstall: true, installs, prepared })
  await stubStart(page, folder, started)
  await page.locator('#media-censor-folder').fill(folder)
  await page.locator('#media-censor-folder').dispatchEvent('change')
  await expect(page.locator('#media-censor-found')).toContainText('Found 1 GIF and 1 video.')
  await expect(page.locator('#media-censor-found')).toContainText('Videos need video support (ffmpeg)')
  await page.locator('#media-censor-start').click()
  const confirm = page.locator('#confirm-modal.visible')
  await expect(confirm).toContainText('Videos need video support (about 77 MB)')
  await expect(confirm).toContainText('also lets the gallery play and read videos')
  await page.locator('#btn-confirm-ok').click()
  await expect.poll(() => installs.length).toBe(1)
  await expect.poll(() => started.length, { timeout: 15000 }).toBe(1)
  expect(started[0]).toMatchObject({ folder, include_videos: true })
  // never a second ffmpeg from the Model Center
  expect(prepared.filter((body) => body.includes('video-ffmpeg'))).toEqual([])
})

test('declining the video support install censors the GIFs only, and says so', async ({ page }) => {
  const folder = mediaFolder()
  const installs: number[] = []
  const started: Array<Record<string, unknown>> = []
  await openDialog(page, 'missing')
  await stubVideoSupport(page, { canInstall: true, installs, prepared: [] })
  await stubStart(page, folder, started)
  await page.locator('#media-censor-folder').fill(folder)
  await page.locator('#media-censor-folder').dispatchEvent('change')
  await expect(page.locator('#media-censor-found')).toContainText('Found 1 GIF and 1 video.')
  await page.locator('#media-censor-start').click()
  await page.locator('#btn-confirm-cancel').click()
  await expect.poll(() => started.length).toBe(1)
  expect(started[0]).toMatchObject({ include_videos: false })
  expect(installs).toEqual([])
  await expect(page.locator('#toast-container')).toContainText('Video support is not installed, so only the GIFs are censored.')
})

test('a system with no ready-made ffmpeg says so and censors the GIFs only', async ({ page }) => {
  const folder = mediaFolder()
  const started: Array<Record<string, unknown>> = []
  await openDialog(page, 'missing')
  await stubVideoSupport(page, { canInstall: false, installs: [], prepared: [] })
  await stubStart(page, folder, started)
  await page.locator('#media-censor-folder').fill(folder)
  await page.locator('#media-censor-folder').dispatchEvent('change')
  await expect(page.locator('#media-censor-found')).toContainText('Found 1 GIF and 1 video.')
  await page.locator('#media-censor-start').click()
  await expect(page.locator('#toast-container')).toContainText('no ready-made ffmpeg for this system')
  await expect.poll(() => started.length).toBe(1)
  expect(started[0]).toMatchObject({ include_videos: false })
})

test('the dialog fits at every desktop size', async ({ page }) => {
  await openDialog(page)

  for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
    await page.setViewportSize(size)
    const layout = await page.evaluate(() => {
      const box = document.querySelector('#media-censor-modal .modal-content')!.getBoundingClientRect()
      const controls = ['media-censor-folder', 'media-censor-browse-source', 'media-censor-output', 'media-censor-style',
        'media-censor-every', 'media-censor-hold', 'media-censor-videos', 'media-censor-start']
      const outside = controls.filter((id) => {
        const r = document.getElementById(id)!.getBoundingClientRect()
        return r.width === 0 || r.left < box.left - 1 || r.right > box.right + 1
      })
      return {
        inViewport: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        outside,
      }
    })
    expect(layout, `at ${size.width}x${size.height}`).toEqual({ inViewport: true, pageOverflow: false, outside: [] })
  }
})
