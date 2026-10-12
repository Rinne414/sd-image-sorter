import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * "Add tag to N selected" asks for the tag in an in-app field (no
 * window.prompt) and never writes a second copy of a tag an image has.
 */

test.describe.configure({ mode: 'serial' })

async function seedSelection(page: Page, captions: Record<number, string>) {
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._updateMultiSelectUI === 'function')
  await page.evaluate((seed) => {
    const dm = (window as any).DatasetMaker
    const ids = Object.keys(seed).map(Number)
    dm.imageIds = ids
    dm.captions.clear()
    dm.captionEdits.clear()
    for (const id of ids) {
      dm.meta.set(id, { filename: `${id}.png`, width: 1024, height: 1024 })
      dm.captions.set(id, seed[id])
    }
    ;(window as any).App.switchView('dataset')
    dm._setActive(ids[0])
    dm._renderQueue()
    dm._selectAllQueue(ids)
  }, captions)
  await page.locator('#dataset-tab-workbench').click()
  await expect(page.locator('#btn-multisel-addtag')).toBeVisible()
}

const edited = (page: Page, id: number) =>
  page.evaluate((i) => (window as any).DatasetMaker.captionEdits.get(i), id)

async function addTag(page: Page, value: string) {
  await page.locator('#btn-multisel-addtag').click()
  const input = page.locator('#dataset-multisel-tag-input')
  await expect(input).toBeFocused()
  await input.fill(value)
  await input.press('Enter')
}

test('opens an in-app field instead of window.prompt, Escape cancels', async ({ page }) => {
  let dialogs = 0
  page.on('dialog', (d) => { dialogs += 1; void d.dismiss() })
  await seedSelection(page, { 801: '1girl', 802: 'solo' })
  await page.locator('#btn-multisel-addtag').click()
  const input = page.locator('#dataset-multisel-tag-input')
  await expect(input).toBeFocused()
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  expect(dialogs).toBe(0)
  expect(await edited(page, 801)).toBeUndefined()
})

test('an empty value does nothing', async ({ page }) => {
  await seedSelection(page, { 811: '1girl' })
  await addTag(page, '   ')
  expect(await edited(page, 811)).toBeUndefined()
})

test('skips images that already have the tag (folded) and reports both counts', async ({ page }) => {
  await seedSelection(page, { 821: '1girl, long_hair', 822: 'Long  Hair, smile', 823: 'smile', 824: '' })
  await addTag(page, 'long hair')
  await expect.poll(() => edited(page, 823)).toBe('smile, long hair')
  expect(await edited(page, 821)).toBeUndefined()
  expect(await edited(page, 822)).toBeUndefined()
  expect(await edited(page, 824)).toBe('long hair')
  await expect(page.locator('.toast').last()).toContainText('2')
  await expect(page.locator('.toast').last()).toContainText(/already/i)
})

test('a comma-separated entry adds each tag once', async ({ page }) => {
  await seedSelection(page, { 831: 'smile', 832: 'blush' })
  await addTag(page, 'smile, blush, smile')
  await expect.poll(() => edited(page, 831)).toBe('smile, blush')
  expect(await edited(page, 832)).toBe('blush, smile')
})
