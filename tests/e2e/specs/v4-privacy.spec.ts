import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Locator, type Page } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, openLibrary, pageOverflow, repoRoot, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 隐私混淆 (Privacy scramble): the engine runs in a Web Worker in the page
 * and only ever DOWNLOADS; nothing is written to any library. Every file this
 * spec checks is a real download, opened by Pillow: protect then restore gives
 * back the original pixels and prompt (Big Tomato compatible, password 0512);
 * pressing Protect again starts from the original; Simple mode hides the
 * password and downloads a JPEG; three library images sent from the selection
 * come in with their count and zip into three files; a huge image is flagged,
 * never refused; a slow run cancels at once. The engine's byte-identity with
 * V3.5 and the Tomato sites is pinned by vitest (features/tools/privacy/engine).
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })
test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

const TOKEN = 'v4privacytoken'
const PREFIX = 'v4privacy-lib-'
const COUNT = 3
const DIR = 'v4-privacy'
const WORK = path.join(tmpRoot, DIR, 'work')
const FIXTURES = path.join(repoRoot, 'tests', 'e2e', 'fixtures', 'obfuscation')
const fixture = (name: string) => path.join(FIXTURES, name)
const SLOW = path.join(WORK, 'slow-3000.png')
const FAKE_HUGE = path.join(WORK, 'fake-huge.png')

// Kept in sync with the fixture generator and backend/tests/test_obfuscation_client_engine_parity.py.
const A1111_PARAMETERS = [
  'a girl standing in the rain, masterpiece, best quality',
  'Negative prompt: lowres, bad anatomy',
  'Steps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 123456789, Size: 512x768, Model: someModel',
].join('\n')

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  fs.mkdirSync(WORK, { recursive: true })
  // A 9 MP picture for a run slow enough to cancel, and a PNG whose header
  // claims 7000 x 6000 (42 MP) but carries no pixels at all.
  runBackendScript(`
import struct, zlib
from PIL import Image
Image.linear_gradient("L").resize((3000, 3000)).convert("RGB").save(${JSON.stringify(SLOW)})
def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
with open(${JSON.stringify(FAKE_HUGE)}, "wb") as f:
    f.write(b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 7000, 6000, 8, 2, 0, 0, 0)) + chunk(b"IEND", b""))
print("ok")
`)
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR])
})

interface Facts {
  format: string
  size: [number, number]
  parameters: string | null
  rgba: string
}

/** What Pillow reads from a file: format, size, the A1111 text chunk and a hash of the RGBA pixels. */
function facts(file: string): Facts {
  return JSON.parse(
    runBackendScript(`
import hashlib, json
from PIL import Image
with Image.open(${JSON.stringify(file)}) as im:
    im.load()
    print(json.dumps({"format": im.format, "size": list(im.size), "parameters": im.info.get("parameters"), "rgba": hashlib.sha256(im.convert("RGBA").tobytes()).hexdigest()}))
`),
  ) as Facts
}

async function openPrivacy(page: Page) {
  await markModelsReady(page)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('v4privacy-init')) return
    sessionStorage.setItem('v4privacy-init', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.setItem('sd-v4-update-autocheck', '0')
    localStorage.removeItem('sd-v4-privacy-options')
  })
  const res = await page.goto('/v4/#/tools/privacy', { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('privacy-page')).toBeVisible()
}

/** Click, take the download, keep it under .tmp/. */
async function download(page: Page, button: Locator): Promise<{ name: string; file: string }> {
  const [d] = await Promise.all([page.waitForEvent('download'), button.click()])
  const file = path.join(WORK, `${Date.now()}-${d.suggestedFilename()}`)
  await d.saveAs(file)
  return { name: d.suggestedFilename(), file }
}

/** A DataTransfer holding these files, built in the page. */
async function transferOf(page: Page, files: string[]) {
  const payload = files.map((f) => ({ b64: fs.readFileSync(f).toString('base64'), name: path.basename(f) }))
  return page.evaluateHandle((list) => {
    const data = new DataTransfer()
    for (const { b64, name } of list) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      data.items.add(new File([bytes], name, { type: name.endsWith('.webp') ? 'image/webp' : name.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }))
    }
    return data
  }, payload)
}

