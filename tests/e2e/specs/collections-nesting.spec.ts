import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, seedImages } from '../fixtures/v4-seed'

/**
 * Collections inside collections in the classic sidebar: make one inside
 * another, fold a parent (remembered), drag a collection into another and back
 * to the top level (never into itself), Move to..., drag pictures onto a
 * collection (a picked picture brings the picks), and deleting a parent keeps
 * the ones inside it. Real backend, isolated test database.
 */

test.use({ viewport: { width: 1920, height: 1080 } })
test.describe.configure({ mode: 'serial' })

const PREFIX = 'nestcol-'
const DIR = 'nest-collections'
const NAME = 'Nest '

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: 'nestcoltoken', count: 6, dir: DIR })
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR])
})

type Row = { id: number; name: string; parent_id: number | null; item_count: number }

async function collections(page: Page): Promise<Row[]> {
  const body = await (await page.request.get('/api/collections')).json()
  return body.collections.filter((row: Row) => row.name.startsWith(NAME))
}

async function make(page: Page, name: string, parentId?: number): Promise<number> {
  const response = await page.request.post('/api/collections', { data: { name: NAME + name, ...(parentId ? { parent_id: parentId } : {}) } })
  expect(response.ok()).toBe(true)
  return (await response.json()).id
}

async function parentOf(page: Page, id: number): Promise<number | null> {
  return (await collections(page)).find((row) => row.id === id)?.parent_id ?? null
}

test.afterEach(async ({ page }) => {
  // Children first, so a delete never lifts one we are about to delete anyway.
  for (const row of (await collections(page)).reverse()) await page.request.delete(`/api/collections/${row.id}`)
})

async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('aurora-entry-skip', '1')
  })
  await page.goto('/')
  await expect(page.locator('#collections-list .collection-row').first()).toBeVisible()
  await settled(page)
}

const row = (page: Page, id: number) => page.locator(`#collections-list .collection-row[data-id="${id}"]`)

/** A row's buttons show on hover (or keyboard focus), as a person reaches them. */
async function openMore(page: Page, id: number) {
  await row(page, id).hover()
  await row(page, id).locator('[data-action="more"]').click()
}

async function menuItem(page: Page, name: string | RegExp) {
  return page.locator('.collections-picker-menu .context-menu-item').filter({ hasText: name })
}

/**
 * HTML5 drag with the real mouse: the drop strip only exists once the drag has
 * started. `accepted`: the target must light up before the drop (false: a
 * refused target stays dark).
 */
async function drag(page: Page, from: import('@playwright/test').Locator, to: () => import('@playwright/test').Locator, accepted = true) {
  const start = (await from.boundingBox())!
  await page.mouse.move(start.x + 40, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + 46, start.y + start.height / 2 + 6, { steps: 3 })
  const target = to()
  await expect(target).toBeVisible()
  const end = (await target.boundingBox())!
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 })
  if (accepted) await expect(target).toHaveClass(/is-drop-target/)
  else await expect(target).not.toHaveClass(/is-drop-target/)
  await page.mouse.up()
}

/** The sidebar list has stopped redrawing (it reloads once more after start). */
async function settled(page: Page) {
  await page.waitForLoadState('networkidle')
  const html = () => page.locator('#collections-list').innerHTML()
  await expect.poll(async () => { const before = await html(); await page.waitForTimeout(250); return before === (await html()) }).toBe(true)
}

test('a collection made inside another sits under it, and folding the parent is remembered', async ({ page }) => {
  const outer = await make(page, 'Outer')
  await open(page)
  await openMore(page, outer)
  await (await menuItem(page, 'New collection inside')).click()
  await expect(page.locator('#input-modal-message')).toContainText(`inside "${NAME}Outer"`)
  await page.locator('#input-modal-field').fill(`${NAME}Inner`)
  await page.locator('#btn-input-ok').click()

  await expect.poll(async () => (await collections(page)).find((r) => r.name === `${NAME}Inner`)?.parent_id).toBe(outer)
  const inner = (await collections(page)).find((r) => r.name === `${NAME}Inner`)!.id
  await expect(row(page, inner)).toHaveAttribute('data-depth', '1')
  const fold = row(page, outer).locator('[data-action="fold"]')
  await expect(fold).toHaveAttribute('aria-expanded', 'true')

  await fold.click()
  await expect(row(page, inner)).toHaveCount(0)
  await page.reload()
  await expect(row(page, outer)).toBeVisible()
  await expect(row(page, inner)).toHaveCount(0)
  await row(page, outer).locator('[data-action="fold"]').click()
  await expect(row(page, inner)).toBeVisible()
})

