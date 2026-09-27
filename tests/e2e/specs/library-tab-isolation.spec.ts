import { expect, test, type Page } from '../fixtures/click-ledger'
import { markModelsReady } from '../fixtures/model-status'

/**
 * Each tab keeps its own library (V3.5 issue #30).
 *
 * The shared localStorage key only records the last choice for the next
 * launch; a tab reads it once. Another tab switching library, or the tab's
 * own library being deleted elsewhere, must never silently change which
 * library this tab's requests name. Also: the Style Finder's clear confirm
 * says it clears the current library only.
 */

test.describe.configure({ mode: 'serial' })

const LIBRARY_KEY = 'sd-library-workspace-v1'

async function boot(page: Page) {
  await page.addInitScript((key) => {
    if (sessionStorage.getItem('tab-isolation-booted')) return
    sessionStorage.setItem('tab-isolation-booted', '1')
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem(key, JSON.stringify({ v: 2, currentId: 'main' }))
  }, LIBRARY_KEY)
  await markModelsReady(page)
}

async function makeLibrary(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/libraries', { data: { name } })
  expect(res.ok()).toBe(true)
  return (await res.json()).library.id
}

async function dropLibrary(page: Page, id: string): Promise<void> {
  await page.request.delete(`/api/libraries/${encodeURIComponent(id)}`)
}

const currentLibrary = (page: Page) => page.evaluate(() => (window as any).LibraryWorkspace?.getCurrentLibraryId())
const storedLibrary = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}').currentId, LIBRARY_KEY)

/** The library the tab's next gallery request names. */
async function nextRequestLibrary(page: Page): Promise<string | undefined> {
  const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/images')
  await page.evaluate(() => (window as any).loadImages(false, { coalesce: false }))
  return (await request).headers()['x-sd-library-id']
}

/** Open "清空当前图库" (it refreshes the library list first), read what it would clear, cancel. */
async function clearConfirmText(page: Page): Promise<string> {
  await page.click('#btn-clear-db')
  const message = page.locator('#confirm-modal.visible #confirm-message')
  await expect(message).toBeVisible()
  const text = (await message.textContent()) ?? ''
  await page.click('#btn-confirm-cancel')
  await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)
  return text
}

test('a tab keeps its own library when another tab switches; refreshing its list moves nothing', async ({ page, context }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await boot(page)
  const name = `另一个图库 ${Date.now()}`
  const other = await makeLibrary(page, name)
  try {
    await page.goto('/')
    await expect(page.locator('#view-gallery')).toBeVisible()
    await expect(page.locator('#nav-library-chip-label')).toContainText('主图库')
    expect(await nextRequestLibrary(page)).toBe('main')

    // a second tab switches to the other library (its switch writes the shared key)
    const second = await context.newPage()
    await second.goto('/')
    await expect(second.locator('#view-gallery')).toBeVisible()
    await second.evaluate((id) => (window as any).LibraryWorkspace.setCurrentLibraryId(id, { reloadGallery: false }), other)
    await expect.poll(() => storedLibrary(second)).toBe(other)
    await second.close()

    // this tab refreshes its list ("清空当前图库" does, before it asks): it still names the library it shows
    const confirm = await clearConfirmText(page)
    expect(confirm).toContain('主图库')
    expect(confirm).not.toContain(name)
    expect(await currentLibrary(page)).toBe('main')
    expect(await nextRequestLibrary(page)).toBe('main')
    await expect(page.locator('#nav-library-chip-label')).toContainText('主图库')
    // the shared key still holds the other tab's choice, for the next launch
    expect(await storedLibrary(page)).toBe(other)

    // the library menu (it refreshes the list too) still marks this tab's library
    await page.click('#nav-library-chip')
    await expect(page.locator('#entry-library-menu')).toBeVisible()
    await expect(page.locator('#entry-library-name')).toHaveText('主图库')
    await expect(page.locator('#entry-library-menu .entry-library-menu-item.is-current')).toContainText('主图库')
    expect(await currentLibrary(page)).toBe('main')
    expect(await nextRequestLibrary(page)).toBe('main')
  } finally {
    await dropLibrary(page, other)
  }
})

test('a tab whose library is deleted elsewhere moves to one that exists the way a switch does, and says so', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await boot(page)
  const gone = await makeLibrary(page, `会被删除 ${Date.now()}`)
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.evaluate((id) => (window as any).LibraryWorkspace.setCurrentLibraryId(id, { reloadGallery: false }), gone)
  await expect.poll(() => currentLibrary(page)).toBe(gone)

  // another window deletes it
  await dropLibrary(page, gone)
  const confirm = await clearConfirmText(page)
  expect(confirm).toContain('主图库')
  await expect(page.locator('.toast.warning .toast-message')).toContainText('已不存在')
  expect(await currentLibrary(page)).toBe('main')
  expect(await nextRequestLibrary(page)).toBe('main')
  await expect(page.locator('#nav-library-chip-label')).toContainText('主图库')
})

test('Style Finder: clearing results says it clears the current library only, in both languages', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await boot(page)
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.waitForFunction(() => Boolean((window as any).ArtistIdent?.clearAllData))

  await page.evaluate(() => (window as any).ArtistIdent.clearAllData())
  await expect(page.locator('#confirm-message')).toHaveText('要清空当前图库的画师识别结果吗？其他图库不受影响。此操作无法撤销。')
  await page.click('#btn-confirm-cancel')
  const english = await page.evaluate(() => (window as any).I18nLang_en['artist.clearConfirmMessage'])
  expect(english).toBe('Clear the artist predictions of the current library? Other libraries are not affected. This cannot be undone.')
})
