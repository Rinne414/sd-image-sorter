import { expect, test, type Page } from '../fixtures/click-ledger'

import { pageOverflow, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 Settings > AI: saved VLM prompt presets (save as new, save changes into
 * one of yours, rename, delete with Undo, replace on a name already used) and
 * AI defaults (save, reset with Undo, in V3.5's own storage keys).
 *
 * The preset routes are the REAL backend's (its data folder is the test
 * run's own); everything else under /api/vlm/ is answered here so nothing can
 * reach a paid API, Ollama or a download. Also used for /next/ (same page).
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const NAMES = ['E2E Cat captions', 'E2E Cat renamed', 'E2E Zh preset', 'E2E 角色描述']
const TAGGER_KEY = 'sd-image-sorter-tagger-defaults-v1'
const ARTIST_KEY = 'sd-image-sorter-artist-defaults-v1'

interface Listed {
  presets: Record<string, { id: string; name: string; builtin?: boolean; system_prompt?: string; user_prompt?: string }>
}

async function ownPresets(page: Page): Promise<Listed['presets']> {
  const body = (await (await page.request.get('/api/vlm/presets')).json()) as Listed
  return Object.fromEntries(Object.entries(body.presets).filter(([, p]) => p.builtin === false))
}

async function removeOwnPresets(page: Page): Promise<void> {
  for (const id of Object.keys(await ownPresets(page))) await page.request.delete(`/api/vlm/presets/${id}`)
}

async function stubVlm(page: Page) {
  await page.route('**/api/vlm/**', (route) => route.fulfill({ status: 500, json: { detail: `not stubbed: ${new URL(route.request().url()).pathname}` } }))
  await page.route('**/api/vlm/settings', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/vlm/local-models/recommended', (route) =>
    route.fulfill({ json: { ollama_installed: false, ollama_running: false, install_instructions: null, models: [], local_models: [] } }),
  )
  await page.route('**/api/vlm/caption-batch/debug-chat', (route) => route.fulfill({ json: { events: [], limit: 80, running: false } }))
  // the presets are the real ones
  await page.route(/\/api\/vlm\/presets/, (route) => route.continue())
}

async function open(page: Page, ui: 'vopus' | 'next', lang: 'en' | 'zh-CN', seed: Record<string, string> = {}) {
  await stubVlm(page)
  await page.addInitScript(
    ([l, extra]) => {
      // once per tab: a reload (or Reset all settings) must keep what the test changed
      if (sessionStorage.getItem('e2e-seeded')) return
      sessionStorage.setItem('e2e-seeded', '1')
      localStorage.setItem('sd-image-sorter-lang', l as string)
      localStorage.setItem('sd-v4-theme', 'dark')
      localStorage.setItem('sd-v4-update-autocheck', '0')
      for (const [k, v] of Object.entries(extra as Record<string, string>)) localStorage.setItem(k, v)
    },
    [lang, seed] as const,
  )
  const res = await page.goto(`/${ui}/#/settings/ai`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('ai-services')).toBeVisible()
}

test.beforeAll(async ({ request }) => {
  const body = (await (await request.get('/api/vlm/presets')).json()) as Listed
  for (const [id, p] of Object.entries(body.presets)) if (p.builtin === false && NAMES.includes(p.name)) await request.delete(`/api/vlm/presets/${id}`)
})

test.afterEach(async ({ page }) => {
  if (page.url().includes('/settings/ai')) await removeOwnPresets(page).catch(() => undefined)
})

test('save, change, rename, replace and delete a preset (English)', async ({ page }) => {
  await open(page, 'vopus', 'en')
  const select = page.getByTestId('vlm-preset')
  const note = page.getByTestId('vlm-preset-note')

  // a built-in preset is read-only: it can be saved from, not renamed or deleted
  await expect(select.locator('optgroup[label="Built-in presets"]')).toBeAttached()
  await select.selectOption('lora_training')
  await expect(page.getByTestId('vlm-preset-save-as')).toBeVisible()
  await expect(page.getByTestId('vlm-preset-rename')).toHaveCount(0)
  await expect(page.getByTestId('vlm-preset-delete')).toHaveCount(0)

  // the prompts in the boxes become a new preset, named by the user
  await page.getByTestId('vlm-system').fill('You caption cats.')
  await page.getByTestId('vlm-user').fill('Describe the cat.')
  await page.getByTestId('vlm-preset-save-as').click()
  await expect(page.getByTestId('vlm-preset-name')).toBeFocused()
  await page.getByTestId('vlm-preset-name').fill('   ')
  await page.getByTestId('vlm-preset-name-ok').click()
  await expect(note).toHaveText('Type a name for the preset.')
  await page.getByTestId('vlm-preset-name').fill('E2E Cat captions')
  await page.getByTestId('vlm-preset-name').press('Enter')
  await expect(note).toHaveText('Saved as “E2E Cat captions”.')
  await expect(page.getByTestId('vlm-preset-name-row')).toHaveCount(0)
  const mine = page.getByTestId('vlm-preset-mine')
  await expect(mine.locator('option')).toHaveText(['E2E Cat captions'])
  const id = await select.inputValue()
  expect(id).toMatch(/^custom-/)
  expect((await ownPresets(page))[id]).toMatchObject({ name: 'E2E Cat captions', system_prompt: 'You caption cats.', user_prompt: 'Describe the cat.' })

  // editing the boxes marks it, and the edits can be saved back into it
  await expect(page.getByTestId('vlm-preset-save')).toHaveCount(0)
  await page.getByTestId('vlm-system').fill('You caption cats in one sentence.')
  await expect(mine.locator('option')).toHaveText(['E2E Cat captions (edited)'])
  await page.getByTestId('vlm-preset-save').click()
  await expect(note).toHaveText('Saved the changes to “E2E Cat captions”.')
  await expect(page.getByTestId('vlm-preset-save')).toHaveCount(0)
  expect((await ownPresets(page))[id]?.system_prompt).toBe('You caption cats in one sentence.')

  // rename; Esc closes the name field only
  await page.getByTestId('vlm-preset-rename').click()
  await expect(page.getByTestId('vlm-preset-name')).toHaveValue('E2E Cat captions')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('vlm-preset-name-row')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/settings\/ai/)
  await page.getByTestId('vlm-preset-rename').click()
  await page.getByTestId('vlm-preset-name').fill('E2E Cat renamed')
  await page.getByTestId('vlm-preset-name-ok').click()
  await expect(note).toHaveText('Renamed to “E2E Cat renamed”.')
  expect((await ownPresets(page))[id]?.name).toBe('E2E Cat renamed')

  // a name already used asks in place before replacing (focus on Cancel)
  await page.getByTestId('vlm-system').fill('Replacement prompt.')
  await page.getByTestId('vlm-preset-save-as').click()
  await page.getByTestId('vlm-preset-name').fill('e2e cat  RENAMED')
  await page.getByTestId('vlm-preset-name-ok').click()
  const replace = page.getByTestId('vlm-preset-replace')
  await expect(replace).toContainText('You already have a preset called “E2E Cat renamed”.')
  await expect(page.getByTestId('vlm-preset-replace-cancel')).toBeFocused()
  await page.getByTestId('vlm-preset-replace-cancel').click()
  await expect(replace).toHaveCount(0)
  await expect(page.getByTestId('vlm-preset-name')).toHaveValue('e2e cat  RENAMED')
  expect((await ownPresets(page))[id]?.system_prompt).toBe('You caption cats in one sentence.')
  await page.getByTestId('vlm-preset-name-ok').click()
  await page.getByTestId('vlm-preset-replace-yes').click()
  await expect(note).toHaveText('Saved the changes to “E2E Cat renamed”.')
  expect((await ownPresets(page))[id]?.system_prompt).toBe('Replacement prompt.')
  expect(Object.keys(await ownPresets(page))).toEqual([id])

  // delete keeps the prompts in the boxes; Undo brings the same preset back
  await page.getByTestId('vlm-preset-delete').click()
  await expect(note).toHaveText('Deleted “E2E Cat renamed”. The prompts stay in the boxes below.')
  await expect(page.getByTestId('vlm-system')).toHaveValue('Replacement prompt.')
  await expect(page.getByTestId('vlm-preset-mine')).toHaveCount(0)
  expect(await ownPresets(page)).toEqual({})
  await page.getByTestId('vlm-preset-undo').click()
  await expect(note).toHaveText('“E2E Cat renamed” is back.')
  expect((await ownPresets(page))[id]).toMatchObject({ name: 'E2E Cat renamed', system_prompt: 'Replacement prompt.' })
  await expect(select).toHaveValue(id)

  // it is still there after a reload, and applying it fills the boxes (Undo puts the typing back)
  await page.reload()
  await expect(page.getByTestId('ai-services')).toBeVisible()
  await expect(page.getByTestId('vlm-preset-mine').locator('option')).toHaveText(['E2E Cat renamed'])
  await page.getByTestId('vlm-system').fill('typed after the reload')
  await select.selectOption(id)
  await page.getByTestId('vlm-preset-apply').click()
  await expect(page.getByTestId('vlm-system')).toHaveValue('Replacement prompt.')
  await page.getByTestId('vlm-preset-undo').click()
  await expect(page.getByTestId('vlm-system')).toHaveValue('typed after the reload')
  await expect(note).toHaveText('Your earlier prompts are back.')
})

test('Undo of an applied preset steps aside once the prompts are typed in again', async ({ page }) => {
  await open(page, 'vopus', 'en')
  await page.getByTestId('vlm-preset').selectOption('lora_training')
  await page.getByTestId('vlm-preset-apply').click()
  await expect(page.getByTestId('vlm-preset-undo')).toBeVisible()
  await page.getByTestId('vlm-user').fill('typed')
  await expect(page.getByTestId('vlm-preset-undo')).toHaveCount(0)
})

test('saving a preset works in Chinese, and /next/ has the same page', async ({ page }) => {
  await open(page, 'next', 'zh-CN')
  await page.getByTestId('vlm-system').fill('你给图片写描述。')
  await page.getByTestId('vlm-preset-save-as').click()
  await expect(page.getByTestId('vlm-preset-name-ok')).toHaveText('保存预设')
  await page.getByTestId('vlm-preset-name').fill('E2E 角色描述')
  await page.getByTestId('vlm-preset-name-ok').click()
  await expect(page.getByTestId('vlm-preset-note')).toHaveText('已保存为「E2E 角色描述」。')
  await expect(page.getByTestId('vlm-preset-mine')).toHaveAttribute('label', '我的预设')
  await page.getByTestId('vlm-preset-delete').click()
  await expect(page.getByTestId('vlm-preset-note')).toHaveText('已删除「E2E 角色描述」。提示词还留在下面的输入框里。')
  await expect(page.getByTestId('vlm-preset-undo')).toHaveText('撤销')
})

test('AI defaults: save the tagger and style finder settings, reset them, take the reset back', async ({ page }) => {
  await open(page, 'vopus', 'en', { [ARTIST_KEY]: JSON.stringify({ version: 1, modelSource: 'modelscope', modelPath: '', threshold: 0.1, useGpu: false }) })
  const tagger = page.getByTestId('ai-defaults-tagger')
  const note = page.getByTestId('ai-defaults-note')
  await expect(tagger).toHaveText('Tagger: no defaults saved yet.')
  await expect(page.getByTestId('ai-defaults-artist')).toHaveText('Style finder: ModelScope mirror · Threshold 0.10 · CPU')

  await page.getByTestId('ai-defaults-save').click()
  await expect(note).toHaveText('AI defaults saved.')
  const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), TAGGER_KEY)
  expect(saved).toMatchObject({ version: 1 })
  expect(typeof saved.modelName).toBe('string')
  expect(saved.modelName.length).toBeGreaterThan(0)
  expect(saved.threshold).toBeGreaterThanOrEqual(0)
  expect(saved.threshold).toBeLessThanOrEqual(1)
  await expect(tagger).toContainText(`Tagger: ${saved.modelName} · General`)
  expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), ARTIST_KEY)).toMatchObject({ modelSource: 'modelscope', threshold: 0.1, useGpu: false })

  // reset: both are gone and the style finder is back to its own settings
  await page.getByTestId('ai-defaults-reset').click()
  await expect(note).toHaveText('AI defaults reset: the tagger and the style finder are back to the program’s own settings.')
  await expect(tagger).toHaveText('Tagger: no defaults saved yet.')
  await expect(page.getByTestId('ai-defaults-artist')).toHaveText('Style finder: no defaults saved yet.')
  expect(await page.evaluate(([a, b]) => [localStorage.getItem(a as string), localStorage.getItem(b as string)], [TAGGER_KEY, ARTIST_KEY])).toEqual([null, null])

  // Undo brings the earlier settings back
  await page.getByTestId('ai-defaults-undo').click()
  await expect(note).toHaveText('Your earlier settings are back.')
  await expect(tagger).toContainText(`Tagger: ${saved.modelName} · General`)
  await expect(page.getByTestId('ai-defaults-artist')).toHaveText('Style finder: ModelScope mirror · Threshold 0.10 · CPU')
  await expect(page.getByTestId('ai-defaults-undo')).toHaveCount(0)
})

