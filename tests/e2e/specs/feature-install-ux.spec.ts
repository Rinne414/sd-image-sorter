import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * First-use installs that report no byte progress (package installs, Hub
 * downloads) show how long they have been running instead of a false
 * "download may have stalled", and can continue in the background. Before a
 * setup starts, the confirm says whether a restart will follow.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

async function stubPlan(page: Page, plan: { packages: string[]; restart_likely: boolean }) {
  await page.route('**/api/models/plan**', (route) => route.fulfill({ json: { model_id: 'clip', ...plan } }))
}

async function stubSilentInstall(page: Page, settleAfterPolls: number) {
  let polls = 0
  await stubPlan(page, { packages: [], restart_likely: false })
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

test('a setup that will need a restart says so before anything downloads', async ({ page }) => {
  let prepareCalls = 0
  await page.route('**/api/models/status', (route) => route.fulfill({
    json: {
      status: 'ok',
      models: [{ id: 'clip', name: 'CLIP', status: 'missing', available: false, download_supported: true }],
      health: {},
    },
  }))
  await stubPlan(page, { packages: ['fastembed>=0.4.0', 'onnxruntime>=1.17'], restart_likely: true })
  await page.route('**/api/models/prepare', (route) => {
    prepareCalls += 1
    return route.fulfill({ json: { status: 'started', model_id: 'clip' } })
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).ensureFeatureModel)).toBe('function')

  const ensured = page.evaluate(() => (window as any).ensureFeatureModel('clip', {
    label: 'CLIP', sizeHint: '~580 MB', confirmBytes: 0,
  }))
  const message = page.locator('#confirm-message')
  await expect(message).toBeVisible()
  await expect(message).toContainText('580 MB')
  await expect(message).toContainText('2 Python package')
  await expect(message).toContainText('restart')

  await page.locator('#btn-confirm-cancel').click()
  expect(await ensured).toEqual({ ok: false, cancelled: true })
  expect(prepareCalls).toBe(0)
})

test('a large download that needs no restart says it is ready once downloaded', async ({ page }) => {
  await stubSilentInstall(page, 0)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).ensureFeatureModel)).toBe('function')

  const ensured = page.evaluate(() => (window as any).ensureFeatureModel('clip', {
    label: 'CLIP', sizeHint: '~580 MB', confirmBytes: 580 * 1024 * 1024,
  }))
  const message = page.locator('#confirm-message')
  await expect(message).toBeVisible()
  await expect(message).toContainText('no restart')

  await page.locator('#btn-confirm-ok').click()
  expect(await ensured).toMatchObject({ ok: true })
})
