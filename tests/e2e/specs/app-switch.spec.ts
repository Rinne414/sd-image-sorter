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
