import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/click-ledger'
import { resizeAndSettleUiScale } from '../fixtures/ui-scale'

/**
 * Chat disguise mode of the Privacy Tools page (owner request 2026-09-28).
 *
 * The chat list shows the cover of a disguise; opening it plays the real
 * picture. It is a third mode of the obfuscation page, not a new page, and a
 * made disguise is copied as a FILE (a copied bitmap would lose the hidden
 * frames). Pictures whose automatic cover cannot be made are marked, and the
 * default cover replaces them in one click.
 */

test.describe.configure({ mode: 'serial' })

const REFERENCE_DISGUISE = path.resolve(__dirname, '../../../backend/tests/fixtures/disguise/reference_tool_single.png')
const DESKTOP_SIZES = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]

async function openPrivacyTools(page: Page, lang = 'en'): Promise<string[]> {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  await page.addInitScript((language) => localStorage.setItem('sd-image-sorter-lang', language), lang)
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1'
    && Boolean((window as any).ImageObfuscator && (window as any).ImageDisguise))
  await page.evaluate(() => {
    ;(window as any).EntryPage?.hide?.()
    document.getElementById('nav-tab-reader')?.click()
  })
  await page.locator('#reader-tool-tab-obfuscation').click()
  await expect(page.locator('#reader-tool-panel-obfuscation')).toHaveClass(/active/)
  return consoleErrors
}

async function pngBytes(page: Page, color: string, width = 96, height = 64): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ color, width, height }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = color
    ctx.fillRect(0, 0, width, height)
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
    return btoa(binary)
  }, { color, width, height })
  return Buffer.from(base64, 'base64')
}

async function addPictures(page: Page, pictures: Array<{ name: string, buffer: Buffer }>): Promise<void> {
  await page.setInputFiles('#obfuscate-file-input', pictures.map((picture) => ({
    name: picture.name,
    mimeType: 'image/png',
    buffer: picture.buffer,
  })))
  await expect(page.locator('#obfuscate-queue .obfuscate-item')).toHaveCount(pictures.length)
}

async function chooseDisguiseMode(page: Page, coverKind: string): Promise<void> {
  await page.locator('#obfuscate-compat-mode').selectOption('chat_disguise')
  await page.locator('#disguise-cover-kind').selectOption(coverKind)
}

/** Chunk types of the first queue result, in file order. */
async function resultChunkTypes(page: Page, index = 0): Promise<string[]> {
  return page.evaluate(async (itemIndex) => {
    const blob: Blob = (window as any).ImageObfuscator._queue[itemIndex].resultBlob
    const view = new DataView(await blob.arrayBuffer())
    const types: string[] = []
    let offset = 8
    while (offset + 8 <= view.byteLength) {
      const length = view.getUint32(offset)
      types.push(String.fromCharCode(
        view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7),
      ))
      offset += 12 + length
    }
    return types
  }, index)
}

