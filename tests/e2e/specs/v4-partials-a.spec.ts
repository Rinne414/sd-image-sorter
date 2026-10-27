import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * Seven finished V Opus features (docs/feature-entrances.json, partials A), each
 * driven like a user on the real backend, in both languages where words matter:
 *  1. colour analysis: Pause / Resume and Hide while it runs (rail row, Jobs drawer)
 *  2. the unreadable files row: Hide for now, back when the number changes (V Opus and /next/)
 *  3. Settings > Library > Repair prompts and text (recover text, read ComfyUI prompts again)
 *  4. an empty censor step opens the Library in add-to-this-batch mode
 *  5. Home tool cards
 *  6. sort sound and focus mode in Settings
 *  7. /next/: More > Dataset maker starts a V Opus dataset batch; the sort preview switch
 *
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const SERVER = `http://127.0.0.1:${process.env.PW_WEB_SERVER_PORT || process.env.SD_IMAGE_SORTER_PORT || '19087'}`
const PREFIX = 'v4pa-'
const TOKEN = 'v4patoken'
const DIR = 'v4-pa'
const COLOR_PREFIX = 'v4pc-'
const COLOR_TOKEN = 'v4pctoken'
const COLOR_DIR = 'v4-pc'
const COLOR_COUNT = 6000
const COUNT = 8

let library = ''
let colorLibrary = ''

function makeLibrary(name: string): string {
  return runBackendScript(`
import json, urllib.request
req = urllib.request.Request(${JSON.stringify(SERVER)} + "/api/libraries",
    data=json.dumps({"name": ${JSON.stringify(name)}}).encode(),
    headers={"Content-Type": "application/json"}, method="POST")
print(json.loads(urllib.request.urlopen(req, timeout=15).read())["library"]["id"])
`)
}

function dropLibrary(id: string): void {
  runBackendScript(`
import urllib.parse, urllib.request
req = urllib.request.Request(${JSON.stringify(SERVER)} + "/api/libraries/" + urllib.parse.quote(${JSON.stringify(id)}), method="DELETE")
urllib.request.urlopen(req, timeout=15).read()
print("ok")
`)
}

/** Files gone from disk and flagged unreadable; a throwaway row removed through the API makes the server drop its cached report. */
function loseFiles(names: string[]): void {
  for (const name of names) fs.rmSync(path.join(tmpRoot, DIR, name), { force: true })
  runBackendScript(`
import json, sqlite3, urllib.request
names = ${JSON.stringify(names)}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    for n in names:
        conn.execute("UPDATE images SET is_readable = 0, metadata_status = 'error', read_error = 'File not found' WHERE filename = ?", (n,))
    cur = conn.execute("INSERT INTO images (path, filename, is_readable, metadata_status) VALUES ('x', ?, 1, 'complete')", (${JSON.stringify(PREFIX)} + "sentinel.png",))
    sentinel = cur.lastrowid
    conn.commit()
req = urllib.request.Request(${JSON.stringify(SERVER)} + "/api/images/remove-selected",
    data=json.dumps({"image_ids": [sentinel], "background": False}).encode(),
    headers={"Content-Type": "application/json", "X-SD-Library-Id": "main"}, method="POST")
urllib.request.urlopen(req, timeout=15).read()
print("ok")
`)
}

test.beforeAll(() => {
  library = makeLibrary('v4 partials a')
  colorLibrary = makeLibrary('v4 partials a colours')
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR, library })
  seedImages({ prefix: COLOR_PREFIX, token: COLOR_TOKEN, count: COLOR_COUNT, dir: COLOR_DIR, library: colorLibrary })
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR])
  cleanupImages(COLOR_PREFIX, [COLOR_DIR])
  dropLibrary(library)
  dropLibrary(colorLibrary)
})

test.beforeEach(async ({ page }) => markModelsReady(page))

type Lang = 'en' | 'zh-CN'

