import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { pageOverflow, repoRoot, runBackendScript, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 Privacy, Chat disguise mode: a picture goes under a cover and is written
 * to a folder by the program; the same page restores it. Every file checked
 * here is a real file on disk, read by the program's own disguise reader.
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const WORK = path.join(tmpRoot, 'v4-privacy-disguise', 'work')
const OUT = path.join(WORK, 'out')
const FIXTURES = path.join(repoRoot, 'tests', 'e2e', 'fixtures', 'obfuscation')
const fixture = (name: string) => path.join(FIXTURES, name)
const COVER = fixture('no-metadata-source.png')

test.beforeAll(() => {
  fs.rmSync(path.join(tmpRoot, 'v4-privacy-disguise'), { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })
})

async function openDisguise(page: Page, lang: 'en' | 'zh-CN' = 'en', route = '/vopus/') {
  await markModelsReady(page)
  await page.addInitScript((l) => {
    // once per page and language, so reloads keep what the test set
    if (sessionStorage.getItem(`v4disguise-init-${l}`)) return
    sessionStorage.setItem(`v4disguise-init-${l}`, '1')
    localStorage.setItem('sd-image-sorter-lang', l)
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.setItem('sd-v4-update-autocheck', '0')
    localStorage.removeItem('sd-v4-privacy-options')
    localStorage.removeItem('sd-v4-privacy-disguise')
  }, lang)
  const res = await page.goto(`${route}#/tools/privacy`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('privacy-page')).toBeVisible()
  await page.getByTestId('privacy-mode-disguise').check()
}

/** The program's own reader: is this file a disguise, and how many real pictures does it hold? */
function frames(file: string): number {
  return Number(
    runBackendScript(`
import sys
sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, 'backend'))})
import disguise_apng
data = open(${JSON.stringify(file)}, "rb").read()
probe = disguise_apng.probe_disguise(data)
print(0 if probe is None else len(disguise_apng.extract_real_frames(data)))
`),
  )
}

const savedPath = async (page: Page, nth = 0) => ((await page.getByTestId('disguise-item-saved').nth(nth).innerText()).replace(/^Saved:\s*/, '')).trim()

test('the Chat disguise mode shows its cover settings, hides the scramble ones, and is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openDisguise(page)
  await expect(page.getByTestId('disguise-cover-kind')).toBeVisible()
  await expect(page.getByTestId('privacy-password')).toHaveCount(0)
  await expect(page.getByTestId('privacy-keep-info')).toHaveCount(0)
  await expect(page.getByTestId('privacy-protect-all')).toHaveCount(0)
  await page.getByTestId('intake-file').setInputFiles(fixture('sd-metadata-source.png'))
  await expect(page.getByTestId('privacy-protect-all')).toHaveText('Make disguise')
  await expect(page.getByTestId('privacy-restore-all')).toHaveText('Restore')

  // each cover kind shows its own controls
  const kind = page.getByTestId('disguise-cover-kind')
  await kind.selectOption('text')
  await expect(page.getByTestId('disguise-text-input')).toBeVisible()
  await kind.selectOption('upload')
  await expect(page.getByTestId('disguise-upload-pick')).toBeVisible()
  await kind.selectOption('default')
  await expect(page.getByTestId('disguise-default-set')).toBeVisible()
  await page.getByTestId('disguise-pack').check()
  await page.getByTestId('disguise-pack-format').selectOption('gif')
  await expect(page.getByTestId('disguise-cover-kind')).toHaveCount(0)
  await page.getByTestId('disguise-pack-format').selectOption('disguise')
  await page.getByTestId('disguise-pack').uncheck()

  await kind.selectOption('blur')
  await page.reload()
  await expect(page.getByTestId('privacy-mode-disguise')).toBeChecked()
  await expect(page.getByTestId('disguise-cover-kind')).toHaveValue('blur')
})

