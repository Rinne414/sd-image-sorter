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

    const hint = page.locator('.reader-paste-hint')
    await expect(hint).toBeVisible()
    await expect(hint).toContainText(/Ctrl\+V/i)
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

    // The reader should show the preview and then the result panel.
    await expect(page.locator('#reader-image-preview')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#reader-generator')).toHaveText('WEBUI', { timeout: 5000 })
    await expect(page.locator('#reader-prompt-text')).toContainText('test paste prompt')
  })

  test('paste button invokes the _handlePaste method', async ({ page }) => {
    await openReaderView(page)

    // Spy on _handlePaste so we don't depend on the non-writable navigator.clipboard.
    await page.evaluate(() => {
      const reader = (window as any).ImageReader
      reader.__pasteCalls = 0
      const original = reader._handlePaste.bind(reader)
      reader._handlePaste = function () {
        this.__pasteCalls++
        return original()
      }
    })

    await page.locator('#reader-paste-btn').click()

    const calls = await page.evaluate(() => (window as any).ImageReader.__pasteCalls)
    expect(calls).toBe(1)
  })

  test('empty clipboard shows the no-image toast', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openReaderView(page)

    // Override navigator.clipboard.read via Object.defineProperty since the
    // property is typically non-writable in Chromium.
    await page.evaluate(() => {
      const fakeClipboard = {
        read: async () => [
          {
            types: ['text/plain'],
            getType: async () => new Blob(['hello'], { type: 'text/plain' }),
          },
        ],
        readText: async () => 'hello',
        write: async () => {},
        writeText: async () => {},
      }
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          get: () => fakeClipboard,
        })
      } catch (_) {
        // fallback
        ;(navigator as any).clipboard = fakeClipboard
      }
    })

    await page.locator('#reader-paste-btn').click()

    // Toast container selector matches the rest of the app.
    await expect(page.locator('.toast, #toast-container .toast')).toContainText(
      /No image found|剪贴板中没有图片/,
      { timeout: 5000 },
    )
  })
})
