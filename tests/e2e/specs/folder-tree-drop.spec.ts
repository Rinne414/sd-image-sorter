import fs from 'node:fs'
import path from 'node:path'

import type { APIRequestContext } from '@playwright/test'

import { expect, test, type Page } from '../fixtures/click-ledger'
import { scanAndWait } from '../fixtures/scan-wait'
import { seedPictures } from '../fixtures/seed-library'

/**
 * Dropping a picture on a folder in the sidebar moves its file there: the
 * same question as "Move…" (how many, where to), the same move, the same Undo.
 * Runs against real files in two scratch folders.
 */

const IMAGE_DRAG = 'application/x-sd-sorter-images'
let fromFolder = ''
let toFolder = ''
const FILE = 'folder-drop-from-seed-0.png'

/**
 * Put the picture back where it starts and make the library agree: a run that
 * stopped half-way leaves the file, or a record of it, in the other folder.
 */
async function resetScratch(request: APIRequestContext) {
  const base = path.join(__dirname, '..', '..', '..', '.tmp', 'manual-test')
  const moved = path.join(base, 'folder-drop-to', FILE)
  const home = path.join(base, 'folder-drop-from', FILE)
  // The Gallery only lists records whose file exists, so a record left without
  // its file is made visible first, then forgotten together with the file.
  if (!fs.existsSync(moved) && fs.existsSync(home)) {
    fs.mkdirSync(path.dirname(moved), { recursive: true })
    fs.copyFileSync(home, moved)
  }
  if (!fs.existsSync(moved)) return
  // A record marked unreadable is listed again only after its folder is scanned.
  await scanAndWait(request, path.dirname(moved))
  const found = await (await request.get('/api/images', { params: { search: FILE, limit: 20 } })).json()
  const stale = (found.images as Array<{ id: number; path: string }>)
    .filter((image) => image.path.split(path.win32.sep).join('/').includes('/folder-drop-to/'))
    .map((image) => image.id)
  if (stale.length) await request.post('/api/images/remove-selected', { data: { image_ids: stale } })
  if (!fs.existsSync(home)) fs.renameSync(moved, home)
  else fs.rmSync(moved)
}

test.beforeAll(async ({ request }) => {
  await resetScratch(request)
  fromFolder = await seedPictures(request, 'folder-drop-from', 2)
  toFolder = await seedPictures(request, 'folder-drop-to', 1)
})

test.afterAll(async ({ request }) => {
  await resetScratch(request)
})

async function openGallery(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
}

/** Show the folder's row, opening its parents in the tree as needed. */
async function folderRow(page: Page, folder: string) {
  await page.evaluate((target) => {
    const tree = (window as any).FolderTreeUI
    tree._expandAncestors?.(String(target).replace(/\\/g, '/'))
    tree._renderTree?.()
  }, folder)
  const name = path.basename(folder)
  const row = page.locator('#folder-tree .folder-row').filter({ has: page.locator(`.folder-row-open[data-path$="${name}"]`) })
  await expect(row).toHaveCount(1)
  return row
}

/** A drag from the Gallery carrying these pictures, sent to `selector` as `type`. */
function dragEvent(page: Page, selector: string, type: string, ids: number[]) {
  return page.evaluate(([target, eventType, dragType, list]) => {
    const data = new DataTransfer()
    data.setData(dragType as string, JSON.stringify({ ids: list, token: null }))
    const node = document.querySelector(target as string)!
    return node.dispatchEvent(new DragEvent(eventType as string, { dataTransfer: data, bubbles: true, cancelable: true }))
  }, [selector, type, IMAGE_DRAG, ids] as const)
}

test('a picture dropped on a folder row is moved there after the usual question, and Undo brings it back', async ({ page }) => {
  await openGallery(page)
  const id = await page.evaluate(async (name) => {
    const found = await (window as any).App.API.getImages({ search: name, limit: 5 })
    return Number(found.images.find((image: { filename: string }) => image.filename === name).id)
  }, FILE)
  const row = await folderRow(page, toFolder)
  const rowSelector = `#folder-tree .folder-row[data-path$="${path.basename(toFolder)}"]`

  // The row lights up under the drag, and only under a drag that carries pictures.
  // (A real drag sends dragover continuously; the tree may redraw once after the scan above, so ask again.)
  await expect(async () => {
    expect(await dragEvent(page, rowSelector, 'dragover', [id])).toBe(false) // default prevented: a drop is allowed
    await expect(row).toHaveClass(/is-drop-target/, { timeout: 500 })
  }).toPass({ timeout: 10_000 })

  await dragEvent(page, rowSelector, 'drop', [id])
  await expect(row).not.toHaveClass(/is-drop-target/)
  // The same question "Move…" asks, with the folder already named: nothing has moved yet.
  const confirm = page.locator('#confirm-modal.visible')
  await expect(confirm.locator('#confirm-message')).toContainText('folder-drop-to')
  expect(fs.existsSync(path.join(fromFolder, FILE))).toBe(true)

  // The drop is ours alone: the page's own "drop files to import" did not open as well.
  await expect(page.locator('#scan-modal.visible')).toHaveCount(0)
  await confirm.locator('#btn-confirm-ok').click()
  const done = page.locator('.toast').filter({ hasText: 'Move completed for 1 image.' })
  await expect(done).toBeVisible({ timeout: 30_000 })
  expect(fs.existsSync(path.join(toFolder, FILE))).toBe(true)
  expect(fs.existsSync(path.join(fromFolder, FILE))).toBe(false)

  await done.locator('.toast-action-btn').click()
  await expect.poll(() => fs.existsSync(path.join(fromFolder, FILE)), { timeout: 30_000 }).toBe(true)
  expect(fs.existsSync(path.join(toFolder, FILE))).toBe(false)
})

