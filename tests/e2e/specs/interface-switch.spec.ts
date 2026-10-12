import { expect, test, type Page } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { pageOverflow, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * One backend, two interfaces: the classic one at / (the default) and Vopus at
 * /vopus/. Settings in either one picks which opens at /, and the choice is
 * kept on the backend, so a reload (or another browser) opens the same one.
 * /?ui=classic always reaches the classic interface; old /v4/ addresses lead
 * to /vopus/.
 *
 * Needs the Vopus build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const setInterface = (page: Page, value: 'classic' | 'vopus') =>
  page.request.put('/api/interface', { data: { interface: value } })

/** Page errors and console errors seen while the test ran. */
function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  return errors
}

async function prepare(page: Page, lang: 'en' | 'zh-CN' = 'zh-CN') {
  await markModelsReady(page)
  await page.addInitScript((l) => {
    localStorage.setItem('sd-image-sorter-lang', l)
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.setItem('sd-v4-update-autocheck', '0')
  }, lang)
}

async function classicReady(page: Page) {
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).EntryPage?.hide?.())
}

const vopusReady = (page: Page) => expect(page.getByTestId('settings-button')).toBeVisible()

/** The Interface row in classic Settings › General, fully inside the dialog. */
async function openClassicInterfaceRow(page: Page) {
  await page.locator('#btn-open-model-manager').click()
  const button = page.locator('#btn-settings-interface')
  await expect(button).toBeVisible()
  await button.scrollIntoViewIfNeeded()
  const dialog = await page.locator('#model-manager-modal .modal-content').boundingBox()
  const box = await button.boundingBox()
  expect(dialog && box).toBeTruthy()
  expect(box!.x).toBeGreaterThanOrEqual(dialog!.x)
  expect(box!.x + box!.width).toBeLessThanOrEqual(dialog!.x + dialog!.width + 0.5)
  return button
}

test.afterEach(async ({ page }) => {
  expect((await setInterface(page, 'classic')).ok()).toBe(true)
})

for (const size of VIEWPORTS) {
  test(`classic Settings switches to Vopus, / keeps opening it, Vopus Settings switches back (${size.width}x${size.height})`, async ({ page }, testInfo) => {
    const errors = watchConsole(page)
    await page.setViewportSize(size)
    await prepare(page)

    await page.goto('/')
    await classicReady(page)
    const button = await openClassicInterfaceRow(page)
    await expect(button).toBeEnabled()
    await expect(page.locator('#settings-interface-note')).toBeHidden()
    await expect(page.locator('[data-settings-panel="general"]')).toContainText('当前是经典界面')
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    await page.screenshot({ path: testInfo.outputPath(`classic-settings-${size.width}.png`) })

    await button.click()
    await expect(page).toHaveURL(/\/vopus\/(#.*)?$/)
    await vopusReady(page)
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)

    // Remembered: a fresh visit to / opens Vopus; ?ui=classic still opens the classic one.
    expect((await (await page.request.get('/api/interface')).json()).interface).toBe('vopus')
    await page.goto('/')
    await expect(page).toHaveURL(/\/vopus\/(#.*)?$/)
    await vopusReady(page)
    await page.goto('/?ui=classic')
    await classicReady(page)
    await expect(page).toHaveURL(/\/\?ui=classic$/)

    // Vopus Settings › Appearance › Interface › Classic goes back and is remembered.
    await page.goto('/vopus/#/settings/appearance')
    const setting = page.getByTestId('setting-interface')
    await expect(setting).toBeVisible()
    await setting.scrollIntoViewIfNeeded()
    await expect(setting.locator('input[value="vopus"]')).toBeChecked()
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    const panel = await page.getByTestId('settings-page').boundingBox()
    const row = await setting.boundingBox()
    expect(row!.x + row!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 0.5)
    await page.screenshot({ path: testInfo.outputPath(`vopus-settings-${size.width}.png`) })

    await setting.locator('label').filter({ hasText: /^经典界面$/ }).click()
    await expect(page).toHaveURL(/\/$/)
    await classicReady(page)
    expect((await (await page.request.get('/api/interface')).json()).interface).toBe('classic')
    await page.goto('/')
    await classicReady(page)
    await expect(page).toHaveURL(/\/$/)

    expect(errors).toEqual([])
  })
}

test('the entry page catalog opens Vopus through the same switch', async ({ page }) => {
  const errors = watchConsole(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await prepare(page, 'en')
  await page.goto('/')
  await classicReady(page)

  await page.evaluate(() => (window as any).EntryCatalog.open())
  await page.getByText('Vopus interface', { exact: true }).click()
  await expect(page).toHaveURL(/\/vopus\/(#.*)?$/)
  await vopusReady(page)
  expect((await (await page.request.get('/api/interface')).json()).interface).toBe('vopus')
  expect(errors).toEqual([])
})

test('old /v4/ addresses open the same page under /vopus/', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await prepare(page, 'en')
  await page.goto('/v4/#/settings/appearance')
  await expect(page).toHaveURL(/\/vopus\/#\/settings\/appearance$/)
  await expect(page.getByTestId('setting-interface')).toBeVisible()
})

test('without the Vopus build the classic switch is off and says how to get it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await prepare(page, 'en')
  await page.route('**/api/interface', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { interface: 'classic', vopus_built: false } })
      : route.fallback(),
  )
  await page.goto('/')
  await classicReady(page)
  const button = await openClassicInterfaceRow(page)
  await expect(button).toBeDisabled()
  await expect(page.locator('#settings-interface-note')).toBeVisible()
  await expect(page.locator('#settings-interface-note')).toContainText('install Node.js')
})
