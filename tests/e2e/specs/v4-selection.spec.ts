import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, openLibrary, pageOverflow, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 selection actions: move / copy through the folder browser, remove from
 * the library, the Trash (stubbed: a real run would fill the OS Recycle Bin),
 * select every match, and the jobs drawer.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4seltoken'
const PREFIX = 'v4sel-'
const COUNT = 8
const DIR = 'v4-sel'
const DEST = 'v4-sel-dest'
const BULK_TOKEN = 'v4selbulk'
const BULK_PREFIX = 'v4selbulk-'
const BULK_COUNT = 250
const BULK_DIR = 'v4-sel-bulk'

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  seedImages({ prefix: BULK_PREFIX, token: BULK_TOKEN, count: BULK_COUNT, dir: BULK_DIR })
  fs.rmSync(path.join(tmpRoot, DEST), { recursive: true, force: true })
  fs.mkdirSync(path.join(tmpRoot, DEST, 'inbox'), { recursive: true })
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR, DEST])
  cleanupImages(BULK_PREFIX, [BULK_DIR])
})

async function pick(page: Page, ...indexes: number[]): Promise<{ ids: string[]; names: string[] }> {
  const tiles = page.getByTestId('tile')
  const ids: string[] = []
  const names: string[] = []
  for (const i of indexes) {
    await tiles.nth(i).click({ modifiers: ['Control'] })
    ids.push((await tiles.nth(i).getAttribute('data-id'))!)
    names.push((await tiles.nth(i).getAttribute('title'))!)
  }
  return { ids, names }
}

async function pathOf(page: Page, id: string): Promise<string> {
  return page.evaluate(async (x) => (await (await fetch(`/api/images/${x}`)).json()).image.path, id)
}