test('answering No moves nothing, and a drag without pictures is not a drop here', async ({ page }) => {
  await openGallery(page)
  const id = await page.evaluate(async (name) => {
    const found = await (window as any).App.API.getImages({ search: name, limit: 5 })
    return Number(found.images.find((image: { filename: string }) => image.filename === name).id)
  }, FILE)
  const row = await folderRow(page, toFolder)
  const rowSelector = `#folder-tree .folder-row[data-path$="${path.basename(toFolder)}"]`

  await dragEvent(page, rowSelector, 'drop', [id])
  await page.locator('#confirm-modal.visible #btn-confirm-cancel').click()
  await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)
  expect(fs.existsSync(path.join(fromFolder, FILE))).toBe(true)

  // A file dragged in from the desktop is not a library picture: the row does not take it.
  const taken = await page.evaluate((target) => {
    const data = new DataTransfer()
    data.setData('text/plain', 'not a picture drag')
    return !document.querySelector(target)!.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }))
  }, rowSelector)
  expect(taken).toBe(false)
  await expect(row).not.toHaveClass(/is-drop-target/)
})

test('a move can still be undone from "Recent moves" after its message is gone', async ({ page }) => {
  await openGallery(page)
  const id = await page.evaluate(async (name) => {
    const found = await (window as any).App.API.getImages({ search: name, limit: 5 })
    return Number(found.images.find((image: { filename: string }) => image.filename === name).id)
  }, FILE)
  await folderRow(page, toFolder)
  const rowSelector = `#folder-tree .folder-row[data-path$="${path.basename(toFolder)}"]`
  await dragEvent(page, rowSelector, 'drop', [id])
  await page.locator('#confirm-modal.visible #btn-confirm-ok').click()
  await expect.poll(() => fs.existsSync(path.join(toFolder, FILE)), { timeout: 30_000 }).toBe(true)

  // The message and its Undo are gone: a reload, as if the user came back later.
  await page.reload()
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  await expect(page.locator('.toast-action-btn')).toHaveCount(0)

  // More > Recent moves lists the run first, with what it did and where to.
  await page.evaluate(() => (window as any).RecentMoves.open())
  const first = page.locator('#recent-moves-list .recent-moves-row').first()
  await expect(first.locator('.recent-moves-what')).toHaveText('Moved 1 file')
  await expect(first.locator('.recent-moves-where')).toContainText('folder-drop-to')
  await expect(first.locator('.recent-moves-when')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

  await first.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => fs.existsSync(path.join(fromFolder, FILE)), { timeout: 30_000 }).toBe(true)
  expect(fs.existsSync(path.join(toFolder, FILE))).toBe(false)
  // The run stays in the list, marked, and cannot be undone twice.
  const again = page.locator('#recent-moves-list .recent-moves-row').first()
  await expect(again.locator('.recent-moves-state')).toHaveText('Undone')
  await expect(again.getByRole('button', { name: 'Undo' })).toHaveCount(0)

  // The same door is in the More menu, and the dialog fits the window.
  await page.keyboard.press('Escape')
  await expect(page.locator('#recent-moves-modal')).not.toHaveClass(/visible/)
  expect(await page.locator('#nav-tools-recent-moves').count()).toBe(1)
})

test('in the desktop program, where a card drag is a drag of the real files, a folder row still takes it', async ({ page }) => {
  // The desktop program's side of the drag: it starts an OS drag of the files and answers when that ends.
  await page.addInitScript(() => {
    ;(window as any).sdDesktop = {
      startDrag: (ids: number[]) => {
        ;(window as any).__nativeDrag = ids
        return new Promise(() => {})
      },
    }
  })
  await openGallery(page)
  const row = await folderRow(page, toFolder)
  const rowSelector = `#folder-tree .folder-row[data-path$="${path.basename(toFolder)}"]`
  const filesDrag = (type: string) => page.evaluate(([target, eventType]) => {
    const data = new DataTransfer()
    data.items.add(new File(['x'], 'dragged.png', { type: 'image/png' }))
    return document.querySelector(target)!.dispatchEvent(new DragEvent(eventType, { dataTransfer: data, bubbles: true, cancelable: true }))
  }, [rowSelector, type] as const)

  // Files from somewhere else (Explorer) are not library pictures: the row leaves them to the page's import drop.
  await filesDrag('dragover')
  await expect(row).not.toHaveClass(/is-drop-target/)

  // A card is dragged: the desktop program is asked for the real files of that picture.
  const cardId = await page.evaluate(() => {
    const card = document.querySelector('#gallery-grid .gallery-item[data-id]') as HTMLElement
    card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true }))
    return Number(card.dataset.id)
  })
  await expect.poll(() => page.evaluate(() => (window as any).__nativeDrag)).toEqual([cardId])

  await expect(async () => {
    expect(await filesDrag('dragover')).toBe(false) // default prevented: a drop is allowed
    await expect(row).toHaveClass(/is-drop-target/, { timeout: 500 })
  }).toPass({ timeout: 10_000 })
  await filesDrag('drop')

  // The usual question, for that one picture; the import dialog did not open as well.
  const confirm = page.locator('#confirm-modal.visible')
  await expect(confirm.locator('#confirm-message')).toContainText('folder-drop-to')
  await expect(page.locator('#scan-modal.visible')).toHaveCount(0)
  await confirm.locator('#btn-confirm-cancel').click()
})