async function openAt(page: Page, app: 'vopus' | 'next', hash: string, options: { lang?: Lang; library?: string; startPage?: string } = {}) {
  const { lang = 'en', library: lib = library, startPage = 'library' } = options
  await page.addInitScript(
    ([language, id, start]) => {
      const flag = 'v4pa-init'
      if (sessionStorage.getItem(flag)) return
      sessionStorage.setItem(flag, '1')
      localStorage.setItem('sd-image-sorter-lang', language!)
      localStorage.setItem('sd-v4-theme', 'dark')
      localStorage.setItem('sd-v4-update-autocheck', '0')
      localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: id }))
      const prefs = JSON.parse(localStorage.getItem('sd-v4-prefs') || '{}')
      localStorage.setItem('sd-v4-prefs', JSON.stringify({ ...prefs, startPage: start }))
    },
    [lang, lib, startPage],
  )
  const res = await page.goto(`/${app}/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

async function setLang(page: Page, lang: Lang) {
  await page.evaluate((l) => localStorage.setItem('sd-image-sorter-lang', l), lang)
  await page.reload({ waitUntil: 'domcontentloaded' })
}

const colorProgress = (page: Page) =>
  page.evaluate(async () => (await (await fetch('/api/colors/progress')).json()) as { running: boolean; paused: boolean; completed: number; failed: number; total: number })

// ---- 1. colour analysis ------------------------------------------------------------

test('colour analysis can be paused, resumed and hidden while it runs, and stopped for good', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, 'vopus', '#/library', { library: colorLibrary })
  const row = page.getByTestId('status-row-colors')
  await expect(row).toContainText('without colour analysis yet', { timeout: 30_000 })
  await page.getByTestId('colors-analyse').click()

  // Running: the row counts, and offers Pause and Hide.
  await expect(row).toContainText(/Analysing colours: [\d,]+ of 6,000/)
  await expect(page.getByTestId('colors-hide')).toBeVisible()
  await page.getByTestId('colors-pause').click()
  await expect(row).toContainText('Colour analysis paused')
  await expect(page.getByTestId('colors-pause')).toHaveText('Resume')
  await expect.poll(async () => (await colorProgress(page)).paused).toBe(true)

  // Paused means no more images are done.
  await page.waitForTimeout(800)
  const held = (await colorProgress(page)).completed
  await page.waitForTimeout(1500)
  expect((await colorProgress(page)).completed).toBe(held)

  // The Jobs drawer shows the same pause and offers Resume too.
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer').getByTestId('job-pause')).toHaveText('Resume')
  await page.keyboard.press('Escape')

  await page.getByTestId('colors-pause').click()
  await expect(page.getByTestId('colors-pause')).toHaveText('Pause')
  await expect.poll(async () => (await colorProgress(page)).completed, { timeout: 20_000 }).toBeGreaterThan(held)
  expect((await colorProgress(page)).paused).toBe(false)

  // Hide takes the line away; the run goes on and the Jobs button follows it.
  await page.getByTestId('colors-hide').click()
  await expect(row).toHaveCount(0)
  await expect(page.getByTestId('jobs-button')).toBeVisible()
  expect((await colorProgress(page)).running).toBe(true)

  // Stop keeps what was analysed and does not start another round.
  await page.getByTestId('jobs-button').click()
  await page.getByTestId('jobs-drawer').getByRole('button', { name: 'Stop' }).click()
  await expect.poll(async () => (await colorProgress(page)).running, { timeout: 30_000 }).toBe(false)
  await expect(page.getByTestId('jobs-drawer').getByTestId('job').first()).toContainText('Stopped', { timeout: 15_000 })
  await page.waitForTimeout(2500)
  expect((await colorProgress(page)).running).toBe(false)
  await page.keyboard.press('Escape')
  // The line comes back for the images still without colours, as a chore to start.
  await expect(row).toContainText('without colour analysis yet')
  await expect(page.getByTestId('colors-analyse')).toBeVisible()
})

test('the colour pause words are right in Chinese', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, 'vopus', '#/library', { lang: 'zh-CN', library: colorLibrary })
  const row = page.getByTestId('status-row-colors')
  await expect(row).toContainText('还没做色彩分析', { timeout: 30_000 })
  await page.getByTestId('colors-analyse').click()
  await expect(row).toContainText('正在分析色彩')
  await page.getByTestId('colors-pause').click()
  await expect(row).toContainText('色彩分析已暂停')
  await expect(page.getByTestId('colors-pause')).toHaveText('继续')
  await expect(page.getByTestId('colors-hide')).toHaveText('隐藏')
  await page.getByTestId('jobs-button').click()
  await page.getByTestId('jobs-drawer').getByRole('button', { name: '停止' }).click()
  await expect.poll(async () => (await colorProgress(page)).running, { timeout: 30_000 }).toBe(false)
})

test('the same colour line on /next/ pauses and hides', async ({ page }) => {
  test.setTimeout(120_000)
  // The footer shows one line on a laptop screen: a run in progress takes it, so its Pause is always in reach.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, 'next', '#/library', { library: colorLibrary })
  const footer = page.getByTestId('next-footer')
  await expect(footer.getByTestId('colors-analyse')).toBeVisible({ timeout: 30_000 })
  await footer.getByTestId('colors-analyse').click()
  await page.setViewportSize({ width: 1366, height: 768 })
  await expect(footer.getByTestId('status-row-colors')).toContainText('Analysing colours')
  await footer.getByTestId('colors-pause').click()
  await expect(footer.getByTestId('status-row-colors')).toContainText('paused')
  await footer.getByTestId('colors-pause').click()
  await footer.getByTestId('colors-hide').click()
  await expect(footer.getByTestId('status-row-colors')).toHaveCount(0)
  await page.getByTestId('jobs-button').click()
  await page.getByTestId('jobs-drawer').getByRole('button', { name: 'Stop' }).click()
  await expect.poll(async () => (await colorProgress(page)).running, { timeout: 30_000 }).toBe(false)
})

// ---- 2. unreadable files line ------------------------------------------------------

test('the unreadable files line hides for now and comes back when the number changes', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  loseFiles([`${PREFIX}03.png`])
  await openAt(page, 'vopus', '#/library')
  const row = page.getByTestId('status-row-missing')
  await expect(row).toContainText('1 file not found', { timeout: 20_000 })
  await page.getByTestId('status-hide-unreadable').click()
  await expect(row).toHaveCount(0)
  await expect(page.getByText('Hidden. It comes back if the number of unreadable files changes')).toBeVisible()

  // Still hidden after a reload in the same session: the number is the same.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('library-status')).toBeVisible()
  await expect(page.getByTestId('library-status')).not.toContainText('not found', { timeout: 10_000 })
  // The library report still lists the file.
  await page.getByTestId('status-report-open').click()
  await expect(page.getByTestId('library-report')).toContainText(`${PREFIX}03.png`)
  await page.keyboard.press('Escape')

  // A second file lost changes the number: the line is back, with the new count.
  loseFiles([`${PREFIX}04.png`])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('status-row-missing')).toContainText('2 files not found', { timeout: 20_000 })

  // Words in Chinese.
  await setLang(page, 'zh-CN')
  await expect(page.getByTestId('status-hide-unreadable')).toHaveText('暂时隐藏')
})

test('/next/ hides the same line in its footer', async ({ page }) => {
  // (a laptop-width footer keeps the first line only; the full report lists the rest)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, 'next', '#/library')
  // This session already hid nothing for this number (a new page has fresh session storage).
  const footer = page.getByTestId('next-footer')
  const row = footer.getByTestId('status-row-missing')
  await expect(row).toContainText('2 files not found', { timeout: 20_000 })
  await footer.getByTestId('status-hide-unreadable').click()
  await expect(row).toHaveCount(0)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(footer).toBeVisible()
  await expect(footer.getByTestId('status-row-missing')).toHaveCount(0)
})

// ---- 3. metadata repair in Settings ------------------------------------------------

test('Settings > Library repairs prompts and text as jobs with an honest result', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  // One image without any text, one ComfyUI image whose file carries no workflow.
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("UPDATE images SET prompt = NULL, sidecar_caption = NULL WHERE filename = ?", (${JSON.stringify(PREFIX)} + "01.png",))
    conn.execute("UPDATE images SET generator = 'comfyui' WHERE filename = ?", (${JSON.stringify(PREFIX)} + "02.png",))
    conn.commit()
print("ok")
`)
  await openAt(page, 'vopus', '#/settings/library')
  const section = page.getByTestId('libset-repair')
  await expect(section).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('repair-recover-count')).toContainText('1 image has no text yet')
  await expect(page.getByTestId('repair-comfy-count')).toContainText('ComfyUI images in this library: 1')

  await page.getByTestId('repair-comfy-start').click()
  await expect(page.getByTestId('repair-comfy-result')).toContainText('Last run', { timeout: 30_000 })
  await expect(page.getByTestId('repair-comfy-result')).toContainText('left as they were because the file no longer gives a prompt')
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer').getByTestId('job').first()).toContainText('Read again: 0 prompts changed')
  await page.keyboard.press('Escape')

  await page.getByTestId('repair-recover-start').click()
  await expect(page.getByTestId('repair-recover-result')).toContainText('Recovered 0 prompts and 0 captions', { timeout: 30_000 })
  await expect(page.getByTestId('repair-recover-result')).toContainText('still has no text')

  await setLang(page, 'zh-CN')
  await expect(page.getByTestId('libset-repair')).toContainText('修复提示词与文字')
  await expect(page.getByTestId('repair-recover-count')).toContainText('张图片没有文字')
  await expect(page.getByTestId('repair-recover-start')).toHaveText('开始')

  // The same section on /next/.
  await openNext(page, '#/settings/library')
  await expect(page.getByTestId('libset-repair')).toBeVisible()
})

