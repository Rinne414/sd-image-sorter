import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Target base-model profiles (standing optimize directive): the LoRA-setup
 * card's model choice drives the recommended caption type (explicit
 * one-click apply, never silent) and the Separation Console token budget
 * (CLIP 75 vs T5/Qwen-VL 512). Profiles are evidence-cited in
 * modules/target-model.js.
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1366, height: 768 } })

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

async function chooseTagBaseModel(page: Page, value: string) {
  await page.evaluate((preset) => {
    const select = document.getElementById('tag-base-model') as HTMLSelectElement
    select.value = preset
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
  const hint = page.locator('#dataset-target-model-hint')
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('Qwen3-VL')
  await expect(hint).toContainText('krea/Krea-2-Raw')
  await expect(hint).toContainText('Turbo')
  await expect(hint).toContainText('inference')
  await expect(hint).not.toContainText('no trigger word needed')
  await expect(applyButton).toBeVisible()
  await expect(applyButton).toContainText('NL captions')

  const captionHelp = page.locator('.dataset-editor-help-body')
  await expect(captionHelp).toContainText('reviewed, factual long natural-language caption')
  await expect(captionHelp).toContainText('machine tags are cues, not ground truth')
  await expect(captionHelp).toContainText('does not prescribe a trigger convention')
  await expect(captionHelp).not.toContainText('a few short tags')
  await expect(captionHelp).not.toContainText('DO include your trigger word once')

  await applyButton.click()
  const types = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return [dm._captionTypeFor(801), dm._captionTypeFor(802)]
  })
  expect(types).toEqual(['nl', 'nl'])

  const kreaTagPreset = await page.locator('#tag-base-model').evaluate((select) => {
    const option = Array.from((select as HTMLSelectElement).options).find((item) => item.value === 'krea2')
    return {
      label: option?.textContent ?? '',
      maxTags: (window as any).TagPower?.MAX_TAGS_BY_PRESET?.krea2,
    }
  })
  expect(kreaTagPreset.label).toContain('tags for search/review')
  expect(kreaTagPreset.label).not.toContain('200')
  expect(kreaTagPreset.maxTags).toBeUndefined()

  await chooseTargetModel(page, 'sdxl')
  await expect(captionHelp).toContainText('a few short tags')
  await expect(captionHelp).toContainText('DO include your trigger word once')
  await expect(captionHelp).not.toContainText('Krea-2-Raw')
})

test('Krea apply on an empty queue shows one warning and no success', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._setActive === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.locator('#dataset-tab-workbench').click()
  await chooseTargetModel(page, 'krea2')

  await page.locator('#btn-dataset-target-model-apply').click()

  const toastContainer = page.locator('#toast-container')
  await expect(toastContainer.locator('.toast')).toHaveCount(1)
  await expect(toastContainer.locator('.toast.warning')).toHaveCount(1)
  await expect(toastContainer.locator('.toast.success')).toHaveCount(0)
})

test('Krea guidance relocalizes and fits the 1366 desktop setup column', async ({ page }) => {
  await seedDatasetQueue(page)
  await chooseTargetModel(page, 'krea2')

  const field = page.locator('.dataset-target-model-field')
  const hint = page.locator('#dataset-target-model-hint')
  const applyButton = page.locator('#btn-dataset-target-model-apply')
  await expect(hint).toContainText('Train LoRAs on krea/Krea-2-Raw')

  await page.evaluate(() => (window as any).I18n.setLang('zh-CN'))

  await expect(hint).toContainText('LoRA 请在 krea/Krea-2-Raw 上训练')
  await expect(applyButton).toContainText('全部图片设为自然语言 caption')
  const layout = await field.evaluate((element) => {
    const hintElement = document.getElementById('dataset-target-model-hint')
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      hintWidth: hintElement?.getBoundingClientRect().width ?? 0,
    }
  })
  expect(layout.hintWidth).toBeGreaterThanOrEqual(200)
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)
})

test('max-tags follows base-model suggestions until the user edits it', async ({ page }) => {
  await seedDatasetQueue(page)
  const maxTags = page.locator('#tag-max-tags-per-image')

  await chooseTagBaseModel(page, 'sdxl')
  await expect(maxTags).toHaveValue('50')

  await chooseTagBaseModel(page, 'flux')
  await expect(maxTags).toHaveValue('120')

  await chooseTagBaseModel(page, 'krea2')
  await expect(maxTags).toHaveValue('0')
  await expect(maxTags).toHaveAttribute('placeholder', '0 = unlimited')

  await page.evaluate(() => {
    const input = document.getElementById('tag-max-tags-per-image') as HTMLInputElement
    input.value = '37'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await chooseTagBaseModel(page, 'sdxl')
  await expect(maxTags).toHaveValue('37')

  await page.evaluate(() => {
    const input = document.getElementById('tag-max-tags-per-image') as HTMLInputElement
    input.dataset.userTouched = 'false'
  })
  await chooseTagBaseModel(page, 'flux')
  await expect(maxTags).toHaveValue('120')
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
test('steps estimator: kohya math, live inputs, hidden when queue empty', async ({ page }) => {
  await seedDatasetQueue(page)
  // The estimator lives in the export card — visible on the Export tab.
  await page.locator('#dataset-tab-export').click()
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.meta.set(801, { ...dm.meta.get(801), file_size: 3 * 1024 * 1024 })
    dm.meta.set(802, { ...dm.meta.get(802), file_size: 2 * 1024 * 1024 })
    ;(window as any).DatasetEstimator.refresh()
  })
  const line = page.locator('#dataset-steps-line')
  await expect(page.locator('#dataset-steps-estimator')).toBeVisible()
  // 2 images x 10 repeats / batch 2 = 10 steps/epoch x 10 epochs = 100.
  await expect(line).toContainText('2 images')
  await expect(line).toContainText('5 MB')
  await expect(line).toContainText('100 steps')

  await page.locator('#dataset-est-batch').fill('1')
  // 2 x 10 / 1 = 20 x 10 = 200.
  await expect(line).toContainText('200 steps')

  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = []
    ;(window as any).DatasetEstimator.refresh()
  })
  await expect(page.locator('#dataset-steps-estimator')).toBeHidden()
})
