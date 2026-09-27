import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, dbPath, openLibrary, pageOverflow, runBackendScript, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 batches: picks go into a new batch in pick order; the step rail's order
 * and on/off state persist; templates; remove + undo; rename; delete (confirm
 * focuses Cancel); Home lists the batch; a V3.5 collection opens as a custom
 * batch in the collection's order and is left unchanged.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4battoken'
const PREFIX = 'v4bat-'
const COUNT = 6
const DIR = 'v4-bat'
const NAME = 'v4bat'
const COLLECTION_SLUG = 'v4bat-collection'

let batchId = 0
let collectionId = 0

function seedCollection(): number {
  // Three of the seeded images, added a minute apart: V3.5 lists newest-added first.
  const out = runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    cur.execute("DELETE FROM collection_items WHERE collection_id IN (SELECT id FROM collections WHERE slug = ?)", (${JSON.stringify(COLLECTION_SLUG)},))
    cur.execute("DELETE FROM collections WHERE slug = ?", (${JSON.stringify(COLLECTION_SLUG)},))
    cur.execute("INSERT INTO collections (slug, name, folder_path, library_id) VALUES (?, ?, '', 'main')", (${JSON.stringify(COLLECTION_SLUG)}, "v4bat collection"))
    cid = cur.lastrowid
    rows = cur.execute("SELECT id, path FROM images WHERE filename LIKE ? ORDER BY filename", (${JSON.stringify(PREFIX + '%')},)).fetchall()
    for minutes, (image_id, path) in zip((5, 1, 3), rows[1:4]):
        cur.execute("INSERT INTO collection_items (collection_id, source_image_id, copied_path, added_at) VALUES (?, ?, ?, datetime('now', ?))", (cid, image_id, path, f"-{minutes} minutes"))
    conn.commit()
print(cid)
`)
  return Number(out.split(/\s+/).at(-1))
}

function cleanupBatches(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    conn.execute("DELETE FROM batch_templates WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    conn.execute("DELETE FROM collection_items WHERE collection_id IN (SELECT id FROM collections WHERE slug = ?)", (${JSON.stringify(COLLECTION_SLUG)},))
    conn.execute("DELETE FROM collections WHERE slug = ?", (${JSON.stringify(COLLECTION_SLUG)},))
    conn.commit()
print("ok")
`)
}

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  cleanupBatches()
  collectionId = seedCollection()
})

test.afterAll(() => {
  cleanupBatches()
  cleanupImages(PREFIX, [DIR])
})

async function openV4(page: Page, hash: string): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('v4e2e-init-batch')) return
    sessionStorage.setItem('v4e2e-init-batch', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
  })
  await page.goto(`/v4/${hash}`, { waitUntil: 'domcontentloaded' })
}

async function apiJson<T>(page: Page, url: string): Promise<T> {
  return page.evaluate(async (u) => (await fetch(u)).json(), url) as Promise<T>
}

interface ApiBatch {
  name: string
  kind: string
  current_step: string | null
  steps: { id: string; enabled: boolean }[]
  settings: Record<string, unknown>
  items: { image_id: number }[]
}

const tileIds = (page: Page) => page.getByTestId('pick-tile').evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-id'))))
const railSteps = (page: Page) => page.getByTestId('rail-step').evaluateAll((els) => els.map((el) => el.getAttribute('data-step-id')))

