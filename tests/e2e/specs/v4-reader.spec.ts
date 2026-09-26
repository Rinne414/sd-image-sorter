import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, dbPath, openLibrary, pageOverflow, repoRoot, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 Reader (读图): an image brought in by a real drop, the file picker or a
 * real paste (a ClipboardEvent on the page as the user sees it) shows every
 * section of its generation details; a library image is read from the
 * database (never uploaded); edits are saved as a new image (the new file is
 * parsed again to prove it) and a library image's own file can be overwritten
 * and undone. Every file written lives under .tmp/ (a seeded copy), never a
 * real library. Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })
test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

const TOKEN = 'v4readertoken'
const PREFIX = 'v4reader-lib-'
const COUNT = 2
const DIR = 'v4-reader'
const SAMPLES = path.join(tmpRoot, DIR, 'samples')
const OUT = path.join(tmpRoot, DIR, 'out')
const LIBRARY_COPY = path.join(tmpRoot, DIR, `${PREFIX}00.png`)
const sample = (name: 'comfyui' | 'a1111' | 'nai' | 'webp') => path.join(SAMPLES, name === 'webp' ? 'v4reader-webp.webp' : `v4reader-${name}.png`)
const NO_METADATA = path.join(repoRoot, 'tests', 'e2e', 'fixtures', 'no-metadata-screenshot.png')

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  runBackendScript(`
import runpy, sys
sys.argv = ["v4_reader_samples.py", "--images", ${JSON.stringify(SAMPLES)}]
runpy.run_path(${JSON.stringify(path.join(repoRoot, 'tests', 'e2e', 'fixtures', 'v4_reader_samples.py'))}, run_name="__main__")
`)
  fs.mkdirSync(OUT, { recursive: true })
  // Library row 00 becomes a copy of the A1111 sample: a real file the Reader may overwrite.
  fs.copyFileSync(sample('a1111'), LIBRARY_COPY)
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR])
})

async function openReader(page: Page) {
  await markModelsReady(page)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('v4reader-init')) return
    sessionStorage.setItem('v4reader-init', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.removeItem('sd-v4-reader-folds')
    localStorage.removeItem('sd-v4-reader-save-dir')
  })
  const res = await page.goto('/v4/#/tools/reader', { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('reader-page')).toBeVisible()
}

/** A real drop: drag events carrying the file, dispatched on the page. */
async function dropFile(page: Page, file: string, type: string) {
  const dt = await page.evaluateHandle(
    ({ b64, name, mime }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], name, { type: mime }))
      return data
    },
    { b64: fs.readFileSync(file).toString('base64'), name: path.basename(file), mime: type },
  )
  await page.dispatchEvent('[data-testid="reader-page"]', 'dragenter', { dataTransfer: dt })
  await expect(page.getByTestId('intake-drop-overlay')).toBeVisible()
  await page.dispatchEvent('[data-testid="reader-page"]', 'drop', { dataTransfer: dt })
  await expect(page.getByTestId('intake-drop-overlay')).toHaveCount(0)
  await expect(page.getByTestId('reader-file-name')).toHaveText(path.basename(file))
}

/** A real paste: a ClipboardEvent carrying the file, on the page as it is shown. */
async function pasteFile(page: Page, file: string) {
  await page.evaluate(
    ({ b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    },
    { b64: fs.readFileSync(file).toString('base64') },
  )
}

const libraryId = () =>
  Number(
    runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    print(conn.execute("SELECT id FROM images WHERE filename = ?", (${JSON.stringify(`${PREFIX}00.png`)},)).fetchone()[0])
`),
  )

/** Re-read row 00 from its (A1111) file through the server, and keep it findable by the spec's token. */
async function readLibraryCopy(page: Page): Promise<number> {
  const id = libraryId()
  const res = await page.request.post(`/api/images/${id}/reparse`, { headers: { 'X-SD-Library-Id': 'main' } })
  expect(res.ok(), await res.text()).toBe(true)
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)", (${id}, ${JSON.stringify(TOKEN)}))
    conn.commit()
print("ok")
`)
  return id
}

async function seedOf(page: Page, id: number): Promise<unknown> {
  const detail = (await (await page.request.get(`/api/images/${id}`, { headers: { 'X-SD-Library-Id': 'main' } })).json()) as { image: { metadata_json: string } }
  return (JSON.parse(detail.image.metadata_json) as { _parsed: { generation_params: { seed: unknown } } })._parsed.generation_params.seed
}