const sha = (file: string) => runBackendScript(`import hashlib; print(hashlib.sha256(open(${JSON.stringify(file)}, "rb").read()).hexdigest())`)

test('protect then restore gives back the original pixels and prompt; Protect again starts from the original', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openPrivacy(page)
  const original = facts(fixture('sd-metadata-source.png'))
  expect(original.parameters).toBe(A1111_PARAMETERS)

  await page.getByTestId('intake-file').setInputFiles(fixture('sd-metadata-source.png'))
  await expect(page.getByTestId('privacy-item')).toHaveCount(1)
  await page.getByTestId('privacy-password').fill('0512')
  await expect(page.getByTestId('privacy-password-offsite')).toHaveCount(0)
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toHaveText('Protected 1/1 image')
  await expect(page.getByTestId('privacy-item-status')).toHaveText('Protected · Standard · carries its generation details')

  const first = await download(page, page.getByTestId('privacy-item-download'))
  expect(first.name).toBe('sd-metadata-source.png')
  const scrambled = facts(first.file)
  // 0512: five passes, one extra column, two extra rows; the prompt travels encrypted
  expect(scrambled.format).toBe('PNG')
  expect(scrambled.size).toEqual([25, 26])
  expect(scrambled.rgba).not.toBe(original.rgba)
  expect(scrambled.parameters).toBeTruthy()
  expect(scrambled.parameters).not.toContain('a girl standing in the rain')

  // pressing Protect again scrambles the ORIGINAL again (V3.5 scrambled its own result twice)
  const before = await page.getByTestId('privacy-item-result').locator('img').getAttribute('src')
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-item-result').locator('img')).not.toHaveAttribute('src', before!)
  await expect(page.getByTestId('privacy-summary')).toHaveText('Protected 1/1 image')
  const again = await download(page, page.getByTestId('privacy-item-download'))
  expect(sha(again.file)).toBe(sha(first.file))

  // restore the downloaded copy with the same password
  await page.getByTestId('privacy-clear').click()
  await expect(page.getByTestId('intake-zone')).toBeVisible()
  await page.getByTestId('intake-file').setInputFiles(first.file)
  await page.getByTestId('privacy-restore-all').click()
  await expect(page.getByTestId('privacy-summary')).toHaveText('Restored 1/1 image')
  const restored = facts((await download(page, page.getByTestId('privacy-item-download'))).file)
  expect(restored.size).toEqual([24, 24])
  expect(restored.rgba).toBe(original.rgba)
  expect(restored.parameters).toBe(A1111_PARAMETERS)
})

test('Simple mode hides the password, says first that its download is a JPEG, and remembers the choice', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openPrivacy(page)
  await expect(page.getByTestId('privacy-password')).toBeVisible()
  await expect(page.getByTestId('privacy-jpeg-note')).toHaveCount(0)
  await page.getByTestId('privacy-password').fill('12a')
  await expect(page.getByTestId('privacy-password-offsite')).toBeVisible()

  await page.getByTestId('privacy-mode-simple').check()
  await expect(page.getByTestId('privacy-password')).toHaveCount(0)
  const note = page.getByTestId('privacy-jpeg-note')
  await expect(note).toBeVisible()
  await expect(note).toContainText('.jpg')
  await expect(note).toContainText('JPEG')
  // the mode is remembered, the password never is
  await page.reload()
  await expect(page.getByTestId('privacy-mode-simple')).toBeChecked()
  await page.getByTestId('privacy-mode-standard').check()
  await expect(page.getByTestId('privacy-password')).toHaveValue('')
  await page.getByTestId('privacy-mode-simple').check()

  await page.getByTestId('intake-file').setInputFiles(fixture('sd-metadata-source.jpg'))
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-item-status')).toHaveText('Protected · Simple · carries its generation details')
  const jpeg = await download(page, page.getByTestId('privacy-item-download'))
  expect(jpeg.name).toBe('sd-metadata-source.jpg')
  expect(facts(jpeg.file).format).toBe('JPEG')

  // copy stays PNG
  await page.getByTestId('privacy-item-copy').click()
  await expect(page.getByRole('status').filter({ hasText: 'Result copied (PNG)' })).toBeVisible()
  const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => item.types))
  expect(types).toContain('image/png')
})

