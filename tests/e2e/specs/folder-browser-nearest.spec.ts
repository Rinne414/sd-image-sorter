import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * A typed folder the browser could not open (a typo, a folder moved away, an
 * unplugged drive) made it jump to the drive list without a word. It now opens
 * the nearest folder above that exists and says what could not be opened.
 */

async function browse(page: Page, typed: string, answers: Record<string, { status: number, json: unknown }>) {
  const asked: string[] = []
  await page.route('**/api/browse-folder', (route) => {
    const path = route.request().postDataJSON().path as string
    asked.push(path)
    const answer = answers[path] || { status: 400, json: { error: 'Path does not exist', type: 'HTTPException', status_code: 400 } }
    return route.fulfill(answer)
  })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as any).showFolderBrowser === 'function')
  await page.evaluate((value) => {
    const input = document.getElementById('scan-folder-path') as HTMLInputElement
    input.value = value
    return (window as any).showFolderBrowser(input)
  }, typed)
  return asked
}

const PICS = {
  status: 200,
  json: { current: 'D:\\Pics', parent: 'D:\\', subdirs: [{ name: 'Old', path: 'D:\\Pics\\Old', has_children: false }] },
}

test('a typed folder that does not exist opens the nearest one that does, and says so', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const asked = await browse(page, 'D:\\Pics\\SD\\new', { 'D:\\Pics': PICS })

  const panel = page.locator('#folder-browser-container .folder-browser')
  await expect(panel.locator('.folder-browser-path')).toHaveText('D:\\Pics')
  await expect(panel.locator('.folder-browser-notice'))
    .toHaveText('Could not open D:\\Pics\\SD\\new: Path does not exist. Showing the nearest folder that opens.')
  await expect(panel.locator('.folder-browser-item-name')).toHaveText(['Old'])
  expect(asked).toEqual(['D:\\Pics\\SD\\new', 'D:\\Pics\\SD', 'D:\\Pics'])
})

test('a folder name with a dollar sign is quoted as typed', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await browse(page, 'D:\\Pics\\$&cache', { 'D:\\Pics': PICS })

  await expect(page.locator('#folder-browser-container .folder-browser-notice'))
    .toHaveText('Could not open D:\\Pics\\$&cache: Path does not exist. Showing the nearest folder that opens.')
})

test('a folder that opens shows no notice', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await browse(page, 'D:\\Pics', { 'D:\\Pics': PICS })

  const panel = page.locator('#folder-browser-container .folder-browser')
  await expect(panel.locator('.folder-browser-path')).toHaveText('D:\\Pics')
  await expect(panel.locator('.folder-browser-notice')).toHaveCount(0)
})

test('a request that gets no answer at all says so instead of walking up', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const asked: string[] = []
  await page.route('**/api/browse-folder', (route) => {
    asked.push(route.request().postDataJSON().path as string)
    return route.abort('connectionrefused')
  })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as any).showFolderBrowser === 'function')
  await page.evaluate(() => {
    const input = document.getElementById('scan-folder-path') as HTMLInputElement
    input.value = 'D:\Pics\SD'
    return (window as any).showFolderBrowser(input)
  })

  const panel = page.locator('#folder-browser-container .folder-browser')
  await expect(panel.locator('.folder-browser-error')).toContainText('Error: ')
  await expect(panel.locator('.folder-browser-notice')).toHaveCount(0)
  expect(asked).toEqual(['D:\Pics\SD'])
})