test('dragging puts a collection inside another and back at the top, never inside itself', async ({ page }) => {
  const a = await make(page, 'A')
  const b = await make(page, 'B')
  await open(page)

  await drag(page, row(page, b), () => row(page, a))
  await expect.poll(() => parentOf(page, b)).toBe(a)
  await expect(page.locator('.toast').last()).toContainText(`Moved ${NAME}B into ${NAME}A`)
  await expect(row(page, b)).toHaveAttribute('data-depth', '1')

  // A onto its own child B: refused, nothing moves.
  await drag(page, row(page, a), () => row(page, b), false)
  await page.waitForTimeout(300)
  expect(await parentOf(page, a)).toBeNull()

  // B (inside A) onto the top-level strip.
  await drag(page, row(page, b), () => page.locator('#collections-drop-top'))
  await expect.poll(() => parentOf(page, b)).toBeNull()
  await expect(page.locator('#collections-drop-top')).toBeHidden()
})

test('Move to... offers only places the collection may go, and moves it', async ({ page }) => {
  const a = await make(page, 'A')
  const b = await make(page, 'B', a)
  const c = await make(page, 'C', b)
  const other = await make(page, 'Other')
  await open(page)

  await openMore(page, a)
  await (await menuItem(page, 'Move to')).click()
  const menu = page.locator('.collections-picker-menu')
  await expect(menu).toContainText(`Move "${NAME}A" to`)
  await expect(menu.locator('.context-menu-item').filter({ hasText: 'Top level' })).toHaveAttribute('aria-current', 'true')
  await expect(menu).toContainText(`${NAME}Other`)
  for (const blocked of [`${NAME}A`, `${NAME}B`, `${NAME}C`, 'Favorites']) {
    await expect(menu.locator('.context-menu-item').filter({ hasText: new RegExp(`^${blocked}$`) })).toHaveCount(0)
  }
  await menu.locator('.context-menu-item').filter({ hasText: `${NAME}Other` }).click()
  await expect.poll(() => parentOf(page, a)).toBe(other)

  // C back to the top level, from deep inside.
  await openMore(page, c)
  await (await menuItem(page, 'Move to')).click()
  await page.locator('.collections-picker-menu .context-menu-item').filter({ hasText: 'Top level' }).click()
  await expect.poll(() => parentOf(page, c)).toBeNull()
  expect(await parentOf(page, b)).toBe(a)
})

test('dragging pictures onto a collection adds them; a picked picture brings every pick', async ({ page }) => {
  const target = await make(page, 'Drop')
  await open(page)
  const card = (n: number) => page.locator(`#gallery-grid .gallery-item[aria-label^="${PREFIX}0${n}.png"]`)
  // Only this spec's pictures: other specs leave newer ones in the shared test library.
  await page.locator('#gallery-search-input').fill('nestcoltoken')
  await page.locator('#gallery-search-input').press('Enter')
  await expect(card(0)).toBeVisible()
  await settled(page)

  await drag(page, card(0), () => row(page, target))
  await expect(page.locator('.toast').filter({ hasText: `to ${NAME}Drop` }).last()).toContainText(/Added 1 images? to/)
  await expect.poll(async () => (await collections(page)).find((r) => r.id === target)?.item_count).toBe(1)
  // The gallery's own drop (import files) did not also take it.
  await expect(page.locator('#scan-modal')).not.toHaveClass(/visible/)

  await page.evaluate(() => (window as any).App.setSelectionMode(true))
  await card(1).click({ position: { x: 40, y: 40 } })
  await card(2).click({ position: { x: 40, y: 40 } })
  await drag(page, card(1), () => row(page, target))
  await expect.poll(async () => (await collections(page)).find((r) => r.id === target)?.item_count).toBe(3)
  await expect(row(page, target).locator('.collection-row-count')).toHaveText('3')
})

test('a dragged stack carries its whole run unless the stack itself is picked', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(() => {
    const w = window as any
    const cover = w.Gallery.images[0].id
    w.App.setSelectionMode(true)
    w.Gallery.toggleSelection(cover)
    // A Group runs stack whose cover alone is picked does not look picked: it carries its run.
    const stack = document.createElement('div')
    stack.dataset.runIds = `${cover},999001,999002`
    const partly = w.CollectionsTree.imagePayload({ id: cover }, stack)
    // Picked as a whole (the tile shows it picked): it carries the picks.
    stack.classList.add('selected')
    const whole = w.CollectionsTree.imagePayload({ id: cover }, stack)
    w.Gallery.clearSelection()
    return { cover, partly: partly.ids, whole: whole.ids }
  })
  expect(result.partly).toEqual([result.cover, 999001, 999002])
  expect(result.whole).toEqual([result.cover])
})

test('deleting a collection keeps the ones inside it, one level up', async ({ page }) => {
  const parent = await make(page, 'Parent')
  const child = await make(page, 'Child', parent)
  await open(page)
  await row(page, parent).hover()
  await row(page, parent).locator('[data-action="delete"]').click()
  await page.locator('#btn-confirm-ok').click()
  await expect(row(page, parent)).toHaveCount(0)
  await expect(row(page, child)).toHaveAttribute('data-depth', '0')
  expect(await parentOf(page, child)).toBeNull()
})