test('picks go into a new Pixiv post in the order they were picked', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const tiles = page.getByTestId('tile')
  const picked: number[] = []
  for (const i of [2, 0, 4]) {
    await tiles.nth(i).click({ modifiers: ['Control'] })
    picked.push(Number(await tiles.nth(i).getAttribute('data-id')))
  }

  await page.getByTestId('add-to-batch').click()
  await page.getByRole('menuitem', { name: 'New Pixiv post…' }).click()
  const dialog = page.getByTestId('batch-create-dialog')
  const input = page.getByTestId('batch-name-input')
  await expect(input).toHaveValue(/^Pixiv post \w{3} \d{1,2}/)
  await expect(input).toBeFocused()
  await input.fill(`${NAME} pixiv`)
  await dialog.getByRole('button', { name: 'Create (3)' }).click()
  await expect(dialog).toHaveCount(0)

  // the toast offers to open it; the picks stay picked
  await page.getByRole('status').getByRole('button', { name: 'Open' }).click()
  await expect(page.getByTestId('batch-view')).toBeVisible()
  await expect(page.getByTestId('batch-count')).toHaveText('3 images')
  expect(await tileIds(page)).toEqual(picked)
  batchId = Number(await page.getByTestId('batch-view').getAttribute('data-batch-id'))
  expect(page.url()).toContain(`#/batch/${batchId}`)
  expect(await railSteps(page)).toEqual(['pick', 'censor', 'order', 'name', 'export'])
})

test('the step rail: switch a step off, reorder by keyboard and drag, and it all survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  await page.getByTestId('rail-edit').click()
  const orderBox = page.getByRole('checkbox', { name: 'Switch "Order" on or off' })
  await orderBox.click()
  await expect(orderBox).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Switch "Pick" on or off' })).toBeDisabled()

  // Alt+Up moves Export above Name, and keeps the focus on it
  const exportRow = page.getByRole('button', { name: /^Export \(step 5 of 5/ })
  await exportRow.focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(page.getByRole('button', { name: /^Export \(step 4 of 5/ })).toBeFocused()

  // drag Censor onto Export's place
  const rows = page.getByTestId('rail-edit-row')
  await rows.filter({ hasText: 'Censor' }).dragTo(rows.nth(3))

  const expected = [
    { id: 'pick', enabled: true },
    { id: 'order', enabled: false },
    { id: 'export', enabled: true },
    { id: 'censor', enabled: true },
    { id: 'name', enabled: true },
  ]
  await expect.poll(async () => (await apiJson<ApiBatch>(page, `/api/batches/${batchId}`)).steps).toEqual(expected)

  await page.reload()
  await expect(page.getByTestId('batch-view')).toBeVisible()
  expect(await railSteps(page)).toEqual(['pick', 'export', 'censor', 'name'])
  await page.getByTestId('rail-edit').click()
  await expect(page.getByRole('checkbox', { name: 'Switch "Order" on or off' })).not.toBeChecked()
})

test('save the steps as my template and start a batch from it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  await page.getByTestId('rail-edit').click()
  await page.getByTestId('save-template').click()
  await page.getByTestId('template-name-input').fill(`${NAME} tpl`)
  await page.getByTestId('template-save-ok').click()
  await expect(page.getByTestId('template-dialog')).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText(`Saved template "${NAME} tpl"`)

  await page.getByTestId('batch-back').click()
  await expect(page.getByTestId('batch-list')).toBeVisible()
  await page.getByTestId('new-batch').click()
  await page.getByRole('menuitem', { name: `${NAME} tpl` }).click()
  const dialog = page.getByTestId('batch-create-dialog')
  await expect(dialog).toContainText(`New batch from "${NAME} tpl"`)
  await expect(dialog).toContainText('Steps: Pick → Export → Censor → Name')
  await page.getByTestId('batch-name-input').fill(`${NAME} from tpl`)
  await page.getByTestId('batch-create-ok').click()

  // made on the Batch page: it opens straight away, empty, with the template's steps
  await expect(page.getByTestId('batch-view')).toBeVisible()
  await expect(page.getByTestId('batch-count')).toHaveText('0 images')
  expect(await railSteps(page)).toEqual(['pick', 'export', 'censor', 'name'])
  await expect(page.getByTestId('pick-step')).toContainText('This batch has no images yet')
})