test('a text-card disguise is written to the chosen folder, says where, and restores to the original picture', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openDisguise(page)
  await page.getByTestId('privacy-advanced').click()
  await page.getByTestId('disguise-output-folder').fill(OUT)
  await page.getByTestId('disguise-cover-kind').selectOption('text')
  await page.getByTestId('disguise-text-input').fill('Holiday photos')

  await page.getByTestId('intake-file').setInputFiles(fixture('sd-metadata-source.png'))
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toContainText('Made 1 disguise image, saved in')
  await expect(page.getByTestId('privacy-summary')).toContainText(OUT)
  await expect(page.getByTestId('privacy-item-status')).toContainText('Disguised ·')
  const file = await savedPath(page)
  expect(path.dirname(file)).toBe(OUT)
  expect(fs.existsSync(file), file).toBe(true)
  expect(frames(file)).toBe(1)

  // the card shows the cover, and the large preview can switch to it
  await page.getByTestId('privacy-item-result').click()
  await expect(page.getByTestId('privacy-preview-result')).toHaveText('Cover')
  await page.keyboard.press('Escape')

  // a second run starts again from the original and says what it wrote (the name is taken, so it is numbered)
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toContainText('Made 1 disguise image')
  expect(await savedPath(page)).not.toBe(file)

  // restore the made file: the real picture comes back
  await page.getByTestId('privacy-clear').click()
  await page.getByTestId('intake-file').setInputFiles(file)
  await page.getByTestId('privacy-restore-all').click()
  await expect(page.getByTestId('privacy-summary')).toContainText('Restored 1/1 picture')
  await expect(page.getByTestId('privacy-item-status')).toHaveText('Restored · the real picture inside')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('privacy-item-download').click()])
  const restored = path.join(WORK, `restored-${download.suggestedFilename()}`)
  await download.saveAs(restored)
  expect(download.suggestedFilename()).toMatch(/_real\.png$/)
  const same = runBackendScript(`
from PIL import Image, ImageChops
a = Image.open(${JSON.stringify(restored)}).convert("RGBA")
b = Image.open(${JSON.stringify(fixture('sd-metadata-source.png'))}).convert("RGBA")
# the program re-encodes the picture on the way in, so allow a one-level rounding difference
print(a.size == b.size and max(hi for _, hi in ImageChops.difference(a, b).getextrema()) <= 2)
`)
  expect(same).toBe('True')
})

test('a picture that is not a disguise says so plainly and the rest still restore', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openDisguise(page)
  await page.getByTestId('intake-file').setInputFiles(fixture('sd-metadata-source.png'))
  await page.getByTestId('privacy-restore-all').click()
  await expect(page.getByTestId('privacy-summary')).toContainText('Restored 0/1 picture')
  await expect(page.getByTestId('privacy-summary')).toContainText('1 failed')
  await expect(page.getByTestId('privacy-item-status')).toHaveText('Failed: This is not a disguise image.')
})

test('no default cover and a mosaic of a plain file both wait for a cover, with the reason and a way out', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openDisguise(page)
  await page.getByTestId('intake-file').setInputFiles(fixture('sd-metadata-source.png'))
  await page.getByTestId('disguise-default-clear').click().catch(() => undefined)
  await expect(page.getByTestId('disguise-default-empty')).toBeVisible()

  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toContainText('No disguise image was made. 1 picture needs a cover.')
  await expect(page.getByTestId('privacy-item-status')).toHaveText('Needs a cover: no default cover is set')
  await expect(page.getByTestId('disguise-needs-cover-text')).toContainText('1 picture needs a cover (no default cover is set)')

  // "use the default cover" with none saved opens the picker, then goes on with the same request
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('disguise-redo-failed').click()
  await (await chooser).setFiles(COVER)
  await expect(page.getByTestId('privacy-summary')).toContainText('Made 1 disguise image')
  await expect(page.getByTestId('disguise-needs-cover')).toHaveCount(0)
  await expect(page.getByTestId('disguise-default-thumb')).toBeVisible()
  expect(fs.existsSync(await savedPath(page))).toBe(true)

  // an auto-mosaic cover only works on library pictures
  await page.getByTestId('disguise-cover-kind').selectOption('mosaic')
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-item-status')).toHaveText('Needs a cover: auto mosaic works on library images only')

  // the default cover can be removed again
  await page.getByTestId('disguise-cover-kind').selectOption('default')
  await page.getByTestId('disguise-default-clear').click()
  await expect(page.getByTestId('disguise-default-empty')).toBeVisible()
})

test('a chosen cover picture is used, and can be kept as the default', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openDisguise(page)
  await page.getByTestId('intake-file').setInputFiles(fixture('sd-metadata-source.jpg'))
  await page.getByTestId('disguise-cover-kind').selectOption('upload')
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByRole('status').filter({ hasText: 'Choose a cover picture first.' })).toBeVisible()

  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('disguise-upload-pick').click()
  await (await chooser).setFiles(COVER)
  await expect(page.getByTestId('disguise-upload-thumb')).toBeVisible()
  await page.getByTestId('disguise-upload-as-default').click()
  await expect(page.getByRole('status').filter({ hasText: 'Default cover saved' })).toBeVisible()
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toContainText('Made 1 disguise image')
  const file = await savedPath(page)
  expect(frames(file)).toBe(1)
  await page.getByTestId('disguise-cover-kind').selectOption('default')
  await expect(page.getByTestId('disguise-default-thumb')).toBeVisible()
  await page.getByTestId('disguise-default-clear').click()
})

