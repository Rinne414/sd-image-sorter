import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { test, expect, type Page } from '../fixtures/click-ledger'
import { tmpRoot } from '../fixtures/v4-seed'

// Tiny 1x1 PNG (base64), used to simulate a clipboard image payload.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII='

// A picture on disk, handed over by its location the way QQ does it. The
// server fully decodes it, so it must be a valid PNG (the clipboard stub above
// has a bad IDAT checksum, which a browser tolerates and Pillow refuses).
const LOCATION_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOUqzjBwMDAxAAGAA/oAWIgQMaHAAAAAElFTkSuQmCC'
const LOCATION_DIR = path.join(tmpRoot, 'reader-paste-location')
const LOCATION_PICTURE = path.join(LOCATION_DIR, 'qq 图片.png')

function writeLocationPicture(): string {
  fs.mkdirSync(LOCATION_DIR, { recursive: true })
  fs.writeFileSync(LOCATION_PICTURE, Buffer.from(LOCATION_PNG_BASE64, 'base64'))
  return LOCATION_PICTURE
}

/** Answer /api/parse-image with a stub and remember the uploaded file names. */
async function stubParse(page: Page, prompt: string): Promise<string[]> {
  const uploads: string[] = []
  await page.route('**/api/parse-image', async (route) => {
    const body = route.request().postDataBuffer()?.toString('utf8') || ''
    uploads.push(/filename="([^"]*)"/.exec(body)?.[1] || '')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generator: 'webui',
        prompt,
        negative_prompt: '',
        width: 1,
        height: 1,
        file_size: 70,
        checkpoint: '',
        loras: [],
        metadata: { _parsed: { generation_params: { steps: 20 } } },
      }),
    })
  })
  return uploads
}

// Reach the Reader the way a user does: the top-bar tab. The view keeps its
// inline display:none (CSS .view.active shows it), so a test that rewrote
// style.display hid a paste listener that never fired for real users.
async function openReaderView(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#nav-tab-reader').click()
  await expect(page.locator('#view-reader')).toHaveClass(/active/)
  await expect(page.locator('#reader-tool-panel-reader')).toHaveClass(/active/)
  await expect(page.locator('#reader-paste-btn')).toBeInViewport()
}

test.describe('Image Reader — Paste from Clipboard', () => {
  test('renders the paste button and hint inside the drop zone', async ({ page }) => {
    await openReaderView(page)

    const pasteBtn = page.locator('#reader-paste-btn')
    await expect(pasteBtn).toBeVisible()
    await expect(pasteBtn).toContainText(/Paste from Clipboard|从剪贴板粘贴/)

    const hints = page.locator('.reader-paste-hint')
    await expect(hints.first()).toBeVisible()
    await expect(hints.first()).toContainText(/Ctrl\+V/i)
    await expect(hints.nth(1)).toContainText(/prompt details|full image info|完整提示词|完整信息/i)
  })

  test('Ctrl+V paste event containing an image triggers the reader pipeline', async ({ page }) => {
    await openReaderView(page)

    // Intercept /api/parse-image so the test doesn't depend on real SD metadata.
    await page.route('**/api/parse-image', async (route) => {
      const request = route.request()
      const postData = request.postData()
      // FormData will include the file — just confirm we got here and respond with a stub.
      expect(postData).toBeTruthy()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generator: 'webui',
          prompt: 'test paste prompt',
          negative_prompt: '',
          width: 1,
          height: 1,
          file_size: 70,
          checkpoint: '',
          loras: [],
          metadata: { _parsed: { generation_params: {} } },
        }),
      })
    })

    // Dispatch a synthetic paste event with an image blob.
    await page.evaluate((b64) => {
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'image/png' })
      const file = new File([blob], 'paste.png', { type: 'image/png' })

      const dt = new DataTransfer()
      dt.items.add(file)

      const evt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      } as ClipboardEventInit)
      document.dispatchEvent(evt)
    }, TINY_PNG_BASE64)

    // The reader shows the preview and result panel. The pasted file carried its
    // info, so there is no "may be incomplete" warning (it would be false).
    await expect(page.locator('#reader-image-preview')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#reader-generator')).toHaveText('WebUI', { timeout: 5000 })
    await expect(page.locator('#reader-prompt-text')).toContainText('test paste prompt')
    await expect(page.locator('#reader-status')).toBeHidden()
  })

  test('with clipboard access the paste button reads the clipboard at once', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await openReaderView(page)
    const uploads = await stubParse(page, 'win v picked prompt')

    // The button reads what is on the clipboard; no Ctrl+V needed.
    await page.evaluate(async (b64) => {
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
    }, LOCATION_PNG_BASE64)
    await page.locator('#reader-paste-btn').click()

    await expect(page.locator('#reader-prompt-text')).toContainText('win v picked prompt', { timeout: 10000 })
    expect(uploads).toHaveLength(1)
  })

  // Without clipboard access (the browser asked and was refused) the button arms Ctrl+V instead.
  test('paste button arms clipboard capture and the next paste event uses the same pipeline', async ({ page }) => {
    await openReaderView(page)

    await page.route('**/api/parse-image', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generator: 'webui',
          prompt: 'button paste prompt',
          negative_prompt: '',
          width: 1,
          height: 1,
          file_size: 70,
          checkpoint: '',
          loras: [],
          metadata: { _parsed: { generation_params: {} } },
        }),
      })
    })

    await page.locator('#reader-paste-btn').click()
    await expect(page.locator('#reader-status')).toContainText(/Press Ctrl\+V now|现在按 Ctrl\+V/, { timeout: 5000 })

    await page.evaluate((b64) => {
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'image/png' })
      const file = new File([blob], 'button-paste.png', { type: 'image/png' })

      const dt = new DataTransfer()
      dt.items.add(file)
      const evt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      } as ClipboardEventInit)
      document.dispatchEvent(evt)
    }, TINY_PNG_BASE64)

    await expect(page.locator('#reader-prompt-text')).toContainText('button paste prompt', { timeout: 5000 })
  })

  test('non-image paste after arming shows the no-image toast', async ({ page }) => {
    await openReaderView(page)

    await page.locator('#reader-paste-btn').click()
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.setData('text/plain', 'hello')
      const evt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      } as ClipboardEventInit)
      document.dispatchEvent(evt)
    })

    // Toast container selector matches the rest of the app.
    await expect(page.locator('.toast, #toast-container .toast')).toContainText(
      /No image found|剪贴板中没有图片/,
      { timeout: 5000 },
    )
  })

  test('clipboard images with missing SD metadata show the explicit metadata-lost warning', async ({ page }) => {
    await openReaderView(page)

    await page.route('**/api/parse-image', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generator: 'unknown',
          prompt: '',
          negative_prompt: '',
          width: 1,
          height: 1,
          file_size: 70,
          checkpoint: '',
          loras: [],
          metadata: { _parsed: { generation_params: {} } },
        }),
      })
    })

    await page.evaluate((b64) => {
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'image/png' })
      const file = new File([blob], 'metadata-lost.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const evt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      } as ClipboardEventInit)
      document.dispatchEvent(evt)
    }, TINY_PNG_BASE64)

    await expect(page.locator('#reader-generator')).toHaveText('Unknown', { timeout: 5000 })
    await expect(page.locator('#reader-status')).toContainText(
      /did not include the original image info|没有带上原始图片信息/,
      {
        timeout: 5000,
      },
    )
    await expect(page.locator('#reader-prompt-text')).toContainText(
      /does not contain the full prompt|没有完整提示词/,
      {
        timeout: 5000,
      },
    )
    await expect(page.locator('#reader-params')).toContainText(
      /does not contain the full generation parameters|没有完整出图参数/,
      {
        timeout: 5000,
      },
    )
  })
})

