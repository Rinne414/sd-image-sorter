import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Restart after a feature install happens in place: the launcher starts the
 * server again in its own window, and this tab reloads itself as soon as a
 * server answers /api/updates/boot-id with a new id. A card that still needs
 * the restart offers that restart, and using the feature asks for it instead
 * of preparing again and running in the old process.
 */

const RESTART_CARD = {
  id: 'florence2',
  name: 'Florence-2 Base',
  group: 'Captioning',
  status: 'needs_restart',
  status_label: 'Restart required',
  available: false,
  message: 'Installed packages load after a restart.',
  download_supported: true,
}

async function stubRestartFlow(page: Page) {
  const calls = { restart: 0, prepare: 0 }
  let bootId = 'boot-old'
  await page.route('**/api/models/status', (route) =>
    route.fulfill({ json: { status: 'ok', models: [RESTART_CARD], health: {} } }))
  await page.route('**/api/models/mirror', (route) =>
    route.fulfill({ json: { mirror: 'auto', options: ['auto'] } }))
  await page.route('**/api/models/prepare**', (route) => {
    calls.prepare += 1
    return route.fulfill({ json: { status: 'started', model_id: RESTART_CARD.id } })
  })
  await page.route('**/api/updates/boot-id', (route) =>
    route.fulfill({ json: { boot_id: bootId } }))
  await page.route('**/api/updates/restart', (route) => {
    calls.restart += 1
    const answer = { status: 'scheduled', launcher: 'run.bat', mode: 'in_place', boot_id: bootId }
    // The new process answers with a different id a moment later.
    setTimeout(() => { bootId = 'boot-new' }, 1500)
    return route.fulfill({ json: answer })
  })
  return calls
}

test('a card waiting on a restart offers it, and the tab reloads when the server is back', async ({ page }) => {
  const calls = await stubRestartFlow(page)
  await page.goto('/')
  await page.locator('#btn-open-model-manager').click()
  await expect(page.locator('#model-manager-modal')).toBeVisible()
  await page.locator('[data-settings-tab="models"]').click()

  const card = page.locator(`.model-card[data-model-id="${RESTART_CARD.id}"]`)
  await expect(card.locator('.btn-restart-model')).toBeVisible()
  await expect(card.locator('.btn-prepare-model')).toHaveCount(0)

  await page.evaluate(() => { (window as any).__beforeRestart = true })
  const reloaded = page.waitForEvent('load')
  await card.locator('.btn-restart-model').click()
  await reloaded
  expect(calls.restart).toBe(1)
  expect(await page.evaluate(() => (window as any).__beforeRestart ?? null)).toBeNull()

  // The resume queue carries the model so its setup continues after the restart.
  const queue = await page.evaluate(() => localStorage.getItem('sd-image-sorter-prepare-resume-v1'))
  expect(queue).toContain(RESTART_CARD.id)
})

test('using a feature that still needs the restart asks for it instead of preparing again', async ({ page }) => {
  const calls = await stubRestartFlow(page)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).ensureFeatureModel)).toBe('function')

  const result = await page.evaluate(() => (window as any).ensureFeatureModel('florence2', {
    label: 'Florence-2 Base',
    sizeHint: '~465 MB',
    confirmBytes: 0,
  }))

  expect(result).toEqual({ ok: false, needsRestart: true })
  expect(calls.prepare).toBe(0)
  const overlay = page.locator('#feature-model-install-overlay')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('[data-action="restart-and-continue"]')).toBeVisible()
})

test('restarting while work runs asks first: No keeps it running, Yes restarts', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await stubRestartFlow(page)
  const forced: unknown[] = []
  let bootId = 'boot-old'
  await page.route('**/api/updates/boot-id', (route) => route.fulfill({ json: { boot_id: bootId } }))
  await page.route('**/api/updates/restart', (route) => {
    const body = route.request().postDataJSON() as { force?: boolean }
    forced.push(body.force)
    if (!body.force) {
      return route.fulfill({ json: { status: 'busy', jobs: ['scan', 'model_setup'], boot_id: bootId } })
    }
    setTimeout(() => { bootId = 'boot-new' }, 1500)
    return route.fulfill({ json: { status: 'scheduled', launcher: 'run.bat', mode: 'in_place', boot_id: bootId } })
  })
  await page.goto('/')
  await page.locator('#btn-open-model-manager').click()
  await page.locator('[data-settings-tab="models"]').click()
  const restartBtn = page.locator(`.model-card[data-model-id="${RESTART_CARD.id}"] .btn-restart-model`)

  await restartBtn.click()
  const message = page.locator('#confirm-message')
  await expect(message).toContainText('a folder scan')
  await expect(message).toContainText('a model download')
  await page.locator('#btn-confirm-cancel').click()
  await expect(restartBtn).toBeEnabled()
  expect(forced).toEqual([false])

  await page.evaluate(() => { (window as any).__beforeRestart = true })
  const reloaded = page.waitForEvent('load')
  await restartBtn.click()
  await page.locator('#btn-confirm-ok').click()
  await reloaded
  expect(forced).toEqual([false, false, true])
  expect(await page.evaluate(() => (window as any).__beforeRestart ?? null)).toBeNull()
})