test('take an image out and undo it, open one up close, rename, and the current step is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  await expect(page.getByTestId('pick-tile')).toHaveCount(3)
  const before = await tileIds(page)

  await page.getByTestId('pick-tile').nth(1).click()
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('pick-tile')).toHaveCount(2)
  await expect(page.getByTestId('batch-count')).toHaveText('2 images')
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => tileIds(page)).toEqual(before)

  // arrows move, Enter opens the lightbox (without the library's Pick button), Esc closes only it
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  const lightbox = page.getByTestId('lightbox')
  await expect(lightbox).toBeVisible()
  await expect(lightbox.getByRole('button', { name: /^Pick/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(lightbox).toHaveCount(0)
  await expect(page.getByTestId('batch-view')).toBeVisible()

  await page.getByTestId('batch-name').click()
  await page.getByTestId('inline-name').fill(`${NAME} renamed`)
  await page.getByTestId('inline-name').press('Enter')
  await expect(page.getByTestId('batch-name')).toHaveText(`${NAME} renamed`)

  // the censor step is the editor (v4-censor.spec covers it); order, name and export are v4-pixiv-export.spec's
  await page.getByTestId('rail-step').filter({ hasText: 'Censor' }).click()
  await expect(page.getByTestId('censor-editor')).toBeVisible()
  await page.getByTestId('rail-step').filter({ hasText: 'Name' }).click()
  await expect(page.getByTestId('name-step')).toBeVisible()
  await expect(page.getByTestId('name-row')).toHaveCount(3)
  await expect(page.getByTestId('rail-step').filter({ hasText: 'Pick' })).toContainText('done')
  await expect.poll(async () => (await apiJson<ApiBatch>(page, `/api/batches/${batchId}`)).current_step).toBe('name')
  await page.reload()
  await expect(page.getByTestId('name-step')).toBeVisible()
  const saved = await apiJson<ApiBatch>(page, `/api/batches/${batchId}`)
  expect(saved.name).toBe(`${NAME} renamed`)
})

test('add more from the library through the adding banner', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  await page.getByTestId('rail-step').filter({ hasText: 'Pick' }).click()
  await page.getByTestId('add-from-library').click()
  const banner = page.getByTestId('adding-banner')
  await expect(banner).toContainText(`Adding to "${NAME} renamed"`)
  await expect(page.getByTestId('adding-add')).toBeDisabled()

  const input = page.getByTestId('query-input')
  await input.fill(TOKEN)
  await input.press('Enter')
  await expect(page.getByTestId('result-count')).toHaveText(`${COUNT} images`)
  const tile = page.getByTestId('tile').nth(5)
  const id = Number(await tile.getAttribute('data-id'))
  await tile.click({ modifiers: ['Control'] })
  await page.getByTestId('adding-add').click()

  await expect(page.getByTestId('batch-view')).toBeVisible()
  await expect(page.getByTestId('batch-count')).toHaveText('4 images')
  expect((await tileIds(page)).at(-1)).toBe(id)
})

