import { expect, test, type Page } from '@playwright/test'

/**
 * The classic interface checks for a new version by itself: once after start, at
 * most once a day, never blocking, silent when it fails, and only a quiet
 * reminder (never a popup, never an install). An off switch sits next to the
 * update controls in Settings and "Reset all settings" turns it back on. The
 * status request is answered by the spec, so no test reaches GitHub.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const AUTO_KEY = 'sd-image-sorter-update-autocheck'
const CHECKED_AT_KEY = 'sd-image-sorter-update-checked-at'

const newer = {
  updater_enabled: true, current_version: '3.10.2', latest_version: '3.11.0', has_update: true,
  release_url: 'https://example.invalid/release', release_notes: '', error: null, update_unavailable_reason: null,
  checked_at: 1,
}

type Reply = Record<string, unknown> | 'fail'

async function open(page: Page, reply: Reply, seed: Record<string, string> = {}) {
  const calls = { status: 0, apply: 0 }
  await page.route('**/api/updates/status**', async (route) => {
    calls.status += 1
    if (reply === 'fail') await route.abort('connectionrefused')
    else await route.fulfill({ json: reply })
  })
  await page.route('**/api/updates/apply**', async (route) => {
    calls.apply += 1
    await route.fulfill({ json: { status: 'scheduled' } })
  })
  await page.clock.install()
  await page.addInitScript((items) => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value)
  }, seed)
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()
  return calls
}

const afterStartDelay = (page: Page) => page.clock.runFor(31_000)

test('a new version is found once after start and shown as a quiet reminder', async ({ page }) => {
  const calls = await open(page, newer)
  expect(calls.status).toBe(0)
  await afterStartDelay(page)
  await expect.poll(() => calls.status).toBe(1)
  await expect(page.locator('.toast.info')).toContainText('3.11.0')
  await expect(page.locator('#btn-app-update')).toHaveAttribute('data-update-state', 'available')
  await expect(page.locator('#update-popup.visible')).toHaveCount(0)
  expect(calls.apply).toBe(0)
})

test('it does not check again within a day', async ({ page }) => {
  const calls = await open(page, newer, { [CHECKED_AT_KEY]: String(Date.now() - 3 * 3600 * 1000) })
  await afterStartDelay(page)
  await page.waitForTimeout(300)
  expect(calls.status).toBe(0)
})

test('it checks again after a day', async ({ page }) => {
  const calls = await open(page, newer, { [CHECKED_AT_KEY]: String(Date.now() - 25 * 3600 * 1000) })
  await afterStartDelay(page)
  await expect.poll(() => calls.status).toBe(1)
})

test('the off switch stops the check', async ({ page }) => {
  const calls = await open(page, newer, { [AUTO_KEY]: '0' })
  await afterStartDelay(page)
  await page.waitForTimeout(300)
  expect(calls.status).toBe(0)
})

test('a failed check stays silent and is tried again next start', async ({ page }) => {
  const calls = await open(page, 'fail')
  await afterStartDelay(page)
  await expect.poll(() => calls.status).toBe(1)
  await page.waitForTimeout(300)
  await expect(page.locator('.toast')).toHaveCount(0)
  await expect(page.locator('#server-gone-banner')).toHaveCount(0)
  expect(await page.evaluate((key) => localStorage.getItem(key), CHECKED_AT_KEY)).toBeNull()
})

test('Settings has the switch next to the update controls and Reset all turns it back on', async ({ page }) => {
  await open(page, newer)
  await page.click('#btn-open-model-manager')
  const toggle = page.locator('#btn-settings-auto-update')
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTO_KEY)).toBe('0')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTO_KEY)).toBeNull()

  await toggle.click()
  await page.locator('#btn-settings-reset-all').scrollIntoViewIfNeeded()
  await page.click('#btn-settings-reset-all')
  await Promise.all([page.waitForEvent('load'), page.click('#btn-confirm-ok')])
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTO_KEY)).toBeNull()
})