test('three library images sent from the selection arrive with their count, and Download all zips three files', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await markModelsReady(page)
  await openLibrary(page, TOKEN, COUNT)
  await page.getByTestId('tile').first().click()
  await page.keyboard.press('Control+a')
  const bar = page.getByTestId('selection-bar')
  await expect(bar).toContainText(`${COUNT} picked`)
  await bar.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Privacy scramble' }).click()

  await expect(page).toHaveURL(/#\/tools\/privacy$/)
  await expect(page.getByRole('status').filter({ hasText: `Added ${COUNT} images from the library, not processed yet` })).toBeVisible()
  await expect(page.getByTestId('privacy-item')).toHaveCount(COUNT)
  await expect(page.getByTestId('privacy-count')).toHaveText(`${COUNT} images`)
  await expect(page.getByTestId('privacy-item').first()).toContainText('Library')

  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toHaveText(`Protected ${COUNT}/${COUNT} images`)
  const zip = await download(page, page.getByTestId('privacy-download-all'))
  expect(zip.name).toMatch(/^privacy-\d{8}-\d{6}\.zip$/)
  const listed = JSON.parse(
    runBackendScript(`
import io, json, zipfile
from PIL import Image
out = []
with zipfile.ZipFile(${JSON.stringify(zip.file)}) as z:
    assert z.testzip() is None
    for info in z.infolist():
        with Image.open(io.BytesIO(z.read(info))) as im:
            out.append([info.filename, im.format, list(im.size), bool(info.flag_bits & 0x800)])
print(json.dumps(out))
`),
  ) as [string, string, number[], boolean][]
  expect(listed.map(([name]) => name).sort()).toEqual([0, 1, 2].map((i) => `${PREFIX}0${i}.png`))
  const shapes: Record<string, number[]> = { [`${PREFIX}00.png`]: [64, 96], [`${PREFIX}01.png`]: [96, 64], [`${PREFIX}02.png`]: [80, 80] }
  for (const [name, format, size, utf8] of listed) {
    expect(format).toBe('PNG')
    expect(size).toEqual(shapes[name])
    expect(utf8).toBe(true)
  }
})

test('a huge image is flagged and never refused, a broken one says why, and a slow run cancels at once', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openPrivacy(page)
  await page.getByTestId('intake-file').setInputFiles([FAKE_HUGE, SLOW])
  const items = page.getByTestId('privacy-item')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0).getByTestId('privacy-item-huge')).toHaveText('Very large (42.0 MP): it will be slow and use a lot of memory.')
  await expect(items.nth(0).getByTestId('privacy-item-source')).toHaveText('The browser cannot show this image')
  await expect(page.getByTestId('privacy-huge-count')).toContainText('1 image is over 40 MP')
  await expect(page.getByTestId('privacy-protect-all')).toBeEnabled()

  // 99 passes over 9 MP take seconds: long enough to cancel in the middle
  await page.getByTestId('privacy-password').fill('9900')
  await page.getByTestId('privacy-protect-all').click()
  await expect(items.nth(1).getByTestId('privacy-item-status')).toHaveText('Working…')
  // the settings the run took are locked while it goes on
  await expect(page.getByTestId('privacy-password')).toBeDisabled()
  await page.getByTestId('privacy-stop').click()
  await expect(page.getByTestId('privacy-summary')).toHaveText('Cancelled after 1/2 images', { timeout: 3000 })
  await expect(items.nth(1).getByTestId('privacy-item-status')).toHaveText('Waiting')
  await expect(items.nth(1).getByTestId('privacy-item-result')).toHaveCount(0)
  await expect(items.nth(0).getByTestId('privacy-item-status')).toHaveText(/^Failed: The browser cannot read this image/)
  await expect(page.getByTestId('privacy-password')).toBeEnabled()

  // the queue still works after a cancel: remove the slow one and run the broken one again
  await items.nth(1).getByTestId('privacy-item-remove').click()
  await expect(items).toHaveCount(1)
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toHaveText('Protected 0/1 image; 1 failed, the reason is under each image')
})

