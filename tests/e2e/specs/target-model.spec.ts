import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Target base-model profiles (standing optimize directive): the LoRA-setup
 * card's model choice drives the recommended caption type (explicit
 * one-click apply, never silent) and the Separation Console token budget
 * (CLIP 75 vs T5/Qwen-VL 512). Profiles are evidence-cited in
 * modules/target-model.js.
 */

test.describe.configure({ mode: 'serial' })

async function seedDatasetQueue(page: Page) {
  await page.route('**/api/image-thumbnail/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/masks/status', async (route) => {
    await route.fulfill({ json: { masks: {} } })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._setActive === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [801, 802]
    dm.meta.set(801, { filename: 'tm-a.png', width: 1024, height: 1024 })
    dm.meta.set(802, { filename: 'tm-b.png', width: 1024, height: 1024 })
    dm.captions.set(801, '1girl, smile')
    dm.captions.set(802, '1girl, frown')
    ;(window as any).App.switchView('dataset')
    dm._setActive(801)
  })
  // The LoRA-setup card (target-model select) lives on the Workbench tab.
  await page.locator('#dataset-tab-workbench').click()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

// The dataset pane wraps native selects in a styled custom dropdown and
// hides the original element, so tests drive the select via evaluate +
// change event (same state path the custom UI uses).
async function chooseTargetModel(page: Page, value: string) {
  await page.evaluate((v) => {
    const select = document.getElementById('dataset-target-model') as HTMLSelectElement
    select.value = v
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

test('choosing Krea 2 shows NL-first guidance and applies NL caption type to all', async ({ page }) => {
  await seedDatasetQueue(page)

  // Visible via its custom-dropdown wrapper (native select stays hidden).
  await expect(
    page.locator('.dataset-custom-dropdown[data-select-id="dataset-target-model"]')
  ).toBeVisible()
  const applyButton = page.locator('#btn-dataset-target-model-apply')
  await expect(applyButton).toBeHidden()

  await chooseTargetModel(page, 'krea2')
  await expect(page.locator('#dataset-target-model-hint')).toContainText('Qwen3-VL')
  await expect(applyButton).toBeVisible()
  await expect(applyButton).toContainText('NL captions')

  await applyButton.click()
  const types = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return [dm._captionTypeFor(801), dm._captionTypeFor(802)]
  })
  expect(types).toEqual(['nl', 'nl'])
})

test('token budget follows the target model (75 CLIP vs 512 Qwen-VL)', async ({ page }) => {
  await seedDatasetQueue(page)

  // A ~90-token caption: over the CLIP budget, far under 512.
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    const long = Array.from({ length: 45 }, (_, i) => `token_word_${i}`).join(', ')
    dm.captions.set(801, long)
    dm._setActive(801)
  })
  await chooseTargetModel(page, 'sdxl')
  await page.locator('#dataset-editor-textarea').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' ')
  await expect(page.locator('#dataset-token-counter')).toHaveClass(/dataset-token-counter-over/)

  await chooseTargetModel(page, 'krea2')
  await page.keyboard.type(' ')
  await expect(page.locator('#dataset-token-counter')).not.toHaveClass(/dataset-token-counter-over/)
})

test('choice persists across reloads', async ({ page }) => {
  await seedDatasetQueue(page)
  await chooseTargetModel(page, 'flux')
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('#dataset-target-model')).toHaveValue('flux')
})
