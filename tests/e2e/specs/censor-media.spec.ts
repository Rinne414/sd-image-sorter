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

async function openDialog(page: Page): Promise<void> {
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
  await expect(page.locator('#media-censor-found')).toContainText('Found 1 GIF(s) and 1 video(s).')
  await page.locator('#media-censor-style').selectOption('blur')
  await page.locator('#media-censor-every').fill('3')
  await page.locator('#media-censor-start').click()

  await expect.poll(() => started.length).toBe(1)
  expect(started[0]).toMatchObject({
    folder, output_folder: '', include_videos: true, style: 'blur', detect_every: 3, hold: 8,
    face_guard: true, shape: 'precise', expand_percent: 0, block_size: 0,
  })
  await expect(page.locator('#media-censor-output')).toHaveValue(path.join(folder, 'censored'))
  await expect(page.locator('.media-censor-row.is-done')).toHaveCount(2)
  await expect(page.locator('.media-censor-row').first()).toContainText('Done · 7 frame(s) censored')
  await expect(page.locator('#media-censor-stop')).toBeHidden()
  await page.locator('.media-censor-row').first().getByRole('button').click()
  await expect.poll(() => revealed.length).toBe(1)
  expect(revealed[0]).toMatch(/\/reveal\/0$/)
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