async function openNext(page: Page, hash: string) {
  await page.goto(`/next/${hash}`, { waitUntil: 'domcontentloaded' })
}

// ---- 4. empty censor step ----------------------------------------------------------

test('an empty censor step opens the Library in add-to-this-batch mode', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, 'vopus', '#/library')
  const headers = { 'X-SD-Library-Id': library }
  const created = await page.request.post('/api/batches', { headers, data: { kind: 'pixiv', name: 'v4pa empty censor', image_ids: [] } })
  expect(created.ok(), await created.text()).toBe(true)
  const batch = (await created.json()).batch as { id: number; revision: number }
  const patched = await page.request.patch(`/api/batches/${batch.id}`, { headers, data: { revision: batch.revision, current_step: 'censor' } })
  expect(patched.ok(), await patched.text()).toBe(true)
  try {
    await page.evaluate((id) => (location.hash = `#/batch/${id}`), batch.id)
    const empty = page.getByTestId('censor-empty')
    await expect(empty).toContainText('This batch has no images yet')
    await expect(page.getByTestId('censor-empty-open-library')).toHaveText('Add images from the Library')
    await page.getByTestId('censor-empty-open-library').click()
    await expect(page).toHaveURL(/#\/library/)
    // The library is now in add-to-this-batch mode: its banner names the batch.
    await expect(page.getByTestId('adding-banner')).toBeVisible()
    await page.goBack()

    await setLang(page, 'zh-CN')
    await expect(page.getByTestId('censor-empty-open-library')).toHaveText('从图库添加图片')
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport)
      await expect(page.getByTestId('censor-empty-open-library')).toBeInViewport()
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    }
  } finally {
    await page.request.delete(`/api/batches/${batch.id}`, { headers })
  }
})

