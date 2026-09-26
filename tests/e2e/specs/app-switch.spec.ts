import { expect, test, type Page } from '../fixtures/click-ledger'
import { markModelsReady } from '../fixtures/model-status'

/**
 * Switching to V4 and back (slice 6b), the V3.5 side.
 *
 * "试用新版界面（V4）" sits in the top bar's More menu and in the All Features
 * catalog, and goes to /v4/ with the open library. Arriving at / with
 * ?library=<id> (V4's way back) opens that library when this backend has it
 * and drops the parameter from the address; an unknown id keeps the open
 * library without a word. Also: the Style Finder's clear confirm says it
 * clears the current library only (D49).
 *
 * /v4/ is stood in for: only where the links lead is under test here (the
 * V4 side is in v4-shell.spec.ts).
 */

test.describe.configure({ mode: 'serial' })

const LIBRARY_KEY = 'sd-library-workspace-v1'

async function boot(page: Page, { entry = false }: { entry?: boolean } = {}) {
  await page.addInitScript(
    ([key, showEntry]) => {
      if (sessionStorage.getItem('app-switch-booted')) return
      sessionStorage.setItem('app-switch-booted', '1')
      localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
      localStorage.setItem(key as string, JSON.stringify({ v: 2, currentId: 'main' }))
      if (showEntry) localStorage.removeItem('aurora-entry-skip')
    },
    [LIBRARY_KEY, entry] as const,
  )
  await markModelsReady(page)
  await page.route(
    (url) => url.pathname.startsWith('/v4/'),
    (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>V4</title>' }),
  )
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

test('More menu: the V4 entry carries the open library, follows a library switch, and goes to /v4/', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await boot(page)
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()

  await page.click('#nav-tools-toggle')
  const entry = page.locator('#nav-tools-v4')
  await expect(entry).toBeInViewport({ ratio: 1 })
  await expect(entry).toHaveText('试用新版界面（V4）')
  await expect(entry).toHaveAttribute('title', /设置 › 关于/)
  await expect(entry).toHaveAttribute('href', '/v4/?library=main')

  const other = await makeLibrary(page, `切换 ${Date.now()}`)
  try {
    await page.evaluate((id) => (window as any).LibraryWorkspace.setCurrentLibraryId(id, { reloadGallery: false }), other)
    await expect(entry).toHaveAttribute('href', `/v4/?library=${other}`)
    if (await page.locator('#nav-tools-menu').isHidden()) await page.click('#nav-tools-toggle')
    await entry.click()
    await expect(page).toHaveURL(new RegExp(`/v4/\\?library=${other}$`))
  } finally {
    await dropLibrary(page, other)
  }
})

test('arriving with ?library= opens that library and drops it from the address; an unknown id keeps the open one', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await boot(page)
  const name = `回来 ${Date.now()}`
  const other = await makeLibrary(page, name)
  try {
    await page.goto(`/?library=${other}`)
    await expect(page.locator('#view-gallery')).toBeVisible()
    await expect.poll(() => currentLibrary(page)).toBe(other)
    await expect(page).not.toHaveURL(/library=/)
    await expect(page.locator('#nav-library-chip-label')).toContainText(name)
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}').currentId, LIBRARY_KEY)
    expect(stored).toBe(other)
    await page.click('#nav-tools-toggle')
    await expect(page.locator('#nav-tools-v4')).toHaveAttribute('href', `/v4/?library=${other}`)

    await page.goto('/?library=no-such-library')
    await expect(page.locator('#view-gallery')).toBeVisible()
    await expect(page).not.toHaveURL(/library=/)
    await page.waitForLoadState('networkidle')
    expect(await currentLibrary(page)).toBe(other)
    await expect(page.locator('.toast.error')).toHaveCount(0)
  } finally {
    await dropLibrary(page, other)
  }
})

test('All Features lists the V4 entry, which goes to /v4/ with the open library', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await boot(page, { entry: true })
  await page.goto('/')
  await expect(page.locator('#entry-page')).toBeVisible()
  await page.click('#entry-all-tools')
  const row = page.locator('#entry-catalog-body .catalog-item', { hasText: '试用新版界面（V4）' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('设置 › 关于')
  await row.click()
  await expect(page).toHaveURL(/\/v4\/\?library=main$/)
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

test('6b-fix: a V3.5 tab keeps its own library when another tab (V4, then V3.5) switches; refreshing its list moves nothing', async ({ page, context }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await boot(page)
  const name = `另一个图库 ${Date.now()}`
  const other = await makeLibrary(page, name)
  try {
    await page.goto('/')
    await expect(page.locator('#view-gallery')).toBeVisible()
    await expect(page.locator('#nav-library-chip-label')).toContainText('主图库')
    expect(await nextRequestLibrary(page)).toBe('main')

    // V4 in another tab opens the other library (its switch writes the shared key)
    const v4 = await context.newPage()
    await v4.addInitScript(() => localStorage.setItem('sd-v4-update-autocheck', '0'))
    await v4.goto(`/v4/?library=${other}`)
    await expect.poll(() => storedLibrary(v4)).toBe(other)
    await v4.close()

    // this tab refreshes its list ("清空当前图库" does, before it asks): it still names the library it shows
    const confirm = await clearConfirmText(page)
    expect(confirm).toContain('主图库')
    expect(confirm).not.toContain(name)
    expect(await currentLibrary(page)).toBe('main')
    expect(await nextRequestLibrary(page)).toBe('main')
    await expect(page.locator('#nav-library-chip-label')).toContainText('主图库')
    // the shared key still holds the other tab's choice, for the next launch
    expect(await storedLibrary(page)).toBe(other)

    // the same with a second V3.5 tab: it switches to main and back to the other library by hand
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ v: 2, currentId: 'main' })), LIBRARY_KEY)
    const second = await context.newPage()
    await second.goto('/')
    await expect(second.locator('#view-gallery')).toBeVisible()
    await second.evaluate((id) => (window as any).LibraryWorkspace.setCurrentLibraryId(id, { reloadGallery: false }), other)
    await second.close()
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

test('6b-fix: a V3.5 tab whose library is deleted elsewhere moves to one that exists the way a switch does, and says so', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await boot(page)
  const gone = await makeLibrary(page, `会被删除 ${Date.now()}`)
  await page.goto(`/?library=${gone}`)
  await expect(page.locator('#view-gallery')).toBeVisible()
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
