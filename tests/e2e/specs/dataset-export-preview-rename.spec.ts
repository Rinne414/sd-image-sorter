import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Export preview must follow every field that changes the planned output
 * names: after a rename-type edit the last preview request has to carry the
 * new value (the preview shows what the server planned for that payload).
 */

test.describe.configure({ mode: 'serial' })

let posts: any[] = []

async function open(page: Page) {
  posts = []
  await page.route('**/api/image-thumbnail/**', (r) => r.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (r) => r.fulfill({ status: 204 }))
  await page.route('**/api/dataset/vocab', (r) => r.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (r) => r.fulfill({ json: { results: [] } }))
  await page.route('**/api/dataset/export-preview', (r) => {
    posts.push(JSON.parse(r.request().postData() || '{}'))
    return r.fulfill({ json: { total: 0, returned: 0, items: [] } })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._refreshExportPreview === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    const ids = [701, 702]
    dm.imageIds = ids
    for (const id of ids) {
      dm.meta.set(id, { filename: `${id}.png`, width: 1024, height: 1024 })
      dm.captions.set(id, '1girl')
    }
    ;(window as any).App.switchView('dataset')
    dm._setActive(ids[0])
    dm._renderQueue()
  })
  await page.locator('#dataset-tab-export').click()
  await page.waitForTimeout(600)
}

const last = () => posts[posts.length - 1] || {}

test('trigger word rename reaches the preview request', async ({ page }) => {
  await open(page)
  await page.locator('#dataset-naming-preset-renumber, input[name="dataset-naming-preset"][value="renumber"]').first().check({ force: true })
  await expect.poll(() => last().naming_pattern).toBeTruthy()
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-trigger').fill('hero')
  await expect.poll(() => last().trigger, { timeout: 4000 }).toBe('hero')
  expect(last().naming_pattern).toContain('{trigger}')
  await page.locator('#dataset-trigger').fill('villain')
  await expect.poll(() => last().trigger, { timeout: 4000 }).toBe('villain')
  expect(last().naming_pattern).toContain('{trigger}')
})

test('custom pattern, overwrite policy and output folder reach the preview request', async ({ page }) => {
  await open(page)
  await page.locator('input[name="dataset-naming-preset"][value="custom"]').check({ force: true })
  await page.locator('#dataset-naming-pattern').fill('{n:03}_x')
  await expect.poll(() => last().naming_pattern, { timeout: 4000 }).toBe('{n:03}_x')
  await page.locator('#dataset-tab-export').click()
  await page.evaluate(() => document.querySelectorAll('#dataset-panel-export details, #view-dataset details').forEach((d) => ((d as HTMLDetailsElement).open = true)))
  await page.evaluate(() => {
    const sel = document.getElementById('dataset-overwrite') as HTMLSelectElement
    sel.value = 'overwrite'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect.poll(() => last().overwrite_policy, { timeout: 4000 }).toBe('overwrite')
  await page.locator('#dataset-output-folder').fill('C:/tmp/g3-out')
  await expect.poll(() => last().output_folder, { timeout: 4000 }).toBe('C:/tmp/g3-out')
})
