import { expect, test } from '../fixtures/click-ledger'

/**
 * A page that sends its own request reads the program's error answer
 * ({"error": ...}), so a failure says why instead of a generic line. The
 * other such pages are held by backend/tests/test_frontend_error_bodies.py.
 */

test.use({ viewport: { width: 1366, height: 768 } })

test('the folder browser says why it could not list folders', async ({ page }) => {
  await page.route('**/api/browse-folder', (route) => route.fulfill({
    status: 403,
    json: { error: 'This folder is outside the folders the program may read.', type: 'HTTPException', status_code: 403 },
  }))
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as any).showFolderBrowser === 'function')
  await page.evaluate(() => {
    const input = document.getElementById('scan-folder-path') as HTMLInputElement
    input.value = ''
    return (window as any).showFolderBrowser(input)
  })

  await expect(page.locator('#folder-browser-container .folder-browser-error'))
    .toHaveText('Error: This folder is outside the folders the program may read.')
})