test('every format brought in shows its sections', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openReader(page)
  await expect(page.getByTestId('intake-zone')).toBeVisible()

  // ComfyUI, dropped: model, LoRA strengths, the graph's prompt nodes
  await dropFile(page, sample('comfyui'), 'image/png')
  await expect(page.getByTestId('reader-generator')).toHaveText('ComfyUI')
  await expect(page.getByTestId('reader-prompt')).toContainText('v4reader comfy prompt')
  await expect(page.getByTestId('reader-negative')).toContainText('v4reader comfy negative')
  await expect(page.getByTestId('reader-checkpoint-name')).toHaveText('v4reader_comfy_model')
  await expect(page.getByTestId('reader-lora')).toContainText('0.8 / 0.6')
  await expect(page.getByTestId('card-nodes')).toBeVisible()
  await expect(page.getByTestId('reader-params')).toContainText('20260926')

  // A1111, chosen with the picker: hashes, the LoRA weight from the prompt, the syntax switch
  await page.getByTestId('intake-file').setInputFiles(sample('a1111'))
  await expect(page.getByTestId('reader-generator')).toHaveText('WebUI')
  await expect(page.getByTestId('reader-models')).toContainText('0a1b2c3d4e')
  await expect(page.getByTestId('reader-lora')).toContainText('0.7')
  await expect(page.getByTestId('reader-lora')).toContainText('9f8e7d6c5b4a')
  await page.getByTestId('reader-format-nai').click()
  await expect(page.getByTestId('reader-prompt')).toContainText('1.1::blue eyes::')
  await page.getByTestId('reader-copy-menu').click()
  await page.getByRole('menuitem', { name: 'Copy as SD text' }).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain('(blue eyes:1.1)')
  expect(copied).toContain('Negative prompt: lowres, bad hands')
  await expect(page.getByTestId('reader-tags')).toContainText('blue eyes')

  // NovelAI, dropped: two characters with their place and negative
  await dropFile(page, sample('nai'), 'image/png')
  await expect(page.getByTestId('reader-generator')).toHaveText('NovelAI')
  await expect(page.getByTestId('reader-character')).toHaveCount(2)
  await expect(page.getByTestId('reader-character').first()).toContainText('at x 0.30 · y 0.50')
  await expect(page.getByTestId('reader-character').nth(1)).toContainText('extra fingers')

  // WebP with its parameters in EXIF
  await dropFile(page, sample('webp'), 'image/webp')
  await expect(page.getByTestId('reader-prompt')).toContainText('v4reader webp prompt')
  await expect(page.locator('figure').getByRole('button', { name: /^SEED\s*777$/ })).toBeVisible()

  // a section folded away stays folded for the next image, and after a reload
  await page.getByTestId('reader-params').getByRole('button', { name: /All parameters/ }).click()
  await expect(page.getByTestId('reader-params')).not.toContainText('777')
  await page.reload()
  await page.getByTestId('intake-file').setInputFiles(sample('webp'))
  await expect(page.getByTestId('reader-prompt')).toContainText('v4reader webp prompt')
  await expect(page.getByTestId('reader-params').getByRole('button', { name: /All parameters/ })).toHaveAttribute('aria-expanded', 'false')
})

test('a real Ctrl+V paste reads the image; a pasted image without details says why', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openReader(page)
  await pasteFile(page, sample('nai'))
  await expect(page.getByTestId('reader-generator')).toHaveText('NovelAI')
  await expect(page.getByTestId('reader-paste-note')).toContainText('pasted from the clipboard')

  await pasteFile(page, NO_METADATA)
  await expect(page.getByTestId('reader-no-params')).toContainText('A pasted image has usually lost them')

  // typing in a text field keeps its own paste
  await page.getByTestId('reader-editor').getByRole('button', { name: /Edit generation details/ }).click()
  const prompt = page.getByTestId('reader-edit-prompt')
  await prompt.focus()
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }))
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.getByTestId('reader-no-params')).toBeVisible()
})

