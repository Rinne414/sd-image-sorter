import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'
import { createTestImage } from '../fixtures/test-helpers'

/**
 * Import dialog > "From an Eagle library…": look at what a library holds,
 * then bring it in. The first test stands in for the server to pin the
 * dialog's states; the second runs for real on a library built to the public
 * layout (two items, a thumbnail, a bookmark), in place.
 */

const FOUND = {
  library: 'D:/Eagle/Art.library', name: 'Art.library', items: 12, with_tags: 9, with_stars: 4, with_notes: 2,
  in_folders: 7, with_source: 3, distinct_tags: 21, folders: 5, skipped_deleted: 1, skipped_no_file: 2,
  skipped_unreadable: 0, unreadable_examples: [],
}
const RESULT = {
  indexed: 12, not_indexed: 0, stars_set: 4, notes_set: 2, tags_added: 30, sources_set: 3,
  collections_created: 5, collection_memberships: 7, found: FOUND,
}

async function openDialog(page: Page, lang = 'en') {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript((language) => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', language)
  }, lang)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.appReady)).toBe('1')
  await page.locator('#btn-scan').click()
  await expect(page.locator('#scan-modal')).toHaveClass(/visible/)
  await page.locator('#btn-scan-from-eagle').click()
  await expect(page.locator('#eagle-import-modal')).toHaveClass(/visible/)
  await expect(page.locator('#scan-modal')).not.toHaveClass(/visible/)
}

