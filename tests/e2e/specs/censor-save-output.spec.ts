import type { Page, Route } from '@playwright/test'
import { expect, test } from '../fixtures/click-ledger'

/**
 * Censor Save works without setup and never makes the user rename by hand
 * (owner request 2026-10-04).
 *
 * - An empty folder field saves into the program's output/censor folder; the
 *   field says where that is and has a Browse button.
 * - "When a file with the same name exists" defaults to numbering, and the
 *   choice is remembered across reloads, as are the metadata and format
 *   choices (state.js used to reset both to strip/png on every load).
 * - The success toast offers "Open folder" for the file that was written.
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#e0245e"/>
</svg>
`.trim()

const IMAGE = { id: 9701, filename: 'kept.png', path: 'L:/save-output-kept.png', width: 640, height: 640 }
const SAVED_PATH = 'L:/app/output/censor/kept_2.png'

interface SaveStub {
  calls: Record<string, unknown>[]
  reveals: string[]
  skipped: boolean
}

async function stubBackend(page: Page): Promise<SaveStub> {
  const stub: SaveStub = { calls: [], reveals: [], skipped: false }
  const fulfillImage = async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  }
  await page.route(`**/api/image-thumbnail/${IMAGE.id}**`, fulfillImage)
  await page.route(`**/api/image-file/${IMAGE.id}**`, fulfillImage)
  await page.route('**/api/images?**', async (route) => {
    await route.fulfill({ json: { images: [IMAGE], total: 1, has_more: false, next_cursor: null } })
  })
  await page.route('**/api/images/export-data', async (route) => {
    await route.fulfill({ json: { images: [{ ...IMAGE, prompt: '', tags: [] }], missing_ids: [] } })
  })
  await page.route('**/api/censor/save-original', async (route) => {
    stub.calls.push(route.request().postDataJSON())
    await route.fulfill({
      json: {
        status: stub.skipped ? 'skipped' : 'ok',
        output_path: SAVED_PATH,
        filename: 'kept_2.png',
        warnings: [],
        skipped: stub.skipped,
        overwrote_existing: false,
        overwrote_indexed_path: false,
        reconciled_image_id: null,
      },
    })
  })
  // Never let a test open a real file manager window.
  await page.route('**/api/output-folders/reveal', async (route) => {
    stub.reveals.push((route.request().postDataJSON() as { path: string }).path)
    await route.fulfill({ json: { status: 'ok' } })
  })
  return stub
}

async function openSaveDialog(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGE.id}"]`).click()
  await page.locator('#btn-send-to-censor').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(IMAGE.id)
  await page.locator('#btn-save-all-processed').click()
  await expect(page.locator('#save-options-modal.visible')).toBeVisible()
}

let stub: SaveStub

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('save-output-seeded')) return
    sessionStorage.setItem('save-output-seeded', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
    for (const key of ['censor_queue', 'censor_output_folder', 'censor_name_conflict', 'censor_metadata_option']) {
      localStorage.removeItem(key)
    }
  })
  stub = await stubBackend(page)
})

test('an empty folder saves into the built-in output folder, numbered, with Open folder', async ({ page }) => {
  await openSaveDialog(page)

  const folder = page.locator('#save-output-folder')
  await expect(folder).toHaveValue('')
  await expect(folder).toHaveAttribute('placeholder', /^Empty = .*output.censor$/)
  await expect(page.locator('#btn-save-browse-folder')).toBeVisible()
  await expect(page.locator('#save-name-conflict')).toHaveValue('unique')
  await expect(page.locator('#save-allow-overwrite')).toHaveCount(0)

  await page.locator('#btn-confirm-save-options').click()

  await expect.poll(() => stub.calls.length).toBe(1)
  expect(stub.calls[0]).toMatchObject({ output_folder: '', allow_overwrite: false, name_conflict: 'unique' })
  const toast = page.locator('#toast-container .toast.success', { hasText: 'L:/app/output/censor' })
  await expect(toast).toBeVisible()
  await toast.locator('.toast-action-btn', { hasText: 'Open folder' }).click()
  await expect.poll(() => stub.reveals).toEqual([SAVED_PATH])
})

test('Browse opens the folder browser under the folder field', async ({ page }) => {
  await openSaveDialog(page)

  await page.locator('#btn-save-browse-folder').click()

  await expect(page.locator('#save-output-folder-browser')).not.toBeEmpty()
})

test('the same-name, metadata and format choices are remembered; skipped files are reported', async ({ page }) => {
  await openSaveDialog(page)
  await page.selectOption('#save-name-conflict', 'skip')
  await page.selectOption('#save-metadata-option', 'keep')
  await page.selectOption('#save-format-option', 'webp')
  stub.skipped = true
  await page.locator('#btn-confirm-save-options').click()

  await expect.poll(() => stub.calls.length).toBe(1)
  expect(stub.calls[0]).toMatchObject({
    allow_overwrite: false,
    name_conflict: 'skip',
    metadata_option: 'keep',
    output_format: 'webp',
  })
  await expect(page.locator('#toast-container .toast.warning', { hasText: 'same name' })).toBeVisible()

  await page.reload()
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => (window as any).App.switchView('censor'))
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.queue?.length || 0)).toBeGreaterThan(0)
  await page.locator('#btn-save-all-processed').click()
  await expect(page.locator('#save-name-conflict')).toHaveValue('skip')
  await expect(page.locator('#save-metadata-option')).toHaveValue('keep')
  await expect(page.locator('#save-format-option')).toHaveValue('webp')

  await page.selectOption('#save-name-conflict', 'overwrite')
  stub.skipped = false
  await page.locator('#btn-confirm-save-options').click()
  await expect.poll(() => stub.calls.length).toBe(2)
  expect(stub.calls[1]).toMatchObject({ allow_overwrite: true })
})

test('the rename dialog puts each hint under its own field and keeps Apply on screen', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await openSaveDialog(page)
  await page.locator('#btn-cancel-save-options').click()
  await page.locator('#btn-batch-rename').click()
  await expect(page.locator('#rename-modal.visible')).toBeVisible()

  await expect(page.locator('#rename-selection-help')).toHaveText(/选中|全部/)
  await expect(page.locator('#rename-custom-group .helper-text')).not.toContainText('编号')
  await expect(page.locator('.rename-pattern-group label')).not.toHaveText(/预览/)
  await expect(page.locator('#btn-apply-rename')).toBeInViewport()
})

test('a picture painted after saving no longer shows as saved', async ({ page }) => {
  await openSaveDialog(page)
  await page.locator('#btn-confirm-save-options').click()
  await expect.poll(() => stub.calls.length).toBe(1)
  const outcome = () => page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    const item = state.queue.find((entry: any) => entry.id === state.activeId)
    return (window as any).getCensorBatchOutcome(item)
  })
  await expect.poll(outcome).toBe('saved')

  await page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    const item = state.queue.find((entry: any) => entry.id === state.activeId)
    item.currentDataUrl = 'data:image/png;base64,painted-after-save'
    item.isModified = true
  })

  await expect.poll(outcome).toBeNull()
})
