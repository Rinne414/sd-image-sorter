import { test, expect } from '@playwright/test'

// Tiny 1x1 PNG (base64), used to simulate a clipboard image payload.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII='

async function openReaderView(page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')

  // Navigate via the main reader tab if present, otherwise reveal the view directly.
  await page.evaluate(() => {
    const view = document.getElementById('view-reader')
    if (view) {
      document.querySelectorAll('.view').forEach((node) => {
        if (node !== view) {
          ;(node as HTMLElement).style.display = 'none'
        }
      })
      ;(view as HTMLElement).style.display = 'flex'
      view.classList.add('active')
    }
    const panel = document.getElementById('reader-tool-panel-reader')
    panel?.classList.add('active')
  })
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

    // The reader should show the preview, result panel, and clipboard warning.
    await expect(page.locator('#reader-image-preview')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#reader-generator')).toHaveText('WebUI', { timeout: 5000 })
    await expect(page.locator('#reader-prompt-text')).toContainText('test paste prompt')
    await expect(page.locator('#reader-status')).toContainText(
      /prompt or model details may be incomplete|提示词或模型信息可能不完整/,
      { timeout: 5000 },
    )
  })

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
