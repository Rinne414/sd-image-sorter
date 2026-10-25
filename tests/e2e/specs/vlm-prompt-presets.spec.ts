import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

/**
 * GitHub issue #21: users add, change, rename and delete their own VLM prompt
 * presets (custom system prompts) in VLM captioning settings. Saved presets
 * come after the built-in ones, survive a reload, and deleting one or applying
 * a preset over typed prompts can be undone. The prompt used for pictures that
 * already have tags is a visible box instead of a hidden value.
 *
 * Runs against the real backend; each test starts with no saved presets and
 * puts the VLM prompt settings back afterwards.
 */

test.use({ viewport: { width: 1366, height: 768 } })
test.describe.configure({ mode: 'serial' })

const PROMPT_SETTING_KEYS = [
  'system_prompt', 'user_prompt', 'user_prompt_with_tags', 'output_format',
  'include_tags_as_context', 'prompt_preset_id',
] as const

let savedPromptSettings: Record<string, unknown> = {}

async function deleteSavedPresets(request: APIRequestContext) {
  const listing = await (await request.get('/api/vlm/presets')).json()
  for (const preset of Object.values<any>(listing.presets)) {
    if (preset.builtin === false) await request.delete(`/api/vlm/presets/${preset.id}`)
  }
}

async function openPromptSettings(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => Boolean((window as any).App?.showModal && (window as any).VLMCaption?.loadPresets))
  await page.evaluate(() => (window as any).VLMCaption.openSettingsModal())
  await expect(page.locator('#vlm-settings-modal')).toHaveClass(/visible/)
  await expect(page.locator('#vlm-preset-select optgroup').first()).toBeAttached()
}

const presetSelect = (page: Page) => page.locator('#vlm-preset-select')
const status = (page: Page) => page.locator('#vlm-preset-status-text')

async function saveAsNew(page: Page, name: string) {
  await page.locator('#btn-vlm-preset-save-as').click()
  await expect(page.locator('#vlm-preset-name-row')).toBeVisible()
  await page.locator('#vlm-preset-name').fill(name)
  await page.locator('#vlm-preset-name').press('Enter')
}

test.beforeEach(async ({ request }) => {
  await deleteSavedPresets(request)
  const settings = await (await request.get('/api/vlm/settings')).json()
  savedPromptSettings = Object.fromEntries(
    PROMPT_SETTING_KEYS.filter((key) => key in settings).map((key) => [key, settings[key]]),
  )
})

test.afterEach(async ({ request }) => {
  await deleteSavedPresets(request)
  await request.post('/api/vlm/settings', {
    data: { system_prompt: '', user_prompt: '', user_prompt_with_tags: '', prompt_preset_id: '', ...savedPromptSettings },
  })
})

test('the list shows every built-in preset, Krea 2 included, and the actions for built-ins', async ({ page }) => {
  await openPromptSettings(page)

  const builtinValues = await page.locator('#vlm-preset-select optgroup').first().locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
  expect(builtinValues).toEqual(expect.arrayContaining([
    'lora_training', 'anima_flux', 'krea2_long_nl', 'short_caption', 'character_lora',
    'nsfw_relaxed', 'vlm_danbooru', 'vlm_hybrid',
  ]))

  await presetSelect(page).selectOption('short_caption')
  await expect(page.locator('#btn-vlm-preset-save-as')).toBeVisible()
  await expect(page.locator('#btn-vlm-preset-save')).toBeHidden()
  await expect(page.locator('#btn-vlm-preset-rename')).toBeHidden()
  await expect(page.locator('#btn-vlm-preset-delete')).toBeHidden()
})