// ---- 5. Home tool cards ------------------------------------------------------------

for (const viewport of VIEWPORTS) {
  test(`Home tool cards fit at ${viewport.width}x${viewport.height} in both languages`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openAt(page, 'vopus', '#/home', { startPage: 'home' })
    for (const [lang, reader] of [['en', 'Reader'], ['zh-CN', '读图']] as const) {
      if (lang !== 'en') await setLang(page, lang)
      const tools = page.getByTestId('home-tools')
      await tools.scrollIntoViewIfNeeded()
      await expect(tools).toBeVisible()
      await expect(page.getByTestId('home-tool-reader')).toContainText(reader)
      const boxes: { x: number; y: number; width: number; height: number }[] = []
      for (const id of ['reader', 'privacy', 'similar', 'duplicates', 'models', 'all']) {
        const card = page.getByTestId(`home-tool-${id}`)
        await expect(card).toBeVisible()
        // nothing clipped inside a card
        expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true)
        const box = await card.boundingBox()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
        boxes.push(box!)
      }
      // cards never overlap
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!
          const b = boxes[j]!
          const apart = a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1
          expect(apart, `cards ${i} and ${j} overlap`).toBe(true)
        }
      }
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    }
  })
}

test('each Home tool card opens what it names', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, 'vopus', '#/home', { startPage: 'home' })
  await page.getByTestId('home-tool-reader').click()
  await expect(page).toHaveURL(/#\/tools\/reader/)
  await page.goBack()
  await page.getByTestId('home-tool-privacy').click()
  await expect(page).toHaveURL(/#\/tools\/privacy/)
  await page.goBack()
  await page.getByTestId('home-tool-models').click()
  await expect(page).toHaveURL(/#\/settings\/models/)
  await page.goBack()
  await page.getByTestId('home-tool-duplicates').click()
  await expect(page.getByTestId('duplicates-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId('home-tool-all').click()
  await expect(page.getByTestId('palette')).toBeVisible()
  await page.keyboard.press('Escape')
  // Find similar asks for a picture, over the library
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('home-tool-similar').click()
  await chooser
  await expect(page).toHaveURL(/#\/library/)
  // the same cards on /next/
  await openNext(page, '#/home')
  await expect(page.getByTestId('home-tool-reader')).toBeVisible()
})

// ---- 6. sort sound and focus mode in Settings --------------------------------------

test('sort sound and focus mode are set in Settings and on the Sort page, one stored value', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, 'vopus', '#/settings/appearance')
  const sound = page.getByTestId('setting-sound')
  const focus = page.getByTestId('setting-focus')
  await expect(sound).toContainText('Sound while sorting')
  await expect(sound.getByRole('radio', { name: 'Off' })).toBeChecked()
  await sound.locator('label', { hasText: /^On$/ }).click()
  await focus.locator('label', { hasText: /^On$/ }).click()
  expect(await page.evaluate(() => localStorage.getItem('sort-audio-enabled'))).toBe('true')
  expect(await page.evaluate(() => localStorage.getItem('manual_sort_zen_v1'))).toBe('1')

  await page.evaluate(() => (location.hash = '#/sort'))
  await expect(page.getByTestId('sort-sound-option')).toBeChecked()
  await expect(page.getByTestId('sort-focus-option')).toBeChecked()
  // and the other way round
  await page.getByTestId('sort-sound-option').uncheck()
  await page.getByTestId('sort-focus-option').uncheck()
  await page.evaluate(() => (location.hash = '#/settings/appearance'))
  await expect(page.getByTestId('setting-sound').getByRole('radio', { name: 'Off' })).toBeChecked()
  await expect(page.getByTestId('setting-focus').getByRole('radio', { name: 'Off' })).toBeChecked()

  await setLang(page, 'zh-CN')
  await expect(page.getByTestId('setting-sound')).toContainText('分拣时的声音')
  await expect(page.getByTestId('setting-focus')).toContainText('分拣时的专注模式')
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    await page.getByTestId('setting-focus').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('setting-focus')).toBeInViewport()
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  }
  // /next/ has them too
  await openNext(page, '#/settings/appearance')
  await expect(page.getByTestId('setting-sound')).toBeVisible()
})