test('a held Delete and a double click on × take an image out once; undo puts the order back exactly', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  await expect(page.getByTestId('pick-tile')).toHaveCount(4)
  const original = await tileIds(page)
  let deletes = 0
  page.on('request', (req) => {
    if (req.method() === 'DELETE' && /\/api\/batches\/\d+\/items$/.test(req.url())) deletes++
  })
  // Hold each removal on its way to the server so the repeats arrive while it is still pending.
  await page.route(/\/api\/batches\/\d+\/items$/, async (route) => {
    if (route.request().method() === 'DELETE') await new Promise((resolve) => setTimeout(resolve, 600))
    await route.continue()
  })
  const toasts = page.getByRole('status').getByText(/out of the batch/)
  const undo = page.getByRole('status').getByRole('button', { name: 'Undo' })

  // Delete held down (key repeat), then pressed again while the first removal is on its way
  await page.getByTestId('pick-tile').nth(1).click()
  await page.keyboard.down('Delete')
  await page.keyboard.down('Delete')
  await page.keyboard.down('Delete')
  await page.keyboard.up('Delete')
  await page.keyboard.press('Delete')
  await expect.soft(page.getByTestId('pick-tile').nth(1), 'the tile shows it is on its way out').toHaveAttribute('data-pending', 'true')
  await expect(toasts).toHaveCount(1)
  await page.waitForTimeout(900)
  expect(deletes).toBe(1)
  await expect(page.getByTestId('pick-tile')).toHaveCount(3)
  await expect(toasts).toHaveCount(1)
  await expect(undo).toHaveCount(1)
  await undo.click()
  await expect.poll(() => tileIds(page)).toEqual(original)
  expect((await apiJson<ApiBatch>(page, `/api/batches/${batchId}`)).items.map((item) => item.image_id)).toEqual(original)

  // a double click on one image's ×
  await page.getByTestId('pick-tile').nth(2).getByRole('button').dblclick()
  await expect(toasts).toHaveCount(1)
  await page.waitForTimeout(900)
  expect(deletes).toBe(2)
  await expect(page.getByTestId('pick-tile')).toHaveCount(3)
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
  await expect(undo).toHaveCount(1)
  await undo.click()
  await expect.poll(() => tileIds(page)).toEqual(original)
  expect((await apiJson<ApiBatch>(page, `/api/batches/${batchId}`)).items.map((item) => item.image_id)).toEqual(original)
})

test('a change made elsewhere: the next rail edit is refused, the batch reloads and the page says so', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  await expect(page.getByTestId('batch-name')).toHaveText(`${NAME} renamed`)
  // another tab renames the batch: its revision moves on behind this page's back
  const seen = await apiJson<ApiBatch & { revision: number }>(page, `/api/batches/${batchId}`)
  const elsewhere = await page.request.patch(`/api/batches/${batchId}`, { data: { revision: seen.revision, name: `${NAME} renamed elsewhere` } })
  expect(elsewhere.ok()).toBe(true)

  let conflicts = 0
  page.on('response', (res) => {
    if (res.request().method() === 'PATCH' && res.status() === 409) conflicts++
  })
  await page.getByTestId('rail-edit').click()
  const orderBox = page.getByRole('checkbox', { name: 'Switch "Order" on or off' })
  await expect(orderBox).not.toBeChecked()
  await orderBox.click()
  await expect(page.getByRole('status')).toContainText('This batch was just changed somewhere else, so it was reloaded.')
  expect(conflicts).toBe(1)
  // the page now shows the batch as it is: the other tab's name, not the refused step change
  await expect(page.getByTestId('batch-name')).toHaveText(`${NAME} renamed elsewhere`)
  await expect(orderBox).not.toBeChecked()
  const now = await apiJson<ApiBatch & { revision: number }>(page, `/api/batches/${batchId}`)
  expect(now.steps.find((step) => step.id === 'order')?.enabled).toBe(false)

  // the edit works once it is made again
  await orderBox.click()
  await expect(orderBox).toBeChecked()
  await expect.poll(async () => (await apiJson<ApiBatch>(page, `/api/batches/${batchId}`)).steps.find((step) => step.id === 'order')?.enabled).toBe(true)
  await orderBox.click()
  await expect.poll(async () => (await apiJson<ApiBatch>(page, `/api/batches/${batchId}`)).steps.find((step) => step.id === 'order')?.enabled).toBe(false)
  await page.getByTestId('rail-edit').click()

  // the later tests look for the old name
  const last = await apiJson<ApiBatch & { revision: number }>(page, `/api/batches/${batchId}`)
  const back = await page.request.patch(`/api/batches/${batchId}`, { data: { revision: last.revision, name: `${NAME} renamed` } })
  expect(back.ok()).toBe(true)
})