test('a library image opens from the right-click menu and the card, read from the database', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await markModelsReady(page)
  const id = await readLibraryCopy(page)
  const uploads: string[] = []
  page.on('request', (r) => r.url().includes('/api/parse-image') && uploads.push(r.url()))
  await openLibrary(page, TOKEN, COUNT)

  const tile = page.locator(`[data-testid="tile"][data-id="${id}"]`)
  await tile.click({ button: 'right' })
  const menu = page.getByTestId('card-menu')
  await menu.getByRole('menuitem', { name: 'Send to tool' }).hover()
  await page.locator('[data-ctx-sub]').getByRole('menuitem', { name: 'Reader' }).click()
  await expect(page).toHaveURL(/#\/tools\/reader$/)
  await expect(page.getByTestId('reader-file-name')).toHaveText(`${PREFIX}00.png`)
  await expect(page.getByTestId('reader-prompt')).toContainText('v4reader webui prompt')
  await expect(page.getByTestId('reader-page')).toContainText('Library image')

  // Find in library puts the group's tags into the search bar
  await page.getByTestId('reader-tags').getByTestId('reader-find').first().click()
  await expect(page).toHaveURL(/#\/library$/)
  await expect(page.getByTestId('query-input')).toHaveValue(/tag:/)

  // the generation card's "Open in Reader"
  await page.getByTestId('query-input').fill(TOKEN)
  await page.getByTestId('query-input').press('Enter')
  await page.locator(`[data-testid="tile"][data-id="${id}"]`).click()
  await page.getByTestId('card-open-reader').click()
  await expect(page.getByTestId('reader-file-name')).toHaveText(`${PREFIX}00.png`)
  expect(uploads, 'a library image is read from the database, not uploaded').toEqual([])
})

test('edits are saved as a new image; an existing name asks first; the new file carries the edits', async ({ page, request }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openReader(page)
  await page.getByTestId('intake-file').setInputFiles(sample('a1111'))
  await expect(page.getByTestId('reader-generator')).toHaveText('WebUI')
  await page.getByTestId('reader-editor').getByRole('button', { name: /Edit generation details/ }).click()
  await page.getByTestId('reader-edit-seed').fill('999')
  await page.getByTestId('reader-edit-prompt').fill('1girl, v4reader edited prompt')
  await expect(page.getByTestId('reader-save-as')).toBeDisabled()

  await page.getByTestId('reader-edit-choose').click()
  const picker = page.getByTestId('reader-folder-picker')
  await picker.getByTestId('folder-path').fill(OUT)
  await picker.getByTestId('folder-path').press('Enter')
  await expect(picker.getByTestId('folder-target')).toContainText(/v4-reader[\\/]out/)
  await picker.getByRole('button', { name: 'Save here' }).click()
  await expect(page.getByTestId('reader-edit-folder')).toHaveAttribute('title', /v4-reader[\\/]out$/)

  await page.getByTestId('reader-save-as').click()
  await expect(page.getByTestId('reader-saved')).toContainText('v4reader-a1111.edited.png')
  // the A1111 sample's own settings the editor does not show are named, in the user's language
  await expect(page.getByTestId('reader-save-notes')).toContainText('these settings from the original are not in the new file')

  const written = path.join(OUT, 'v4reader-a1111.edited.png')
  const parsed = await request.post('/api/parse-image', {
    multipart: { file: { name: 'check.png', mimeType: 'image/png', buffer: fs.readFileSync(written) } },
  })
  const body = (await parsed.json()) as { prompt: string; metadata: { _parsed: { generation_params: { seed: number } } } }
  expect(body.prompt).toBe('1girl, v4reader edited prompt')
  expect(body.metadata._parsed.generation_params.seed).toBe(999)

  // the same name again: asked first, then replaced
  await page.getByTestId('reader-save-as').click()
  await expect(page.getByTestId('reader-replace-dialog')).toBeVisible()
  await page.getByTestId('reader-replace-confirm').click()
  await expect(page.getByTestId('reader-replace-dialog')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Saved as v4reader-a1111.edited.png' }).first()).toBeVisible()

  // the folder is remembered for the next image
  await page.getByTestId('intake-file').setInputFiles(sample('webp'))
  await expect(page.getByTestId('reader-edit-folder')).toHaveAttribute('title', /v4-reader[\\/]out$/)
})

test('overwriting the library copy asks first, updates the card, and can be undone once', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await markModelsReady(page)
  const id = await readLibraryCopy(page)
  expect(await seedOf(page, id)).toBe(123456789)
  await openLibrary(page, TOKEN, COUNT)
  await page.locator(`[data-testid="tile"][data-id="${id}"]`).click()
  await page.getByTestId('card-open-reader').click()
  await expect(page.getByTestId('reader-file-name')).toHaveText(`${PREFIX}00.png`)

  await page.getByTestId('reader-editor').getByRole('button', { name: /Edit generation details/ }).click()
  await page.getByTestId('reader-edit-seed').fill('4242')
  await page.getByTestId('reader-overwrite').click()
  const dialog = page.getByTestId('reader-overwrite-dialog')
  await expect(dialog).toContainText('can be undone once')
  // Cancel leaves the file alone
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(await seedOf(page, id)).toBe(123456789)

  await page.getByTestId('reader-overwrite').click()
  await page.getByTestId('reader-overwrite-confirm').click()
  await expect(page.getByTestId('reader-saved')).toContainText('Written into the original')
  await expect.poll(() => seedOf(page, id)).toBe(4242)
  await expect(page.locator('figure').getByRole('button', { name: /^SEED\s*4242$/ })).toBeVisible()
  await expect(page.getByTestId('reader-edit-seed')).toHaveValue('4242')

  await page.getByRole('status').filter({ hasText: 'Original overwritten' }).getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Undone' })).toBeVisible()
  await expect.poll(() => seedOf(page, id)).toBe(123456789)
  await expect(page.locator('figure').getByRole('button', { name: /^SEED\s*123456789$/ })).toBeVisible()
})

test('fits the desktop sizes with nothing cut off', async ({ page }) => {
  await openReader(page)
  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp)
    await page.getByTestId('intake-file').setInputFiles(sample('nai'))
    await expect(page.getByTestId('reader-character')).toHaveCount(2)
    expect(await pageOverflow(page), `overflow at ${vp.width}`).toBeLessThanOrEqual(0)
    for (const id of ['intake-pick', 'intake-paste', 'reader-clear', 'reader-copy-menu']) await expect(page.getByTestId(id), `${id} at ${vp.width}`).toBeInViewport()
    await page.getByTestId('reader-clear').click()
    await expect(page.getByTestId('intake-zone')).toBeVisible()
    await expect(page.getByTestId('intake-pick')).toBeInViewport()
  }
})
