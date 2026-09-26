import fs from 'node:fs'

import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, openLibrary, pageOverflow, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 "Export data…" for the picks: format preview, copy all, and the
 * downloaded file, against the real export-data endpoint.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4exptoken'
const PREFIX = 'v4exp-'
const COUNT = 4
const DIR = 'v4-exp'

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

async function openExport(page: Page) {
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await tiles.nth(1).click({ modifiers: ['Control'] })
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Export data…' }).click()
  return page.getByTestId('export-dialog')
}

for (const viewport of VIEWPORTS) {
  test(`export dialog fits at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      await openLibrary(page, TOKEN, COUNT, theme)
      const dialog = await openExport(page)
      await expect(dialog.getByTestId('export-preview')).toHaveValue(/frame 0/)
      await expect(dialog).toBeInViewport({ ratio: 1 })
      await expect(dialog.getByRole('button', { name: /^Download/ })).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
  })
}

test('formats preview in pick order; copy and download carry the whole text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const dialog = await openExport(page)
  const preview = dialog.getByTestId('export-preview')

  await dialog.getByText('Prompts with filenames').click()
  await expect(preview).toHaveValue(/^1\. v4exp-00\.png\n.*frame 0\n\n2\. v4exp-01\.png\n/)

  await dialog.getByText('A1111 / Forge parameters').click()
  await expect(preview).toHaveValue(/Negative prompt: lowres\nSteps: 28, Sampler: k_euler, CFG scale: 5, Seed: 424242/)

  await dialog.getByRole('button', { name: 'Copy all' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Seed: 424242')

  await dialog.getByText('CSV table').click()
  await expect(preview).toHaveValue(/^id,filename,generator,prompt,/)
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download .csv' }).click()])
  expect(download.suggestedFilename()).toBe('sd-image-sorter-csv-2.csv')
  const text = fs.readFileSync((await download.path())!, 'utf8')
  expect(text.charCodeAt(0)).toBe(0xfeff)
  expect(text).toContain('v4exp-00.png')
  expect(text).toContain('v4exp-01.png')
  expect(text.trim().split('\n')).toHaveLength(3)

  // the format is remembered for next time
  await page.keyboard.press('Escape')
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Export data…' }).click()
  await expect(page.getByTestId('export-dialog').getByRole('radio', { name: 'CSV table' })).toBeChecked()
})

test('an empty or broken export answer says so in plain words; Try again shows the preview', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  // an empty 204, then {} (no rows; the app asks once more by itself), then the real rows
  let answers = 0
  await page.route('**/api/images/export-data', (route) => {
    answers += 1
    if (answers === 1) return route.fulfill({ status: 204, body: '' })
    if (answers === 2) return route.fulfill({ json: {} })
    return route.continue()
  })
  await openLibrary(page, TOKEN, COUNT)
  const dialog = await openExport(page)
  const preview = dialog.getByTestId('export-preview')
  await expect(preview).toHaveValue(/incomplete/, { timeout: 15_000 })
  await expect(preview).not.toHaveValue(/Cannot read|undefined/)
  expect(answers).toBe(2)
  await dialog.getByRole('button', { name: 'Try again' }).click()
  await expect(preview).toHaveValue(/frame 0/)
  await expect(dialog.getByRole('button', { name: /^Download/ })).toBeEnabled()
  await page.keyboard.press('Escape')
})