test('Home lists the batch where it was left and opens it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, '#/home')
  const card = page.getByTestId('home-batch').filter({ hasText: `${NAME} renamed` })
  // the card's step track is the batch's own: its order, without Order (switched off above)
  const LABELS: Record<string, string> = { pick: 'Pick', censor: 'Censor', order: 'Order', name: 'Name', export: 'Export' }
  const own = (await apiJson<ApiBatch>(page, `/api/batches/${batchId}`)).steps.filter((step) => step.enabled).map((step) => LABELS[step.id])
  expect(own).not.toContain('Order')
  const track = card.getByTestId('step-track')
  await expect(track.getByRole('listitem')).toHaveText(own)
  await expect(track.locator('[aria-current="step"]')).toHaveText('Pick')
  await card.getByRole('button', { name: `Open "${NAME} renamed"` }).click()
  await expect(page.getByTestId('batch-view')).toHaveAttribute('data-batch-id', String(batchId))
})

test('delete a batch: the confirmation starts on Cancel and says originals stay', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, '#/batch')
  const row = page.getByTestId('batch-row').filter({ hasText: `${NAME} from tpl` })
  const id = Number(await row.getAttribute('data-batch-id'))
  await row.getByRole('button', { name: 'Delete…' }).click()
  const dialog = page.getByTestId('batch-delete-dialog')
  await expect(dialog).toContainText('Original images and their library records, ratings and tags stay as they are.')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(row).toBeVisible()

  await row.getByRole('button', { name: 'Delete…' }).click()
  await page.getByTestId('batch-delete-ok').click()
  await expect(row).toHaveCount(0)
  const status = await page.evaluate(async (x) => (await fetch(`/api/batches/${x}`)).status, id)
  expect(status).toBe(404)
})

test('a V3.5 collection opens as a custom batch in its order and stays unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, '#/batch')
  const before = (await apiJson<{ image_ids: number[] }>(page, `/api/collections/${collectionId}/images`)).image_ids
  expect(before).toHaveLength(3)

  await page.getByTestId('collection-row').filter({ hasText: 'v4bat collection' }).getByRole('button', { name: 'Make a batch' }).click()
  const view = page.getByTestId('batch-view')
  await expect(view).toBeVisible()
  await expect(view).toContainText('Custom')
  expect(await tileIds(page)).toEqual(before)
  const id = Number(await view.getAttribute('data-batch-id'))
  const made = await apiJson<ApiBatch>(page, `/api/batches/${id}`)
  expect(made.kind).toBe('custom')
  expect(made.settings.source_collection_id).toBe(collectionId)

  const after = (await apiJson<{ image_ids: number[] }>(page, `/api/collections/${collectionId}/images`)).image_ids
  expect(after).toEqual(before)
})

for (const viewport of VIEWPORTS) {
  test(`batch pages fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openLibrary(page, TOKEN, COUNT)
    await page.getByTestId('tile').nth(0).click({ modifiers: ['Control'] })
    const bar = page.getByTestId('selection-bar')
    expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    await page.getByTestId('add-to-batch').click()
    for (const item of await page.getByRole('menu').getByRole('menuitem').all()) {
      await expect(item).toBeInViewport({ ratio: 1 })
    }
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(bar).toBeVisible()

    await page.getByRole('button', { name: 'Batches', exact: true }).click()
    await expect(page.getByTestId('new-batch')).toBeInViewport({ ratio: 1 })
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)

    await page.getByTestId('batch-row').filter({ hasText: `${NAME} renamed` }).getByRole('button', { name: 'Open', exact: true }).click()
    await expect(page.getByTestId('add-from-library')).toBeInViewport({ ratio: 1 })
    await page.getByTestId('rail-edit').click()
    await expect(page.getByTestId('save-template')).toBeInViewport({ ratio: 1 })
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    await page.getByTestId('rail-edit').click()

    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await expect(page.getByTestId('home-start-sort')).toBeInViewport({ ratio: 1 })
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  })
}