// ---- 7. /next/ only: Dataset maker in More, sort preview switch --------------------

test('/next/ More > Dataset maker starts a V Opus dataset batch, not the classic interface', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, 'next', '#/library')
  await page.getByTestId('next-more').click()
  const item = page.locator('[data-item="dataset"]')
  await expect(item).toHaveText('Dataset maker')
  await item.click()
  await expect(page).toHaveURL(/\/next\/#\/library/)
  await expect(page.getByTestId('adding-banner')).toBeVisible()
})

for (const app of ['next', 'vopus'] as const) {
  test(`the sort preview has an automatic switch on /${app}/`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await openAt(page, app, '#/sort')
    await page.getByTestId('sort-mode-rules').click()
    await page.getByTestId('sort-rule-by-condition').check()
    await page.getByTestId('sort-condition-input').fill(TOKEN)
    const preview = page.getByTestId('sort-rule-preview')
    await expect(preview.locator('img').first()).toBeVisible({ timeout: 20_000 })
    const toggle = page.getByTestId('sort-auto-preview')
    await expect(toggle).toBeChecked()
    await toggle.uncheck()
    // a changed rule waits for Show preview
    await page.getByTestId('sort-condition-input').fill('smile')
    await expect(page.getByTestId('sort-show-preview')).toBeVisible()
    await expect(preview.locator('img')).toHaveCount(0)
    await page.getByTestId('sort-show-preview').click()
    await expect(preview.locator('img').first()).toBeVisible({ timeout: 20_000 })
    expect(await page.evaluate(() => localStorage.getItem('sd-v4-sort-auto-preview'))).toBe('0')
    await toggle.check()
    await expect(page.getByTestId('sort-show-preview')).toHaveCount(0)
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  })
}

// ---- fits: Settings > Library with the repair section ------------------------------

for (const viewport of VIEWPORTS) {
  test(`Settings > Library repair section fits at ${viewport.width}x${viewport.height} in both languages`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openAt(page, 'vopus', '#/settings/library')
    for (const lang of ['en', 'zh-CN'] as const) {
      if (lang !== 'en') await setLang(page, lang)
      const section = page.getByTestId('libset-repair')
      await section.scrollIntoViewIfNeeded()
      await expect(section).toBeVisible()
      for (const id of ['repair-recover-start', 'repair-comfy-start']) await expect(page.getByTestId(id)).toBeInViewport()
      expect(await section.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    }
  })
}