test('the chat disguise is a mode of the privacy page, not another page', async ({ page }) => {
  await openPrivacyTools(page)

  await page.locator('#obfuscate-settings-toggle').click()
  await expect(page.locator('#obfuscate-metadata-row')).toBeVisible()

  await page.locator('#obfuscate-compat-mode').selectOption('chat_disguise')

  await expect(page.locator('#disguise-settings')).toBeVisible()
  await expect(page.locator('#obfuscate-password')).toBeHidden()
  await expect(page.locator('#obfuscate-metadata-row')).toBeHidden()
  await expect(page.locator('#obfuscate-legacy-row')).toBeHidden()
  await expect(page.locator('#disguise-scrub')).toBeVisible()
  const modeSelect = page.locator('#obfuscate-compat-mode')
  expect(await modeSelect.evaluate((select: HTMLSelectElement) => {
    const probe = document.createElement('span')
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(select).font}`
    probe.textContent = select.selectedOptions[0].textContent
    document.body.appendChild(probe)
    const fits = probe.getBoundingClientRect().width <= select.clientWidth - 24
    probe.remove()
    return fits
  }), 'the selected mode name is not cut off').toBe(true)
  await expect(page.locator('#obfuscate-btn-encode')).toContainText('Make disguise')
  await expect(page.locator('#obfuscate-compat-help')).toContainText('chat list shows the cover')

  await page.locator('#obfuscate-compat-mode').selectOption('big_tomato')

  await expect(page.locator('#disguise-settings')).toBeHidden()
  await expect(page.locator('#obfuscate-password')).toBeVisible()
  await expect(page.locator('#obfuscate-metadata-row')).toBeVisible()
  await expect(page.locator('#disguise-scrub')).toBeHidden()
  await expect(page.locator('#obfuscate-btn-encode')).toContainText('Protect')
})

test('a dropped picture becomes a disguise that shows the cover and plays the real picture', async ({ page }) => {
  const consoleErrors = await openPrivacyTools(page)
  await addPictures(page, [{ name: 'mine.png', buffer: await pngBytes(page, '#c83030') }])
  await chooseDisguiseMode(page, 'text')

  await page.locator('#obfuscate-btn-encode').click()

  const item = page.locator('#obfuscate-queue .obfuscate-item').first()
  await expect(item).toHaveClass(/done/)
  await expect(item.locator('.obfuscate-item-status')).toContainText('Disguised · 96×64')
  await expect(item.locator('.result-thumb')).toHaveAttribute('src', /^data:image\/png;base64,/)
  const chunks = await resultChunkTypes(page)
  expect(chunks.indexOf('acTL')).toBeGreaterThan(-1)
  expect(chunks.indexOf('acTL')).toBeLessThan(chunks.indexOf('IDAT'))
  expect(chunks.indexOf('fcTL')).toBeGreaterThan(chunks.indexOf('IDAT'))
  expect(consoleErrors).toEqual([])
})

test('copy sends the made file itself, not a picture of it', async ({ page }) => {
  await openPrivacyTools(page)
  await addPictures(page, [{ name: 'copy-me.png', buffer: await pngBytes(page, '#3060c8') }])
  await chooseDisguiseMode(page, 'blur')
  await page.locator('#obfuscate-btn-encode').click()
  await expect(page.locator('#obfuscate-queue .obfuscate-item').first()).toHaveClass(/done/)
  const copied: string[][] = []
  await page.route('**/api/disguise/copy', async (route) => {
    copied.push(route.request().postDataJSON().tokens)
    await route.fulfill({ status: 200, json: { status: 'ok', copied: 1 } })
  })

  await page.locator('#obfuscate-queue .obfuscate-copy').first().click()

  const token = await page.evaluate(() => (window as any).ImageObfuscator._queue[0].disguise.token)
  await expect.poll(() => copied).toEqual([[token]])
  await expect(page.locator('#disguise-btn-copy-all')).toBeVisible()
})

test('a picture with no automatic cover is marked and the default cover fixes it in one click', async ({ page, request }) => {
  await openPrivacyTools(page)
  const saved = await request.put('/api/disguise/default-cover', {
    multipart: { file: { name: 'cover.png', mimeType: 'image/png', buffer: await pngBytes(page, '#202020', 40, 40) } },
  })
  expect(saved.ok()).toBe(true)
  await page.evaluate(() => { (window as any).ensureFeatureModel = async () => ({ ok: true }) })
  await addPictures(page, [{ name: 'dropped.png', buffer: await pngBytes(page, '#c8c830') }])
  await chooseDisguiseMode(page, 'mosaic')

  await page.locator('#obfuscate-btn-encode').click()

  const item = page.locator('#obfuscate-queue .obfuscate-item').first()
  await expect(item).toHaveClass(/needs_cover/)
  await expect(item.locator('.obfuscate-item-status')).toContainText('library images only')
  await expect(page.locator('#disguise-needs-cover-bar')).toBeVisible()

  await page.locator('#disguise-redo-failed').click()

  await expect(item).toHaveClass(/done/)
  await expect(page.locator('#disguise-needs-cover-bar')).toBeHidden()
  await request.delete('/api/disguise/default-cover')
})

test('pack mode turns the whole queue into one disguise', async ({ page }) => {
  await openPrivacyTools(page)
  await addPictures(page, [
    { name: 'one.png', buffer: await pngBytes(page, '#c83030') },
    { name: 'two.png', buffer: await pngBytes(page, '#30c830', 64, 96) },
  ])
  await chooseDisguiseMode(page, 'blur')
  await page.locator('#disguise-pack').check()

  await page.locator('#obfuscate-btn-encode').click()

  await expect(page.locator('#disguise-pack-result')).toBeVisible()
  await expect(page.locator('#disguise-pack-info')).toContainText('2 pictures')
  await expect(page.locator('#obfuscate-queue .obfuscate-item.packed')).toHaveCount(2)
})

test('restore gives back the real picture of a disguise someone sent', async ({ page }) => {
  await openPrivacyTools(page)
  await addPictures(page, [{ name: 'from_qq.png', buffer: fs.readFileSync(REFERENCE_DISGUISE) }])
  await page.locator('#obfuscate-compat-mode').selectOption('chat_disguise')

  await page.locator('#obfuscate-btn-decode').click()

  await expect(page.locator('#obfuscate-queue .obfuscate-item').first()).toHaveClass(/done/)
  const chunks = await resultChunkTypes(page)
  expect(chunks).not.toContain('acTL')
  const name = await page.evaluate(() => (window as any).ImageObfuscator._queue[0].resultName)
  expect(name).toBe('from_qq_real.png')
})

for (const lang of ['en', 'zh-CN']) {
  test(`the disguise controls fit at every desktop size (${lang})`, async ({ page }, testInfo) => {
  const consoleErrors = await openPrivacyTools(page, lang)
  await addPictures(page, [
    { name: 'layout-one.png', buffer: await pngBytes(page, '#c83030') },
    { name: 'layout-two.png', buffer: await pngBytes(page, '#3060c8') },
  ])
  await chooseDisguiseMode(page, 'text')
  await page.locator('#obfuscate-settings-toggle').click()
  await page.locator('#obfuscate-btn-encode').click()
  await expect(page.locator('#obfuscate-queue .obfuscate-item.done')).toHaveCount(2)

  for (const size of DESKTOP_SIZES) {
    await resizeAndSettleUiScale(page, size)
    const layout = await page.evaluate(() => {
      const panel = document.getElementById('reader-tool-panel-obfuscation')!.getBoundingClientRect()
      const controls = [
        'obfuscate-compat-mode', 'disguise-cover-kind', 'disguise-text-input', 'disguise-text-bg', 'disguise-text-fg',
        'disguise-pack', 'disguise-frame-seconds', 'disguise-scrub', 'disguise-max-side', 'disguise-output-folder',
        'obfuscate-btn-encode', 'obfuscate-btn-decode', 'disguise-btn-copy-all',
      ]
      const outside = controls.filter((id) => {
        const box = document.getElementById(id)!.getBoundingClientRect()
        return box.width === 0 || box.left < panel.left - 1 || box.right > panel.right + 1
      })
      return {
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        panelOverflow: document.getElementById('reader-tool-panel-obfuscation')!.scrollWidth
          > document.getElementById('reader-tool-panel-obfuscation')!.clientWidth,
        outside,
      }
    })
    expect(layout, `layout at ${size.width}x${size.height}`).toEqual({ pageOverflow: false, panelOverflow: false, outside: [] })
    await page.screenshot({ path: testInfo.outputPath(`chat-disguise-${lang}-${size.width}x${size.height}.png`), fullPage: false })
  }
  expect(consoleErrors).toEqual([])
})
}

test('a chosen cover picture is used and can become the default cover', async ({ page, request }) => {
  await openPrivacyTools(page)
  await request.delete('/api/disguise/default-cover')
  await addPictures(page, [{ name: 'real.png', buffer: await pngBytes(page, '#c83030') }])
  await chooseDisguiseMode(page, 'upload')
  const cover = await pngBytes(page, '#101010', 48, 48)

  const chooser = page.waitForEvent('filechooser')
  await page.locator('#disguise-upload-pick').click()
  await (await chooser).setFiles({ name: 'my-cover.png', mimeType: 'image/png', buffer: cover })
  await expect(page.locator('#disguise-upload-thumb')).toBeVisible()
  await page.locator('#obfuscate-btn-encode').click()
  await expect(page.locator('#obfuscate-queue .obfuscate-item').first()).toHaveClass(/done/)

  await page.locator('#disguise-upload-as-default').click()
  await page.locator('#disguise-cover-kind').selectOption('default')

  await expect(page.locator('#disguise-default-thumb')).toBeVisible()
  await expect(page.locator('#disguise-default-empty')).toBeHidden()
  await page.locator('#disguise-default-clear').click()
  await expect(page.locator('#disguise-default-empty')).toBeVisible()
})

test('copy-all and the pack card copy, download and show the made files', async ({ page }) => {
  await openPrivacyTools(page)
  const copied: string[][] = []
  const revealed: string[] = []
  await page.route('**/api/disguise/copy', async (route) => {
    copied.push(route.request().postDataJSON().tokens)
    await route.fulfill({ status: 200, json: { status: 'ok', copied: 1 } })
  })
  await page.route('**/api/disguise/reveal', async (route) => {
    revealed.push(route.request().postDataJSON().token)
    await route.fulfill({ status: 200, json: { status: 'ok' } })
  })
  await addPictures(page, [
    { name: 'a.png', buffer: await pngBytes(page, '#c83030') },
    { name: 'b.png', buffer: await pngBytes(page, '#30c830') },
  ])
  await chooseDisguiseMode(page, 'blur')
  await page.locator('#obfuscate-btn-encode').click()
  await expect(page.locator('#obfuscate-queue .obfuscate-item.done')).toHaveCount(2)

  await page.locator('#disguise-btn-copy-all').click()
  await expect.poll(() => copied.length).toBe(1)
  expect(copied[0]).toHaveLength(2)

  await page.locator('#disguise-pack').check()
  await page.locator('#obfuscate-btn-encode').click()
  await expect(page.locator('#disguise-pack-result')).toBeVisible()
  const packToken = await page.evaluate(() => (window as any).ImageDisguise._packResult.token)

  await page.locator('#disguise-pack-copy').click()
  await page.locator('#disguise-pack-reveal').click()
  const download = page.waitForEvent('download')
  await page.locator('#disguise-pack-download').click()

  expect((await download).suggestedFilename()).toMatch(/^a_2p( \(\d+\))?\.png$/)
  await expect.poll(() => copied.at(-1)).toEqual([packToken])
  await expect.poll(() => revealed).toEqual([packToken])
})

test('a picture protected in Simple mode first still downloads as the disguise PNG', async ({ page }) => {
  await openPrivacyTools(page)
  await addPictures(page, [{ name: 'simple-first.png', buffer: await pngBytes(page, '#c83030') }])
  await page.locator('#obfuscate-compat-mode').selectOption('small_tomato')
  await page.locator('#obfuscate-btn-encode').click()
  await expect(page.locator('#obfuscate-queue .obfuscate-item').first()).toHaveClass(/done/)
  await chooseDisguiseMode(page, 'blur')
  await page.locator('#obfuscate-btn-encode').click()
  await expect(page.locator('#obfuscate-queue .obfuscate-item-status').first()).toContainText('Disguised')

  const download = page.waitForEvent('download')
  await page.locator('#obfuscate-queue .obfuscate-download').first().click()
  const file = await download

  expect(file.suggestedFilename()).toMatch(/^simple-first( \(\d+\))?\.png$/)
  const bytes = fs.readFileSync((await file.path())!)
  expect(bytes.includes(Buffer.from('acTL'))).toBe(true)
})

test('a library image is sent by id even after its file was fetched', async ({ page }) => {
  await openPrivacyTools(page)
  const imageId = await page.evaluate(async () => {
    const response = await fetch('/api/images?limit=1')
    const body = await response.json()
    return (body.images || body.items || [])[0]?.id
  })
  test.skip(!imageId, 'the e2e library has no image')
  const sent: string[] = []
  await page.route('**/api/disguise/make', async (route) => {
    sent.push(route.request().postData() || '')
    await route.fulfill({ status: 200, json: { status: 'needs_cover', reason: 'nothing_detected' } })
  })
  await page.evaluate(async (id) => {
    const obfuscator = (window as any).ImageObfuscator
    await obfuscator.addLibraryImages([id])
    await obfuscator._ensureSourceFile(obfuscator._queue[0])
    ;(window as any).ensureFeatureModel = async () => ({ ok: true })
  }, imageId)
  await chooseDisguiseMode(page, 'mosaic')

  await page.locator('#obfuscate-btn-encode').click()

  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toContain(`[{"image_id":${imageId}}]`)
  await expect(page.locator('#obfuscate-queue .obfuscate-item').first()).toHaveClass(/needs_cover/)
})

test('a pack can be a plain looping GIF, which needs no cover', async ({ page }) => {
  await openPrivacyTools(page)
  await addPictures(page, [
    { name: 'gif-one.png', buffer: await pngBytes(page, '#c83030') },
    { name: 'gif-two.png', buffer: await pngBytes(page, '#3060c8') },
  ])
  await chooseDisguiseMode(page, 'upload')
  await expect(page.locator('#disguise-pack-format-row')).toBeHidden()
  await page.locator('#disguise-pack').check()
  await expect(page.locator('#disguise-pack-format-row')).toBeVisible()

  await page.locator('#disguise-pack-format').selectOption('gif')

  await expect(page.locator('#disguise-cover-row')).toBeHidden()
  await page.locator('#obfuscate-btn-encode').click()
  await expect(page.locator('#disguise-pack-result')).toBeVisible()
  await expect(page.locator('#disguise-pack-info')).toContainText(/gif-one_2p( \(\d+\))?\.gif/)
  const header = await page.evaluate(async () => {
    const blob: Blob = await (await fetch((window as any).ImageDisguise._packResult.file_url)).blob()
    return String.fromCharCode(...new Uint8Array(await blob.slice(0, 6).arrayBuffer()))
  })
  expect(header).toBe('GIF89a')
})