test('packing makes one file with every picture in it, as a disguise or as a looping GIF', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openDisguise(page)
  await page.getByTestId('privacy-advanced').click()
  await page.getByTestId('disguise-output-folder').fill(OUT)
  await page.getByTestId('disguise-cover-kind').selectOption('text')
  await page.getByTestId('intake-file').setInputFiles([fixture('sd-metadata-source.png'), fixture('sd-metadata-source.jpg'), fixture('sd-metadata-source.webp')])
  await page.getByTestId('disguise-pack').check()
  await page.getByTestId('disguise-frame-seconds').fill('0.5')
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toContainText('Packed 3 pictures into one file')
  await expect(page.getByTestId('disguise-pack-info')).toContainText('3 pictures')
  await expect(page.getByTestId('privacy-item-status').first()).toHaveText('In the packed file')
  const packed = (await page.getByTestId('disguise-pack-saved').innerText()).replace(/^Saved:\s*/, '').trim()
  expect(fs.existsSync(packed), packed).toBe(true)
  expect(frames(packed)).toBe(3)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('disguise-pack-download').click()])
  expect(download.suggestedFilename()).toBe(path.basename(packed))

  await page.getByTestId('disguise-pack-format').selectOption('gif')
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toContainText('Made one looping GIF from 3 pictures')
  const gif = (await page.getByTestId('disguise-pack-saved').innerText()).replace(/^Saved:\s*/, '').trim()
  expect(gif.endsWith('.gif')).toBe(true)
  expect(fs.readFileSync(gif).subarray(0, 3).toString('latin1')).toBe('GIF')
})

test('Copy as a file and Show in folder answer in words either way', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openDisguise(page)
  await page.getByTestId('disguise-cover-kind').selectOption('text')
  await page.getByTestId('intake-file').setInputFiles(fixture('sd-metadata-source.png'))
  await expect(page.getByTestId('disguise-copy-all')).toHaveCount(0)
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toContainText('Made 1 disguise image')
  await page.getByTestId('privacy-item-copy').click()
  await expect(page.getByRole('status').filter({ hasText: /Copied as files|cannot copy files|Could not copy/ })).toBeVisible()
  await expect(page.getByTestId('disguise-copy-all')).toBeVisible()
  await expect(page.getByTestId('disguise-item-reveal')).toBeVisible()
})

test('the Chinese interface words the whole mode', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openDisguise(page, 'zh-CN')
  await expect(page.getByTestId('disguise-cover-kind')).toBeVisible()
  await expect(page.getByTestId('privacy-what')).toContainText('封面')
  await page.getByTestId('disguise-cover-kind').selectOption('text')
  await page.getByTestId('intake-file').setInputFiles(fixture('sd-metadata-source.png'))
  await expect(page.getByTestId('privacy-protect-all')).toHaveText('做成伪装图')
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toContainText('已做成 1 张伪装图')
  await expect(page.getByTestId('privacy-item-status')).toContainText('已做成伪装图')
  await page.getByTestId('privacy-restore-all').click()
  await expect(page.getByTestId('privacy-summary')).toContainText('已还原')
})

test('the page fits every desktop size in both languages, on /vopus/ and /next/', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  for (const [lang, route] of [['en', '/vopus/'], ['zh-CN', '/next/']] as const) {
    await openDisguise(page, lang, route)
    await page.getByTestId('privacy-advanced').click()
    await page.getByTestId('disguise-cover-kind').selectOption('text')
    await page.getByTestId('intake-file').setInputFiles([fixture('sd-metadata-source.png'), fixture('sd-metadata-source.jpg'), fixture('sd-metadata-source.webp')])
    await page.getByTestId('disguise-pack').check()
    await page.getByTestId('privacy-protect-all').click()
    await expect(page.getByTestId('disguise-pack-result')).toBeVisible()
    await page.getByTestId('disguise-pack').uncheck()
    await page.getByTestId('disguise-cover-kind').selectOption('default')
    await page.getByTestId('privacy-protect-all').click()
    await expect(page.getByTestId('disguise-needs-cover')).toBeVisible()
    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp)
      for (const id of ['privacy-protect-all', 'privacy-restore-all', 'privacy-clear', 'privacy-mode-disguise', 'disguise-redo-failed']) {
        await expect(page.getByTestId(id), `${id} at ${vp.width} ${lang}`).toBeInViewport()
      }
      // the settings column scrolls on its own: its controls are reachable, never cut off
      for (const id of ['disguise-cover-kind', 'disguise-pack', 'disguise-output-folder']) {
        await page.getByTestId(id).scrollIntoViewIfNeeded()
        await expect(page.getByTestId(id), `${id} at ${vp.width} ${lang}`).toBeInViewport()
      }
      expect(await pageOverflow(page), `overflow at ${vp.width} ${lang}`).toBeLessThanOrEqual(0)
    }
  }
  expect(errors).toEqual([])
})
