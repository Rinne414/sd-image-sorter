import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, pageOverflow, runBackendScript, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 import: the top-bar "Import" opens the folder browser with the import
 * options; the scan runs as a job and the new images appear. Real backend.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const PREFIX = 'v4imp-'
const DIR = 'v4-imp'
const folder = path.join(tmpRoot, DIR)

test.beforeAll(() => {
  cleanupImages(PREFIX, [DIR])
  runBackendScript(`
from pathlib import Path
from PIL import Image
root = Path(${JSON.stringify(folder)}) / "sub"
root.mkdir(parents=True, exist_ok=True)
for i, colour in enumerate([(200, 40, 40), (40, 200, 40), (40, 40, 200)]):
    Image.new("RGB", (64, 64), colour).save(root / f"${PREFIX}{i}.png")
print("ok")
`)
})

test.afterAll(() => cleanupImages(PREFIX, [DIR]))

async function openV4(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('v4e2e-import-init')) return
    sessionStorage.setItem('v4e2e-import-init', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.removeItem('sd-image-sorter-recent-folders')
  })
  await page.goto('/v4/', { waitUntil: 'domcontentloaded' })
}

async function search(page: Page, text: string) {
  const input = page.getByTestId('query-input')
  await input.fill(text)
  await input.press('Enter')
}

for (const viewport of VIEWPORTS) {
  test(`import button and dialog fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openV4(page)
    await expect(page.getByTestId('import-button')).toBeInViewport({ ratio: 1 })
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    await page.getByTestId('import-button').click()
    const dialog = page.getByTestId('import-dialog')
    await dialog.getByText('Advanced').click()
    await expect(dialog).toBeInViewport({ ratio: 1 })
    await expect(dialog.getByRole('button', { name: 'Import this folder' })).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
}

test('a folder imports as a job and its images appear; the folder is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page)
  await search(page, PREFIX)
  await expect(page.getByTestId('result-count')).toHaveText('0 images')

  await page.getByTestId('import-button').click()
  const dialog = page.getByTestId('import-dialog')
  await expect(dialog.getByRole('checkbox', { name: 'Include subfolders' })).toBeChecked()
  const pathInput = dialog.getByTestId('folder-path')
  await pathInput.fill(folder)
  await pathInput.press('Enter')
  await expect(pathInput).toHaveValue(folder)
  await dialog.getByRole('button', { name: 'Import this folder' }).click()
  await expect(dialog).toHaveCount(0)

  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  await expect(job).toContainText('Imported: 3 new', { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('result-count')).toHaveText('3 images', { timeout: 15_000 })

  // the next import offers it (the list is shared with V3.5)
  await page.getByTestId('import-button').click()
  await expect(page.getByTestId('import-dialog').getByTestId('import-recent')).toContainText(DIR)
  const shared = await page.evaluate(() => localStorage.getItem('sd-image-sorter-recent-folders'))
  expect(JSON.parse(shared ?? '[]')).toContain(folder)
})