test('tagger defaults saved by V3.5 show up here, and Reset all settings removes them', async ({ page }) => {
  const defaults = { version: 1, modelName: 'camie-tagger-v2', threshold: 0.4, characterThreshold: 0.7, useGpu: false, batchSize: '', customProfile: '', customModelPath: '', customTagsPath: '' }
  await open(page, 'vopus', 'en', { [TAGGER_KEY]: JSON.stringify(defaults) })
  await expect(page.getByTestId('ai-defaults-tagger')).toHaveText('Tagger: camie-tagger-v2 · General 0.40 · Character 0.70 · CPU')
  await page.goto('/vopus/#/settings/appearance')
  await page.getByTestId('reset-all-open').click()
  await page.getByTestId('reset-all-ok').click()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), TAGGER_KEY)).toBeNull()
})

for (const ui of ['vopus', 'next'] as const) {
  for (const viewport of VIEWPORTS) {
    for (const lang of ['en', 'zh-CN'] as const) {
      test(`presets and AI defaults fit at ${viewport.width}x${viewport.height} (${ui}, ${lang})`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await open(page, ui, lang)
        await page.getByTestId('vlm-system').fill('x')
        await page.getByTestId('vlm-preset-save-as').click()
        await page.getByTestId('vlm-preset-name').fill('E2E Cat captions')
        await page.getByTestId('vlm-preset-name-ok').click()
        await expect(page.getByTestId('vlm-preset-delete')).toBeVisible()
        await page.getByTestId('vlm-system').fill('changed')
        await page.getByTestId('vlm-preset-save-as').click()
        await page.getByTestId('vlm-preset-name').fill('e2e cat captions')
        await page.getByTestId('vlm-preset-name-ok').click()
        await expect(page.getByTestId('vlm-preset-replace')).toBeVisible()
        for (const id of ['vlm-preset-actions', 'vlm-preset-replace']) {
          const box = await page.getByTestId(id).boundingBox()
          expect(box, id).not.toBeNull()
          expect(box!.x + box!.width, `${id} fits the width`).toBeLessThanOrEqual(viewport.width)
        }
        expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
        await page.getByTestId('ai-defaults-save').scrollIntoViewIfNeeded()
        await page.getByTestId('ai-defaults-save').click()
        await page.getByTestId('ai-defaults-reset').click()
        await expect(page.getByTestId('ai-defaults-undo')).toBeVisible()
        const content = await page.evaluate(() => {
          const main = document.querySelector('[data-testid="settings-ai"]') as HTMLElement
          return main.scrollWidth - main.clientWidth
        })
        expect(content).toBeLessThanOrEqual(0)
        expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      })
    }
  }
}