test('save the prompts as a preset, change it, rename it, delete it and undo the delete', async ({ page }) => {
  await openPromptSettings(page)
  await page.locator('#vlm-system-prompt').fill('You caption pictures of my cat.')
  await page.locator('#vlm-user-prompt').fill('Describe the cat in one sentence.')

  await saveAsNew(page, 'Cat LoRA')

  await expect(status(page)).toHaveText('Saved as “Cat LoRA”.')
  await expect(page.locator('#vlm-preset-name-row')).toBeHidden()
  const presetId = await presetSelect(page).inputValue()
  expect(presetId).toMatch(/^custom-[0-9a-f]+$/)
  await expect(page.locator('#vlm-preset-select optgroup').nth(1).locator('option')).toHaveText(['Cat LoRA'])
  await expect(page.locator('#btn-vlm-preset-save')).toBeHidden()

  await page.locator('#vlm-system-prompt').fill('You caption pictures of my cat, briefly.')
  await expect(page.locator('#btn-vlm-preset-save')).toBeVisible()
  await expect(presetSelect(page).locator('option:checked')).toHaveText('Cat LoRA (edited)')
  await page.locator('#btn-vlm-preset-save').click()
  await expect(status(page)).toHaveText('Saved the changes to “Cat LoRA”.')
  await expect(page.locator('#btn-vlm-preset-save')).toBeHidden()

  await page.locator('#btn-vlm-preset-rename').click()
  await expect(page.locator('#vlm-preset-name')).toHaveValue('Cat LoRA')
  await page.locator('#vlm-preset-name').fill('Cat LoRA v2')
  await page.locator('#btn-vlm-preset-name-ok').click()
  await expect(status(page)).toHaveText('Renamed to “Cat LoRA v2”.')
  await expect(presetSelect(page).locator('option:checked')).toHaveText('Cat LoRA v2')

  await page.locator('#btn-vlm-preset-delete').click()
  await expect(status(page)).toHaveText('Deleted “Cat LoRA v2”. The prompts stay in the boxes.')
  await expect(presetSelect(page).locator(`option[value="${presetId}"]`)).toHaveCount(0)
  await expect(page.locator('#vlm-system-prompt')).toHaveValue('You caption pictures of my cat, briefly.')

  await page.locator('#btn-vlm-preset-undo').click()
  await expect(status(page)).toHaveText('“Cat LoRA v2” is back.')
  await expect(presetSelect(page)).toHaveValue(presetId)

  // Saved in the program, not in the page: it is still there after a reload.
  await page.reload()
  await page.waitForFunction(() => Boolean((window as any).VLMCaption?.loadPresets))
  await page.evaluate(() => (window as any).VLMCaption.openSettingsModal())
  await expect(presetSelect(page).locator(`option[value="${presetId}"]`)).toHaveText('Cat LoRA v2')
  await presetSelect(page).selectOption(presetId)
  await expect(page.locator('#vlm-system-prompt')).toHaveValue('You caption pictures of my cat, briefly.')
  await expect(page.locator('#vlm-user-prompt')).toHaveValue('Describe the cat in one sentence.')
})

test('applying a preset over typed prompts can be undone', async ({ page }) => {
  await openPromptSettings(page)
  await page.locator('#vlm-system-prompt').fill('My own hand-written system prompt.')

  await presetSelect(page).selectOption('short_caption')
  await expect(page.locator('#vlm-system-prompt')).not.toHaveValue('My own hand-written system prompt.')
  await page.locator('#btn-vlm-preset-undo').click()

  await expect(page.locator('#vlm-system-prompt')).toHaveValue('My own hand-written system prompt.')
  await expect(status(page)).toHaveText('Your earlier prompts are back.')
})

test('a name already in use asks before replacing that preset', async ({ page }) => {
  await openPromptSettings(page)
  await page.locator('#vlm-system-prompt').fill('First version.')
  await saveAsNew(page, 'Shared name')
  await expect(status(page)).toHaveText('Saved as “Shared name”.')

  await page.locator('#vlm-system-prompt').fill('Second version.')
  await saveAsNew(page, 'shared NAME')

  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await expect(page.locator('#confirm-message')).toContainText('“Shared name”')
  await page.locator('#btn-confirm-ok').click()
  await expect(status(page)).toHaveText('Saved the changes to “Shared name”.')
  const listing = await (await page.request.get('/api/vlm/presets')).json()
  const mine = Object.values<any>(listing.presets).filter((preset) => preset.builtin === false)
  expect(mine.map((preset) => [preset.name, preset.system_prompt])).toEqual([['Shared name', 'Second version.']])
})

test('Escape in the name field closes only the name field', async ({ page }) => {
  await openPromptSettings(page)
  await page.locator('#btn-vlm-preset-save-as').click()
  await expect(page.locator('#vlm-preset-name')).toBeFocused()

  await page.keyboard.press('Escape')

  await expect(page.locator('#vlm-preset-name-row')).toBeHidden()
  await expect(page.locator('#vlm-settings-modal')).toHaveClass(/visible/)
})

test('the tags prompt is a visible box that follows the include-tags switch, and the dialog reopens on the chosen preset', async ({ page }) => {
  await openPromptSettings(page)
  await page.locator('#vlm-include-tags').check()
  await expect(page.locator('#vlm-user-prompt-with-tags')).toBeVisible()
  await page.locator('#vlm-include-tags').uncheck()
  await expect(page.locator('#vlm-user-prompt-with-tags')).toBeHidden()
  await page.locator('#vlm-include-tags').check()

  await page.locator('#vlm-user-prompt-with-tags').fill('Tags: {tags}. Describe the scene.')
  await saveAsNew(page, 'Scene with tags')
  await expect(status(page)).toHaveText('Saved as “Scene with tags”.')
  const presetId = await presetSelect(page).inputValue()
  await page.locator('#btn-vlm-save-settings').click()
  await expect(page.locator('#vlm-status')).toHaveClass(/vlm-status-success/)

  const settings = await (await page.request.get('/api/vlm/settings')).json()
  expect(settings.prompt_preset_id).toBe(presetId)
  expect(settings.user_prompt_with_tags).toBe('Tags: {tags}. Describe the scene.')

  await page.reload()
  await page.waitForFunction(() => Boolean((window as any).VLMCaption?.loadPresets))
  await page.evaluate(async () => {
    const V = (window as any).VLMCaption
    await V.loadSettings()
    V.openSettingsModal()
  })
  await expect(presetSelect(page)).toHaveValue(presetId)
  await expect(page.locator('#vlm-user-prompt-with-tags')).toHaveValue('Tags: {tags}. Describe the scene.')
})