for (const viewport of VIEWPORTS) {
  test(`selection bar, More menu and folder browser fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      await openLibrary(page, TOKEN, COUNT, theme)
      await pick(page, 0, 1)
      const bar = page.getByTestId('selection-bar')
      for (const name of ['Add to batch', 'Move to…', 'More', 'Clear']) {
        await expect(bar.getByRole('button', { name, exact: false }).first()).toBeInViewport({ ratio: 1 })
      }
      await expect(bar.getByTestId('select-all-matching')).toBeInViewport({ ratio: 1 })
      expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)

      // the More menu opens upward from the bottom bar and every item is reachable
      await bar.getByRole('button', { name: 'More' }).click()
      for (const item of await page.getByRole('menu').getByRole('menuitem').all()) {
        await expect(item).toBeInViewport({ ratio: 1 })
      }
      await page.keyboard.press('Escape')

      await bar.getByRole('button', { name: 'Move to…' }).click()
      const picker = page.getByTestId('folder-picker')
      await expect(picker).toBeInViewport({ ratio: 1 })
      await expect(picker.getByRole('button', { name: 'Move 2 here' })).toBeInViewport({ ratio: 1 })
      await page.keyboard.press('Escape')
      await expect(picker).toHaveCount(0)
      await expect(bar).toContainText('2 picked')
    }
  })
}

test('move and copy go through the folder browser', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const { ids, names } = await pick(page, 0, 1)
  const bar = page.getByTestId('selection-bar')
  await bar.getByRole('button', { name: 'Move to…' }).click()

  // it opens in the folder of the first pick
  const picker = page.getByTestId('folder-picker')
  const pathInput = page.getByTestId('folder-path')
  await expect(pathInput).toHaveValue(path.join(tmpRoot, DIR))

  // type a place, open a subfolder, make a new one inside it
  await pathInput.fill(tmpRoot)
  await pathInput.press('Enter')
  await picker.getByRole('button', { name: DEST, exact: true }).click()
  await expect(pathInput).toHaveValue(path.join(tmpRoot, DEST))
  await expect(picker.getByRole('button', { name: 'inbox', exact: true })).toBeVisible()
  await picker.getByRole('button', { name: 'New folder' }).click()
  await page.getByTestId('folder-new-name').fill('keep')
  await page.getByTestId('folder-new-name').press('Enter')
  const keep = path.join(tmpRoot, DEST, 'keep')
  await expect(page.getByTestId('folder-target')).toContainText(keep)
  await picker.getByRole('button', { name: 'Move 2 here' }).click()
  await expect(picker).toHaveCount(0)

  // files land in the new folder and leave the old one; the library follows
  await expect.poll(() => names.every((n) => fs.existsSync(path.join(keep, n)))).toBe(true)
  expect(names.some((n) => fs.existsSync(path.join(tmpRoot, DIR, n)))).toBe(false)
  await expect.poll(() => pathOf(page, ids[0]!)).toBe(path.join(keep, names[0]!))

  // the drawer reports it; picks stay so they can go somewhere else next
  await page.getByTestId('jobs-button').click()
  const drawer = page.getByTestId('jobs-drawer')
  await expect(drawer).toBeInViewport()
  await expect(drawer.getByTestId('job').first()).toContainText('Moved 2')
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(bar).toContainText('2 picked')

  // copy: the last destination is offered first
  await page.keyboard.press('Escape')
  const third = await pick(page, 2)
  await bar.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Copy to…' }).click()
  await page.getByTestId('folder-recent').getByRole('button', { name: /keep$/ }).click()
  await expect(pathInput).toHaveValue(keep)
  await picker.getByRole('button', { name: 'Copy 1 here' }).click()
  await expect.poll(() => fs.existsSync(path.join(keep, third.names[0]!))).toBe(true)
  expect(fs.existsSync(path.join(tmpRoot, DIR, third.names[0]!))).toBe(true)
})

test('select every match, then Delete removes them from the library and keeps the files', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, BULK_TOKEN, BULK_COUNT)
  await page.getByTestId('tile').first().click()
  await page.keyboard.press('Control+a')
  const bar = page.getByTestId('selection-bar')
  await expect(bar).not.toContainText(`${BULK_COUNT} picked`)
  await bar.getByTestId('select-all-matching').click()
  await expect(bar).toContainText(`${BULK_COUNT} picked`)
  await expect(bar.getByTestId('select-all-matching')).toHaveCount(0)

  await page.keyboard.press('Delete')
  const confirm = page.getByTestId('confirm-dialog')
  await expect(confirm).toBeInViewport()
  await confirm.getByRole('button', { name: `Remove ${BULK_COUNT} from library` }).click()
  await expect(page.getByTestId('result-count')).toHaveText('0 images')
  await expect(bar).toHaveCount(0)
  expect(fs.existsSync(path.join(tmpRoot, BULK_DIR, `${BULK_PREFIX}00.png`))).toBe(true)
})

test('Trash asks first, sends the confirmation, and names what failed', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  // stubbed after load, so the start-up job check still talks to the real backend
  let body: { image_ids: number[]; confirm_delete_files: boolean } | null = null
  let polls = 0
  await page.route('**/api/images/delete-selected/start', async (route) => {
    body = route.request().postDataJSON()
    await route.fulfill({ json: { status: 'started', total: 2, operation: 'delete' } })
  })
  await page.route('**/api/images/delete-selected/progress', async (route) => {
    polls += 1
    const failedId = body?.image_ids[1] ?? 0
    await route.fulfill({
      json: polls < 2
        ? { status: 'running', current: 1, total: 2, deleted: 1, errors: 0, failed: [], recent_errors: [] }
        : {
            status: 'done', current: 2, total: 2, deleted: 1, errors: 1,
            failed: [{ image_id: failedId, filename: 'locked.png', error: 'Recycle Bin is not available' }],
          },
    })
  })

  await pick(page, 3, 4)
  const bar = page.getByTestId('selection-bar')
  const confirm = page.getByTestId('confirm-dialog')
  await bar.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Move to Trash…' }).click()
  await expect(confirm).toContainText('2')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  expect(body).toBeNull()

  await bar.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Move to Trash…' }).click()
  await confirm.getByRole('button', { name: 'Move 2 to Trash' }).click()
  await expect.poll(() => body?.confirm_delete_files).toBe(true)
  expect(body!.image_ids).toHaveLength(2)

  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  await expect(job).toContainText('locked.png')
  await expect(job).toContainText('Recycle Bin is not available')
  await job.getByRole('button', { name: 'Pick the 1 that failed' }).click()
  await expect(bar).toContainText('1 picked')
})

test('a running job can be stopped from the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  let stopped = false
  await page.route('**/api/move/start', (route) => route.fulfill({ json: { status: 'started', total: 2, operation: 'move' } }))
  await page.route('**/api/move/progress', (route) =>
    route.fulfill({
      json: stopped
        ? { status: 'cancelled', current: 1, total: 2, moved: 1, errors: 0, operation: 'move', results: [], recent_errors: [] }
        : { status: 'running', current: 1, total: 2, moved: 1, errors: 0, operation: 'move', current_item: 'v4sel-05.png', results: [], recent_errors: [] },
    }),
  )
  await page.route('**/api/move/cancel', (route) => {
    stopped = true
    return route.fulfill({ json: { status: 'cancelling' } })
  })

  await pick(page, 5, 6)
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Move to…' }).click()
  await page.getByTestId('folder-picker').getByRole('button', { name: 'Move 2 here' }).click()
  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  await expect(job).toContainText('v4sel-05.png')
  await job.getByRole('button', { name: 'Stop' }).click()
  await expect(job).toContainText('Stopped')
  expect(stopped).toBe(true)
})
