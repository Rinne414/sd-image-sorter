import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Removing a tag with Find/Replace (empty replacement) must remove the token
 * and its separator, not leave an empty token such as ", ," in the caption.
 */

test.describe.configure({ mode: 'serial' })

async function openFindReplace(page: Page, captions: Record<number, string>) {
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
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
  }, captions)
  await page.locator('#dataset-tab-workbench').click()
  await page.evaluate(() => {
    const scope = document.getElementById('dataset-caption-scope') as HTMLSelectElement
    if (scope) { scope.value = 'all'; scope.dispatchEvent(new Event('change', { bubbles: true })) }
    const details = document.getElementById('dataset-step-findreplace') as HTMLDetailsElement
    if (details) details.open = true
  })
}

async function replaceAll(page: Page, find: string, replace: string, substring: boolean) {
  await page.evaluate(([f, r, s]) => {
    ;(document.getElementById('dataset-find-input') as HTMLInputElement).value = f as string
    ;(document.getElementById('dataset-replace-input') as HTMLInputElement).value = r as string
    ;(document.getElementById('dataset-find-substring') as HTMLInputElement).checked = s as boolean
  }, [find, replace, substring])
  await page.locator('#btn-dataset-find-replace').click()
}

const editedCaption = (page: Page, id: number) =>
  page.evaluate((i) => (window as any).DatasetMaker.captionEdits.get(i), id)

test('removing a tag drops its token and separator (middle, first, last, only)', async ({ page }) => {
  await openFindReplace(page, {
    901: '1girl, outdoors, smile',
    902: 'outdoors, 1girl, smile',
    903: '1girl, smile, outdoors',
    904: 'outdoors',
    905: '1girl,outdoors,smile',
  })
  await replaceAll(page, 'outdoors', '', false)
  await expect.poll(() => editedCaption(page, 905)).toBe('1girl,smile')
  expect(await editedCaption(page, 901)).toBe('1girl, smile')
  expect(await editedCaption(page, 902)).toBe('1girl, smile')
  expect(await editedCaption(page, 903)).toBe('1girl, smile')
  expect(await editedCaption(page, 904)).toBe('')
})

test('substring mode with an empty replacement leaves no empty token either', async ({ page }) => {
  await openFindReplace(page, { 911: '1girl, outdoors, smile' })
  await replaceAll(page, 'outdoors', '', true)
  await expect.poll(() => editedCaption(page, 911)).toBe('1girl, smile')
})

test('a non-empty replacement still renames in place', async ({ page }) => {
  await openFindReplace(page, { 921: '1girl, outdoors, smile' })
  await replaceAll(page, 'outdoors', 'indoors', false)
  await expect.poll(() => editedCaption(page, 921)).toBe('1girl, indoors, smile')
})

test('substring removal inside a tag leaves no dangling space before the comma', async ({ page }) => {
  await openFindReplace(page, { 931: 'a, long hair, b' })
  await replaceAll(page, 'hair', '', true)
  await expect.poll(() => editedCaption(page, 931)).toBe('a, long, b')
})

test('substring removal in a newline-separated caption leaves no empty line', async ({ page }) => {
  await openFindReplace(page, { 941: 'a\nhair\nb' })
  await replaceAll(page, 'hair', '', true)
  await expect.poll(() => editedCaption(page, 941)).toBe('a\nb')
})