test('look first, then bring it in: counts, progress and the result are all said', async ({ page }) => {
  const calls: string[] = []
  let polls = 0
  await page.route('**/api/eagle/preview', async (route) => {
    const asked = route.request().postDataJSON().path as string
    calls.push(`preview ${asked}`)
    if (asked.includes('nowhere')) {
      await route.fulfill({ status: 400, json: { error: "This folder does not look like an Eagle library: it has no 'images' folder." } })
    } else {
      await route.fulfill({ json: FOUND })
    }
  })
  await page.route('**/api/eagle/import', async (route) => {
    if (route.request().method() === 'POST') {
      calls.push(`import ${route.request().postDataJSON().path}`)
      polls = 1
      await route.fulfill({ json: { status: 'running', step: 'index', current: 0, total: 12 } })
      return
    }
    if (polls === 0) await route.fulfill({ json: { status: 'idle' } })
    else if (polls++ < 3) await route.fulfill({ json: { status: 'running', step: 'details', current: 6, total: 12 } })
    else await route.fulfill({ json: { status: 'done', result: RESULT } })
  })
  await openDialog(page)

  const status = page.locator('#eagle-import-status')
  const run = page.locator('#btn-eagle-run')
  await expect(run).toBeDisabled()

  // No folder, then a folder that is not a library: said in place, nothing to bring in.
  await page.locator('#btn-eagle-preview').click()
  await expect(status).toContainText('Choose the Eagle library folder first')
  await page.locator('#eagle-import-path').fill('D:/nowhere')
  await page.locator('#btn-eagle-preview').click()
  await expect(status).toContainText('does not look like an Eagle library')
  await expect(run).toBeDisabled()

  await page.locator('#eagle-import-path').fill('D:/Eagle/Art.library')
  await page.locator('#eagle-import-path').press('Enter')
  const summary = page.locator('#eagle-import-summary')
  await expect(summary).toContainText('Pictures and videos')
  await expect(summary.locator('dd').first()).toHaveText('12')
  await expect(summary).toContainText('9 (21 tags in all)')
  await expect(summary).toContainText('7 (5 folders)')
  await expect(summary).toContainText('Passed over: bookmarks and items without a file')
  // A count of zero is not listed as something passed over.
  await expect(summary).not.toContainText('cannot be read')
  await expect(status).toContainText('Nothing is copied')
  await expect(run).toBeEnabled()

  // Another folder typed in: what was looked at no longer stands.
  await page.locator('#eagle-import-path').fill('D:/Eagle/Other.library')
  await expect(run).toBeDisabled()
  await page.locator('#eagle-import-path').fill('D:/Eagle/Art.library')
  await page.locator('#btn-eagle-preview').click()
  await expect(run).toBeEnabled()

  await run.click()
  await expect(status).toContainText('Bringing stars, notes, tags and folders over: 6 of 12')
  const result = page.locator('#eagle-import-result')
  await expect(result).toContainText('Now in the Gallery')
  await expect(result).toContainText('Collections made from folders')
  await expect(status).toHaveText('Done. The Eagle folder was not changed.')
  expect(calls.filter((call) => call.startsWith('import'))).toEqual(['import D:/Eagle/Art.library'])

  // The dialog fits the window with everything shown.
  const box = (await page.locator('.eagle-import-content').boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(768)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('a library built to the public layout comes in for real, in place', async ({ page, request }) => {
  const root = path.join(__dirname, '..', '..', '..', '.tmp', 'manual-test', 'eagle-real', 'Scratch.library')
  fs.rmSync(root, { recursive: true, force: true })
  const item = async (id: string, name: string, meta: Record<string, unknown>, withFile = true) => {
    const info = path.join(root, 'images', `${id}.info`)
    fs.mkdirSync(info, { recursive: true })
    fs.writeFileSync(path.join(info, 'metadata.json'), JSON.stringify({ id, name, ext: 'png', ...meta }))
    if (withFile) {
      await createTestImage(info, `${name}.png`, { generator: 'nai', prompt: `eagle ${name}` })
      fs.copyFileSync(path.join(info, `${name}.png`), path.join(info, `${name}_thumbnail.png`))
    }
  }
  fs.mkdirSync(path.join(root, 'images'), { recursive: true })
  fs.writeFileSync(path.join(root, 'metadata.json'), JSON.stringify({
    folders: [{ id: 'F1', name: 'Eagle scratch', children: [{ id: 'F2', name: 'Keepers', children: [] }] }],
  }))
  const stamp = Date.now()
  await item('AAA', `eagle-one-${stamp}`, { tags: ['eagle scratch tag', 'night'], folders: ['F2'], star: 4, annotation: 'from eagle', url: 'https://example.test/one' })
  await item('BBB', `eagle-two-${stamp}`, {})
  await item('BOOK', 'a bookmark', { url: 'https://example.test/page' }, false)

  await openDialog(page)
  await page.locator('#eagle-import-path').fill(root)
  await page.locator('#btn-eagle-preview').click()
  await expect(page.locator('#eagle-import-summary dd').first()).toHaveText('2')
  await page.locator('#btn-eagle-run').click()
  await expect(page.locator('#eagle-import-status')).toHaveText('Done. The Eagle folder was not changed.', { timeout: 60_000 })
  await expect(page.locator('#eagle-import-result dd').first()).toHaveText('2')

  // In the library: the picture where Eagle keeps it, with its stars and note; no thumbnail, no copy.
  const found = await (await request.get('/api/images', { params: { search: `eagle-one-${stamp}`, limit: 10 } })).json()
  expect(found.images.map((image: { filename: string }) => image.filename)).toEqual([`eagle-one-${stamp}.png`])
  const one = found.images[0]
  expect(one.path.replace(/\\/g, '/')).toContain('/Scratch.library/images/AAA.info/')
  const detail = await (await request.get(`/api/images/${one.id}`)).json()
  expect(detail.image.user_rating).toBe(4)
  expect(detail.image.note).toBe('from eagle')
  expect(detail.tags.map((tag: { tag: string }) => tag.tag).sort()).toEqual(['eagle scratch tag', 'night'])
  // The sidebar shows the library's pictures as ONE folder, not one row per Eagle item.
  await page.locator('#eagle-import-close').click()
  await page.evaluate(() => (window as any).FolderTreeUI.refresh())
  await expect.poll(() => page.evaluate(() => (window as any).FolderTreeUI._folders.filter((folder: string) => /Scratch\.library/.test(folder)))).toHaveLength(1)
  const shown = await page.evaluate(() => (window as any).FolderTreeUI._folders.filter((folder: string) => /Scratch\.library/.test(folder)))
  expect(shown[0].split(path.win32.sep).join('/')).toMatch(/Scratch\.library\/images$/)
  // Nor is Eagle's own folder offered as a place to move pictures to.
  expect(await page.evaluate(() => (window as any).FolderTreeUI.libraryFolders().some((entry: { path: string }) => /\.library/.test(entry.path)))).toBe(false)

  // Moving such a picture, or sending it to the bin, says what that does to Eagle first.
  await page.evaluate((name) => (window as any).GalleryToolbar.search(name), `eagle-one-${stamp}`)
  await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(1)
  await page.evaluate((id) => { void (window as any).App.moveOrCopyGalleryImages([id], 'move', { source: 'context', destination: 'D:/somewhere-else' }) }, one.id)
  const question = page.locator('#confirm-modal.visible')
  await expect(question.locator('#confirm-message')).toContainText('Inside an Eagle library: 1. Moving takes them out of Eagle; Copy keeps both.')
  await question.locator('#btn-confirm-cancel').click()
  await page.evaluate((id) => { void (window as any).App.deleteGalleryImagesByIds([id]) }, one.id)
  await expect(question.locator('#confirm-message')).toContainText('They will be gone from Eagle too')
  await question.locator('#btn-confirm-cancel').click()

  // The Eagle folder itself is as it was: same files, nothing added.
  expect(fs.readdirSync(path.join(root, 'images', 'AAA.info')).sort()).toEqual([`eagle-one-${stamp}.png`, `eagle-one-${stamp}_thumbnail.png`, 'metadata.json'].sort())
})
