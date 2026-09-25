import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, openLibrary, pageOverflow, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 "Edit tags…" for the picks: dry run before writing, apply, undo from
 * the jobs drawer. Runs against the real bulk-tag endpoints on the isolated
 * test database.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4tedittoken'
const PREFIX = 'v4tedit-'
const COUNT = 4
const DIR = 'v4-tedit'

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

async function tagsOf(page: Page, id: string): Promise<string[]> {
  return page.evaluate(async (x) => {
    const body = (await (await fetch(`/api/images/${x}`)).json()) as { tags: { tag: string }[] }
    return body.tags.map((t) => t.tag).sort()
  }, id)
}

async function pickTwo(page: Page): Promise<string[]> {
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await tiles.nth(1).click({ modifiers: ['Control'] })
  return [(await tiles.nth(0).getAttribute('data-id'))!, (await tiles.nth(1).getAttribute('data-id'))!]
}

async function openEditor(page: Page) {
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Edit tags…' }).click()
  return page.getByTestId('tagedit-dialog')
}

for (const viewport of VIEWPORTS) {
  test(`tag editor fits at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      await openLibrary(page, TOKEN, COUNT, theme)
      await pickTwo(page)
      const dialog = await openEditor(page)
      for (const op of ['Add', 'Remove', 'Find and replace', 'Clean up']) {
        await dialog.getByRole('button', { name: op, exact: true }).click()
        await expect(dialog).toBeInViewport({ ratio: 1 })
      }
      await expect(dialog.getByRole('button', { name: /^Apply/ })).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
  })
}

test('add is previewed, applied, and undone from the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const ids = await pickTwo(page)
  const dialog = await openEditor(page)
  const preview = dialog.getByTestId('tagedit-preview')

  // nothing is written by the dry run
  await dialog.getByLabel('Tags to add').fill('v4 alpha, v4 beta')
  await expect(preview).toContainText('2 images and 4 tags would change')
  await expect(preview).toContainText('+ v4 alpha')
  expect(await tagsOf(page, ids[0]!)).not.toContain('v4 alpha')

  await dialog.getByRole('button', { name: 'Apply to 2' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => tagsOf(page, ids[0]!)).toEqual(expect.arrayContaining(['v4 alpha', 'v4 beta']))
  await expect.poll(() => tagsOf(page, ids[1]!)).toEqual(expect.arrayContaining(['v4 alpha', 'v4 beta']))

  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  await expect(job).toContainText('Tags edited on 2')
  await job.getByRole('button', { name: 'Undo this edit' }).click()
  await expect(job.getByRole('button', { name: 'Undone' })).toBeDisabled()
  await expect.poll(() => tagsOf(page, ids[0]!)).not.toContain('v4 alpha')
  await expect.poll(() => tagsOf(page, ids[1]!)).not.toContain('v4 beta')
})

test('find and replace renames; remove says when nothing matches', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, TOKEN, COUNT)
  const ids = await pickTwo(page)

  let dialog = await openEditor(page)
  await dialog.getByLabel('Tags to add').fill('v4 old')
  await dialog.getByRole('button', { name: 'Apply to 2' }).click()
  await expect.poll(() => tagsOf(page, ids[0]!)).toContain('v4 old')

  dialog = await openEditor(page)
  await dialog.getByRole('button', { name: 'Find and replace', exact: true }).click()
  await dialog.getByLabel('Find this tag').fill('v4 old')
  await dialog.getByLabel('Replace with').fill('v4 new')
  const preview = dialog.getByTestId('tagedit-preview')
  await expect(preview).toContainText('− v4 old')
  await expect(preview).toContainText('+ v4 new')
  await dialog.getByRole('button', { name: 'Apply to 2' }).click()
  await expect.poll(() => tagsOf(page, ids[1]!)).toContain('v4 new')
  expect(await tagsOf(page, ids[1]!)).not.toContain('v4 old')

  // the booru spelling of a tag that is stored with a space finds nothing, and the panel says why
  dialog = await openEditor(page)
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await dialog.getByLabel('Tags to remove').fill('v4_new')
  await expect(dialog.getByTestId('tagedit-preview')).toContainText('Nothing would change')
  await expect(dialog.getByTestId('tagedit-preview')).toContainText('long hair rather than long_hair')
  await expect(dialog.getByRole('button', { name: /^Apply/ })).toBeDisabled()

  await dialog.getByLabel('Tags to remove').fill('v4 new')
  await dialog.getByRole('button', { name: 'Apply to 2' }).click()
  await expect.poll(() => tagsOf(page, ids[0]!)).not.toContain('v4 new')
})