// QQ and other chat apps hand a picture over as its file location: a copied
// picture is `<img src="file://L:\...\x.png">` (HTML), a dragged one a
// file:// link. The Reader reads the original from disk (POST
// /api/local-picture) and goes on as for a dropped file.
test.describe('Image Reader — a picture handed over as its file location', () => {
  test('a paste carrying only <img src="file://..."> reads the original file from disk', async ({ page }) => {
    const picture = writeLocationPicture()
    await openReaderView(page)
    const uploads = await stubParse(page, 'qq location prompt')
    const asked: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/local-picture')) asked.push(JSON.parse(request.postData() || '{}').path)
    })

    // QQ's own shape: file:// straight before the drive, backslashes, nothing encoded.
    const src = `file://${picture}`
    await page.evaluate((value) => {
      const dt = new DataTransfer()
      dt.setData('text/html', `<html><body><!--StartFragment--><img src="${value}" /><!--EndFragment--></body></html>`)
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true } as ClipboardEventInit))
    }, src)

    await expect(page.locator('#reader-prompt-text')).toContainText('qq location prompt', { timeout: 10000 })
    expect(asked).toEqual([src])
    expect(uploads).toEqual(['qq 图片.png'])
    // The original file, not a clipboard copy: no "details may be lost" warning.
    await expect(page.locator('#reader-status')).toBeHidden()
  })

  test('a drop carrying only a text/uri-list file:// link reads the original file from disk', async ({ page }) => {
    const picture = writeLocationPicture()
    await openReaderView(page)
    const uploads = await stubParse(page, 'dragged location prompt')

    const dt = await page.evaluateHandle((uri) => {
      const data = new DataTransfer()
      data.setData('text/uri-list', uri)
      return data
    }, pathToFileURL(picture).href)
    await page.dispatchEvent('#reader-drop-zone', 'dragover', { dataTransfer: dt })
    await page.dispatchEvent('#reader-drop-zone', 'drop', { dataTransfer: dt })

    await expect(page.locator('#reader-prompt-text')).toContainText('dragged location prompt', { timeout: 10000 })
    expect(uploads).toEqual(['qq 图片.png'])
  })

  test('a location whose file is gone, and a drop with no picture at all, each say why', async ({ page }) => {
    await openReaderView(page)
    let parsed = 0
    await page.route('**/api/parse-image', (route) => {
      parsed += 1
      return route.abort()
    })

    await page.evaluate((value) => {
      const dt = new DataTransfer()
      dt.setData('text/plain', `<img src="${value}" />`)
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true } as ClipboardEventInit))
    }, `file://${path.join(LOCATION_DIR, 'gone.png')}`)
    await expect(page.locator('#toast-container')).toContainText(/gone\.png/, { timeout: 10000 })
    await expect(page.locator('#toast-container')).toContainText(/QQ/)

    const dt = await page.evaluateHandle(() => {
      const data = new DataTransfer()
      data.setData('text/plain', 'just some words')
      return data
    })
    await page.dispatchEvent('#reader-drop-zone', 'drop', { dataTransfer: dt })
    await expect(page.locator('#toast-container')).toContainText(/no picture file location|也没有图片的文件位置/)
    expect(parsed).toBe(0)
  })
})