test('images come in by drop and paste, a new name is used for downloads, the preview closes with Esc, a result drags out as a file', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 })
  await openPrivacy(page)
  const pageEl = '[data-testid="privacy-page"]'

  const dropped = await transferOf(page, [fixture('sd-metadata-source.png'), fixture('sd-metadata-source.webp')])
  await page.dispatchEvent(pageEl, 'dragenter', { dataTransfer: dropped })
  await expect(page.getByTestId('intake-drop-overlay')).toBeVisible()
  await page.dispatchEvent(pageEl, 'drop', { dataTransfer: dropped })
  await expect(page.getByTestId('intake-drop-overlay')).toHaveCount(0)
  await expect(page.getByTestId('privacy-item')).toHaveCount(2)

  await page.evaluate((b64) => {
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }))
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, fs.readFileSync(fixture('no-metadata-source.png')).toString('base64'))
  await expect(page.getByTestId('privacy-item')).toHaveCount(3)
  await expect(page.getByRole('status').filter({ hasText: 'Added 1 image' })).toBeVisible()

  const name = page.getByTestId('privacy-item-name').first()
  await name.fill('for-a-friend')
  await name.press('Enter')
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toHaveText('Protected 3/3 images')
  const first = page.getByTestId('privacy-item').first()
  expect((await download(page, first.getByTestId('privacy-item-download'))).name).toBe('for-a-friend.png')

  // the large preview: original or result, closed by Esc without leaving the page
  await first.getByTestId('privacy-item-result').click()
  const preview = page.getByTestId('privacy-preview')
  await expect(preview).toBeVisible()
  await expect(page.getByTestId('privacy-preview-image')).toHaveAttribute('data-showing', 'result')
  await page.getByTestId('privacy-preview-source').click()
  await expect(page.getByTestId('privacy-preview-image')).toHaveAttribute('data-showing', 'source')
  expect((await download(page, page.getByTestId('privacy-preview-download'))).name).toBe('for-a-friend.png')
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(page).toHaveURL(/#\/tools\/privacy$/)

  // dragging the result out carries the PNG as a file, and dropping it back adds nothing
  const drag = await page.evaluateHandle(() => new DataTransfer())
  await first.getByTestId('privacy-item-result').locator('img').dispatchEvent('dragstart', { dataTransfer: drag })
  const carried = await drag.evaluate((d) => ({ types: [...d.types], files: [...d.files].map((f) => [f.name, f.type]) }))
  expect(carried.files).toEqual([['for-a-friend.png', 'image/png']])
  expect(carried.types).toContain('application/x-sd-tool-result')
  await page.dispatchEvent(pageEl, 'dragenter', { dataTransfer: drag })
  await page.dispatchEvent(pageEl, 'drop', { dataTransfer: drag })
  await expect(page.getByTestId('intake-drop-overlay')).toHaveCount(0)
  await expect(page.getByTestId('privacy-item')).toHaveCount(3)
})

test('the page fits every desktop size with the queue full', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  await openPrivacy(page)
  await page.getByTestId('intake-file').setInputFiles([fixture('sd-metadata-source.png'), fixture('sd-metadata-source.jpg'), fixture('sd-metadata-source.webp')])
  await page.getByTestId('privacy-protect-all').click()
  await expect(page.getByTestId('privacy-summary')).toHaveText('Protected 3/3 images')
  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp)
    for (const id of ['privacy-protect-all', 'privacy-restore-all', 'privacy-download-all', 'privacy-clear', 'privacy-keep-info', 'privacy-mode-simple']) {
      await expect(page.getByTestId(id), `${id} at ${vp.width}`).toBeInViewport()
    }
    await expect(page.getByTestId('privacy-item-download').first()).toBeInViewport()
    expect(await pageOverflow(page), `overflow at ${vp.width}`).toBeLessThanOrEqual(0)
  }
  expect(errors).toEqual([])
})
