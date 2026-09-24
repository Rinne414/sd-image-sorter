import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * First-use installs that report no byte progress (package installs, Hub
 * downloads) show how long they have been running instead of a false
 * "download may have stalled", and can continue in the background.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

async function stubSilentInstall(page: Page, settleAfterPolls: number) {
  let polls = 0
  await page.route('**/api/models/status', (route) => route.fulfill({
    json: {
      status: 'ok',
      models: [{ id: 'clip', name: 'CLIP', status: 'missing', available: false, download_supported: true }],
      health: {},
    },
  }))
  await page.route('**/api/models/prepare', (route) => route.fulfill({ json: { status: 'started', model_id: 'clip' } }))
  await page.route('**/api/models/download-progress', (route) => {
    polls += 1
    const settled = polls > settleAfterPolls
    return route.fulfill({
      json: {
        active: false,
        prepare_result: settled
          ? { active: false, model_id: 'clip', status: 'done', message: '' }
          : { active: true, model_id: 'clip' },
      },
    })
  })
}

test('an install without byte progress shows its elapsed time and can continue in the background', async ({ page }) => {
  await stubSilentInstall(page, 8)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).ensureFeatureModel)).toBe('function')

  const ensured = page.evaluate(() => (window as any).ensureFeatureModel('clip', { label: 'CLIP', confirmBytes: 0 }))
  const overlay = page.locator('#feature-model-install-overlay')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.feature-model-install-status')).toContainText('so far')

  await overlay.locator('[data-action="install-background"]').click()
  await expect(overlay).toBeHidden()
  expect(await ensured).toMatchObject({ ok: true })
  await expect(page.locator('#toast-container .toast', { hasText: 'CLIP is installed' }).first()).toBeVisible()
  await expect(overlay).toBeHidden()
  await expect(page.locator('#toast-container .toast', { hasText: 'may have stalled' })).toHaveCount(0)
})
