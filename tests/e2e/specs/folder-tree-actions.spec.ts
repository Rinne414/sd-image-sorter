import fs from 'node:fs'
import path from 'node:path'

import type { APIRequestContext } from '@playwright/test'

import { expect, test, type Page } from '../fixtures/click-ledger'
import { scanAndWait } from '../fixtures/scan-wait'
import { seedPictures } from '../fixtures/seed-library'

/**
 * A folder row in the sidebar has its own actions: rename the folder (on
 * disk, its pictures stay in the library, Undo names it back) and move the
 * selection into a new folder inside it. Runs on real files in a scratch folder.
 */

const BASE = path.join(__dirname, '..', '..', '..', '.tmp', 'manual-test')
const HOME = path.join(BASE, 'folder-actions-a')
const RENAMED = path.join(BASE, 'folder-actions-b')
const INNER = path.join(HOME, 'inner-new')
const FILES = ['folder-actions-a-seed-0.png', 'folder-actions-a-seed-1.png']

/** Put the scratch folder back the way a fresh run expects it, on disk and in the library. */
async function resetScratch(request: APIRequestContext) {
  if (fs.existsSync(RENAMED)) {
    if (fs.existsSync(HOME)) fs.rmSync(RENAMED, { recursive: true, force: true })
    else fs.renameSync(RENAMED, HOME)
  }
  if (fs.existsSync(INNER)) {
    for (const name of fs.readdirSync(INNER)) {
      const home = path.join(HOME, name)
      if (fs.existsSync(home)) fs.rmSync(path.join(INNER, name))
      else fs.renameSync(path.join(INNER, name), home)
    }
    fs.rmSync(INNER, { recursive: true, force: true })
  }
  if (!fs.existsSync(HOME)) return
  await scanAndWait(request, HOME)
  for (const name of FILES) {
    const found = await (await request.get('/api/images', { params: { search: name, limit: 20 } })).json()
    const stale = (found.images as Array<{ id: number; path: string }>)
      .filter((image) => {
        const where = image.path.split(path.win32.sep).join('/')
        return where.includes('/folder-actions-b/') || where.includes('/inner-new/')
      })
      .map((image) => image.id)
    if (stale.length) await request.post('/api/images/remove-selected', { data: { image_ids: stale } })
  }
}

test.beforeAll(async ({ request }) => {
  await resetScratch(request)
  await seedPictures(request, 'folder-actions-a', 2)
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
async function folderRow(page: Page, name: string) {
  await page.evaluate(async (target) => {
    const tree = (window as any).FolderTreeUI
    await tree.refresh()
    const full = tree._folders.map((folder: string) => folder.replace(/\\/g, '/')).find((folder: string) => folder.endsWith(`/${target}`))
    if (full) tree._expandAncestors(full)
    tree._renderTree()
  }, name)
  const row = page.locator(`#folder-tree .folder-row[data-path$="/${name}"]`)
  await expect(row).toHaveCount(1)
  return row
}

async function answerInput(page: Page, value: string) {
  const modal = page.locator('#input-modal.visible')
  await expect(modal).toBeVisible()
  await modal.locator('#input-modal-field').fill(value)
  await modal.locator('#btn-input-ok').click()
}

test('a folder is renamed from its row, its pictures follow, and Undo names it back', async ({ page }) => {
  await openGallery(page)
  const row = await folderRow(page, 'folder-actions-a')
  await row.hover()
  await row.locator('.folder-row-more').click()
  const menu = page.locator('.folder-row-menu')
  await expect(menu.locator('.context-menu-item')).toHaveCount(2)
  // Nothing is selected, so there is nothing to move into a new folder: the row says why.
  await expect(menu.locator('.context-menu-item').nth(1)).toBeDisabled()
  await expect(menu.locator('.context-menu-item').nth(1)).toHaveAttribute('title', 'Select the pictures to move first.')

  await menu.locator('.context-menu-item').first().click()
  await expect(page.locator('#input-modal-field')).toHaveValue('folder-actions-a')
  await answerInput(page, 'folder-actions-b')

  const done = page.locator('.toast').filter({ hasText: 'Renamed to folder-actions-b. Pictures that followed: 2.' })
  await expect(done).toBeVisible({ timeout: 15_000 })
  expect(fs.existsSync(path.join(RENAMED, FILES[0]))).toBe(true)
  expect(fs.existsSync(HOME)).toBe(false)
  await expect(page.locator('#folder-tree .folder-row[data-path$="/folder-actions-b"]')).toHaveCount(1)
  await expect(page.locator('#folder-tree .folder-row[data-path$="/folder-actions-a"]')).toHaveCount(0)
  // The pictures are the same records at the new place, not missing ones.
  const where = await page.evaluate(async (name) => {
    const found = await (window as any).App.API.getImages({ search: name, limit: 5 })
    return found.images.map((image: { path: string }) => image.path.replace(/\\/g, '/'))
  }, FILES[0])
  expect(where).toHaveLength(1)
  expect(where[0]).toContain('/folder-actions-b/')

  await done.locator('button', { hasText: 'Undo' }).click()
  await expect(page.locator('#folder-tree .folder-row[data-path$="/folder-actions-a"]')).toHaveCount(1, { timeout: 15_000 })
  expect(fs.existsSync(path.join(HOME, FILES[0]))).toBe(true)
  expect(fs.existsSync(RENAMED)).toBe(false)
})

test('a name that is taken is refused in words, and nothing changes', async ({ page }) => {
  fs.mkdirSync(RENAMED, { recursive: true })
  await openGallery(page)
  const row = await folderRow(page, 'folder-actions-a')
  await row.click({ button: 'right' })
  await page.locator('.folder-row-menu .context-menu-item').first().click()
  await answerInput(page, 'folder-actions-b')

  await expect(page.locator('.toast').filter({ hasText: 'The folder was not renamed: a folder or file with that name is already there.' })).toBeVisible()
  expect(fs.existsSync(path.join(HOME, FILES[0]))).toBe(true)
  fs.rmSync(RENAMED, { recursive: true, force: true })
})

test('the selection moves into a new folder made inside the row', async ({ page }) => {
  await openGallery(page)
  const id = await page.evaluate(async (name) => {
    const found = await (window as any).App.API.getImages({ search: name, limit: 5 })
    return Number(found.images.find((image: { filename: string }) => image.filename === name).id)
  }, FILES[1])
  await page.evaluate((imageId) => (window as any).Gallery._setContextImageSelection(imageId, true), id)

  const row = await folderRow(page, 'folder-actions-a')
  await row.hover()
  await row.locator('.folder-row-more').click()
  // Esc closes the menu and nothing else.
  await page.keyboard.press('Escape')
  await expect(page.locator('.folder-row-menu')).toHaveCount(0)
  await row.locator('.folder-row-more').click()
  await page.locator('.folder-row-menu .context-menu-item').nth(1).click()
  await answerInput(page, 'inner-new')

  const confirm = page.locator('#confirm-modal.visible')
  await expect(confirm.locator('#confirm-message')).toContainText('inner-new')
  await confirm.locator('#btn-confirm-ok').click()
  await expect(page.locator('.toast').filter({ hasText: 'Move completed for 1 image.' })).toBeVisible({ timeout: 30_000 })
  expect(fs.existsSync(path.join(INNER, FILES[1]))).toBe(true)
  expect(fs.existsSync(path.join(HOME, FILES[1]))).toBe(false)
  await expect(page.locator('#folder-tree .folder-row[data-path$="/inner-new"]')).toHaveCount(1, { timeout: 15_000 })
})
