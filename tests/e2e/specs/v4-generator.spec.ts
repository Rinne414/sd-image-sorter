import fs from 'node:fs'

import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, dbPath, openLibrary, pageOverflow, repoRoot, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 "Send to generator": the dialog (WebUI / NovelAI text, ComfyUI workflow,
 * run again), its three entrances (right-click menu, the info card, Ctrl K),
 * and the ComfyUI address in Settings and in the dialog.
 *
 * ComfyUI is not running here and nothing is mocked: running the recipe must
 * end in the honest "not reachable" answer. Needs the V4 build:
 * `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })
test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

const TOKEN = 'v4gentoken'
const PREFIX = 'v4gen-'
const DIR = 'v4-gen'
/** Nothing listens on port 1: connecting is refused at once. */
const DEAD = 'http://127.0.0.1:1'

/** Which seeded picture holds what, by file name. */
const FULL = `${PREFIX}00.png` // ComfyUI run recipe + workflow
const RUN_ONLY = `${PREFIX}01.png` // ComfyUI run recipe only
const PLAIN = `${PREFIX}02.png` // a prompt, no ComfyUI
const EMPTY = `${PREFIX}03.png` // nothing recorded

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: 4, dir: DIR })
  runBackendScript(`
import json, sqlite3
from pathlib import Path
from PIL import Image
from PIL.PngImagePlugin import PngInfo
root = Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(DIR)}
api = {"3": {"class_type": "KSampler", "inputs": {"seed": 5, "steps": 20, "model": ["4", 0]}},
       "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "x.safetensors"}}}
workflow = {"nodes": [{"id": 3, "type": "KSampler"}, {"id": 4, "type": "CheckpointLoaderSimple"}], "links": []}
def write(name, with_workflow):
    info = PngInfo()
    info.add_text("prompt", json.dumps(api))
    if with_workflow:
        info.add_text("workflow", json.dumps(workflow))
    Image.new("RGB", (64, 64), (30, 90, 160)).save(root / name, pnginfo=info)
write(${JSON.stringify(FULL)}, True)
write(${JSON.stringify(RUN_ONLY)}, False)
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("UPDATE images SET generator='comfyui' WHERE filename IN (?, ?)", (${JSON.stringify(FULL)}, ${JSON.stringify(RUN_ONLY)}))
    conn.execute("UPDATE images SET prompt='', negative_prompt='', generator='unknown' WHERE filename = ?", (${JSON.stringify(EMPTY)},))
    conn.commit()
print("ok")
`)
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR])
  runBackendScript(`
import sys
sys.path.insert(0, ${JSON.stringify(repoRoot + '/backend')})
import config
config.save_comfyui_url_setting("")
print("ok")
`)
})

async function setLanguage(page: Page, lang: 'en' | 'zh-CN'): Promise<void> {
  await page.evaluate((l) => localStorage.setItem('sd-image-sorter-lang', l), lang)
}

/** The seeded pictures are listed newest first, so file NN is the NNth tile. */
async function openCardMenu(page: Page, name: string) {
  await page.getByTestId('tile').nth(Number(name.slice(PREFIX.length, -4))).click({ button: 'right' })
  return page.getByTestId('card-menu')
}

async function openDialog(page: Page, name: string) {
  const menu = await openCardMenu(page, name)
  // the entry sits in the Copy submenu (the menu is already as tall as a laptop screen allows)
  await menu.getByRole('menuitem', { name: 'Copy', exact: true }).click()
  await page.locator('[data-ctx-sub]').getByRole('menuitem', { name: 'Send to generator…' }).click()
  const dialog = page.getByTestId('generator-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('generator-comfy')).toBeVisible()
  return dialog
}

test('the ComfyUI address is set in Settings, refused when it is wrong, and reset to the default', async ({ page }) => {
  await openLibrary(page, TOKEN, 4)
  await page.goto('/vopus/#/settings/ai')
  const section = page.getByTestId('settings-comfyui')
  await expect(section).toBeVisible()
  const field = section.getByTestId('settings-comfyui-address-input')
  await expect(field).toHaveAttribute('placeholder', 'http://127.0.0.1:8188')
  await expect(section.getByTestId('settings-comfyui-address-note')).toHaveText('Using http://127.0.0.1:8188')

  // a wrong address is refused in words, and the field goes back to what is in force
  await field.fill('ftp://somewhere')
  await field.press('Enter')
  await expect(section.getByTestId('settings-comfyui-address-note')).toContainText('Not saved: The ComfyUI address must start with http:// or https://.')
  await expect(field).toHaveValue('')

  await field.fill(DEAD)
  await field.press('Enter')
  await expect(section.getByTestId('settings-comfyui-address-note')).toHaveText('ComfyUI address saved')
  await expect(section).toContainText('Saved')
  const stored = await page.evaluate(async () => (await (await fetch('/api/settings/comfyui')).json()) as { custom_url: string; url: string })
  expect(stored.custom_url).toBe(DEAD)

  // it survives a reload
  await page.reload()
  await expect(page.getByTestId('settings-comfyui-address-input')).toHaveValue(DEAD)

  await page.getByTestId('settings-comfyui-address-reset').click()
  await expect(page.getByTestId('settings-comfyui-address-input')).toHaveValue('')
  await expect(page.getByTestId('settings-comfyui-address-note')).toHaveText('ComfyUI address saved')
  const reset = await page.evaluate(async () => (await (await fetch('/api/settings/comfyui')).json()) as { custom_url: string })
  expect(reset.custom_url).toBe('')
})

test('the right-click menu opens the recipe: the text to copy, what the picture holds for ComfyUI', async ({ page }) => {
  await openLibrary(page, TOKEN, 4)
  const dialog = await openDialog(page, PLAIN)

  const webui = dialog.getByTestId('generator-webui-text')
  await expect(webui).toContainText('silver hair')
  await expect(webui).toContainText('Negative prompt: lowres')
  await dialog.getByTestId('generator-webui-copy').click()
  await expect(dialog.getByTestId('generator-result')).toContainText('WebUI parameters copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Negative prompt: lowres')

  // a NovelAI picture copies NovelAI's own text, the undesired content labelled
  await expect(dialog.getByTestId('generator-nai-text')).toContainText('Undesired Content: lowres')
  await dialog.getByTestId('generator-nai-copy').click()
  await expect(dialog.getByTestId('generator-result')).toContainText('NovelAI prompt and undesired content copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Undesired Content: lowres')

  // no ComfyUI recipe: said so, and nothing to run or save
  await expect(dialog.getByTestId('generator-comfy-facts')).toHaveText('No ComfyUI recipe in this picture. Use the copy buttons above.')
  await expect(dialog.getByTestId('generator-run')).toHaveCount(0)
  await expect(dialog.getByTestId('generator-save-workflow')).toHaveCount(0)

  // Esc closes the dialog only
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('a picture with no recorded details says there is nothing to send', async ({ page }) => {
  await openLibrary(page, TOKEN, 4)
  const dialog = await openDialog(page, EMPTY)
  await expect(dialog.getByTestId('generator-nothing')).toContainText('records no generation details')
  await expect(dialog.getByTestId('generator-webui-copy')).toBeDisabled()
  await expect(dialog.getByTestId('generator-nai-copy')).toBeDisabled()
  await expect(dialog.getByTestId('generator-webui-empty')).toHaveText('This picture has no prompt to copy')
})

test('running a ComfyUI recipe with ComfyUI not running ends in the honest answer, in both languages', async ({ page }) => {
  await openLibrary(page, TOKEN, 4)
  const dialog = await openDialog(page, FULL)

  await expect(dialog.getByTestId('generator-comfy-facts')).toContainText('full workflow and the recipe to run it')
  await expect(dialog.getByTestId('generator-comfy-facts')).toContainText('Seed fields in the recipe: 1')

  // point the dialog's own address field at a closed port
  const field = dialog.getByTestId('generator-address-input')
  await field.fill(DEAD)
  await field.press('Enter')
  await expect(dialog.getByTestId('generator-address-note')).toHaveText('ComfyUI address saved')
  await expect(dialog.getByTestId('generator-run')).toHaveAttribute('title', `Queue this recipe on ${DEAD}`)

  await dialog.getByTestId('generator-run').click()
  const result = dialog.getByTestId('generator-result')
  await expect(result).toHaveText(`ComfyUI is not reachable at ${DEAD}. Start ComfyUI, or check the address above.`)
  await expect(result).toHaveAttribute('data-tone', 'error')

  // the same sentence in Chinese
  await page.keyboard.press('Escape')
  await setLanguage(page, 'zh-CN')
  await page.reload()
  await page.getByTestId('query-input').fill(TOKEN)
  await page.getByTestId('query-input').press('Enter')
  await expect(page.getByTestId('tile')).toHaveCount(4)
  await page.getByTestId('tile').nth(0).click({ button: 'right' })
  await page.getByTestId('card-menu').getByRole('menuitem', { name: '复制', exact: true }).click()
  await page.locator('[data-ctx-sub]').getByRole('menuitem', { name: '送回生成器…' }).click()
  const zh = page.getByTestId('generator-dialog')
  await zh.getByTestId('generator-run').click()
  await expect(zh.getByTestId('generator-result')).toHaveText(`连不上 ${DEAD} 的 ComfyUI。请先启动 ComfyUI，或检查上面的地址。`)
  await setLanguage(page, 'en')
})

test('the seed choice is remembered, and a picture with only the run recipe cannot copy a workflow', async ({ page }) => {
  await openLibrary(page, TOKEN, 4)
  let dialog = await openDialog(page, RUN_ONLY)
  await expect(dialog.getByTestId('generator-comfy-facts')).toContainText('only the recipe to run')
  await expect(dialog.getByTestId('generator-copy-workflow')).toBeDisabled()
  await expect(dialog.getByTestId('generator-seed-new')).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByTestId('generator-seed-same').click()
  await expect(dialog.getByTestId('generator-seed-same')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')

  dialog = await openDialog(page, RUN_ONLY)
  await expect(dialog.getByTestId('generator-seed-same')).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByTestId('generator-seed-new').click()
})

test('the workflow is copied for the ComfyUI canvas and saved as a .json that says where', async ({ page }) => {
  await openLibrary(page, TOKEN, 4)
  const dialog = await openDialog(page, FULL)

  await dialog.getByTestId('generator-copy-workflow').click()
  await expect(dialog.getByTestId('generator-result')).toContainText('Workflow copied')
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as { nodes: unknown[]; version: unknown }
  expect(copied.nodes).toHaveLength(2)
  expect(copied.version).toBeTruthy()

  const saved = page.waitForResponse((r) => r.url().endsWith('/comfyui/workflow-file') && r.request().method() === 'POST')
  await dialog.getByTestId('generator-save-workflow').click()
  const body = (await (await saved).json()) as { path: string; filename: string }
  try {
    await expect(dialog.getByTestId('generator-result')).toContainText(`Saved ${body.filename} in `)
    expect(fs.existsSync(body.path)).toBe(true)
  } finally {
    fs.rmSync(body.path, { force: true })
  }
})

test('the info card button and Ctrl K reach the same dialog, over the big image too', async ({ page }) => {
  await openLibrary(page, TOKEN, 4)
  const tile = page.getByTestId('tile').nth(0)
  await tile.click()
  const card = page.getByTestId('generation-card')
  await card.getByTestId('card-send-generator').click()
  await expect(page.getByTestId('generator-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('generator-dialog')).toHaveCount(0)

  await page.keyboard.press('Control+k')
  await page.keyboard.type('Send this picture')
  await page.getByRole('option', { name: 'Send this picture to a generator' }).click()
  await expect(page.getByTestId('generator-dialog')).toBeVisible()
  await page.keyboard.press('Escape')

  // over the big image: Esc closes the dialog first, the big image stays
  await page.keyboard.press('Enter')
  const lightbox = page.getByTestId('lightbox')
  await expect(lightbox).toBeVisible()
  const button = lightbox.getByTestId('card-send-generator')
  if (!(await button.isVisible())) await page.keyboard.press('i')
  await button.click()
  await expect(page.getByTestId('generator-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('generator-dialog')).toHaveCount(0)
  await expect(lightbox).toBeVisible()
  await page.keyboard.press('Escape')
})

for (const lang of ['en', 'zh-CN'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`Send to generator fits at ${viewport.width}x${viewport.height} in ${lang}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await openLibrary(page, TOKEN, 4)
      await setLanguage(page, lang)
      await page.reload()
      await page.getByTestId('query-input').fill(TOKEN)
      await page.getByTestId('query-input').press('Enter')
      await expect(page.getByTestId('tile')).toHaveCount(4)
      await page.getByTestId('tile').nth(0).click({ button: 'right' })
      await page.getByTestId('card-menu').getByRole('menuitem', { name: lang === 'en' ? 'Copy' : '复制', exact: true }).click()
      await page.locator('[data-ctx-sub]').getByRole('menuitem', { name: lang === 'en' ? 'Send to generator…' : '送回生成器…' }).click()
      const dialog = page.getByTestId('generator-dialog')
      await expect(dialog.getByTestId('generator-comfy')).toBeVisible()
      // an answer in the footer, the longest case
      await dialog.getByTestId('generator-address-input').fill(DEAD)
      await dialog.getByTestId('generator-address-input').press('Enter')
      await dialog.getByTestId('generator-run').click()
      await expect(dialog.getByTestId('generator-result')).toContainText(lang === 'en' ? 'is not reachable at' : '连不上')

      const box = (await dialog.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
      // the footer (result and Close) is never scrolled out of reach
      const close = (await dialog.getByTestId('generator-close').boundingBox())!
      expect(close.y + close.height).toBeLessThanOrEqual(viewport.height)
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      // nothing inside is wider than the dialog
      const wide = await dialog.evaluate((el) => [...el.querySelectorAll<HTMLElement>('*')].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX === 'visible').map((n) => n.tagName + '.' + n.className))
      expect(wide).toEqual([])
      await page.screenshot({ path: `test-results/v4-generator-${lang}-${viewport.width}.png` })
      await setLanguage(page, 'en')
    })
  }
}
