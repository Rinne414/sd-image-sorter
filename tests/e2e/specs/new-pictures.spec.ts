import { expect, test, type Page } from '@playwright/test'

/**
 * Home > New Pictures: the Gallery opens on only the pictures made since the
 * last cull, with Keep / Reject or "Mark all as seen" one press away. The
 * marker moves when the set is dealt with, never by looking.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'
const MARKER_KEY = 'sd-new-pictures-marker-v1'
const NEWEST = '2026-11-10 21:15:42'

async function mockLibrary(page: Page, newIds: number[], options: { stored?: string } = {}) {
  const asked: string[] = []
  const pinned: number[][] = []
  const images = newIds.map((id) => ({ id, filename: `new-${id}.png`, path: `/mock/new-${id}.png`, prompt: '1girl', generator: 'nai' }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
  await page.route('**/api/images?**', async (route) => {
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } })
  })
  // The program keeps the marker (one per library); this stands in for it.
  let stored: string | null = options.stored ?? null
  await page.route('**/api/new-pictures/marker', async (route) => {
    const previous = stored
    stored = (route.request().postDataJSON().marker as string | null) || null
    await route.fulfill({ json: { marker: stored, previous } })
  })
  await page.route('**/api/new-pictures?**', async (route) => {
    asked.push(new URL(route.request().url()).search)
    // Once the marker is the newest picture's own time, nothing is new any more.
    const ids = stored === NEWEST ? [] : newIds
    await route.fulfill({ json: { after: stored || '2026-11-04 08:00:00', ids, count: ids.length, newest_time: NEWEST, remembered: Boolean(stored) } })
  })
  await page.route('**/api/collections/pinned', async (route) => {
    const ids = route.request().postDataJSON().image_ids as number[]
    pinned.push(ids)
    await route.fulfill({ json: { collection_id: 9300, count: ids.length } })
  })
  await page.route('**/api/collections/pinned/9300', async (route) => {
    await route.fulfill({ json: { exists: true, count: newIds.length } })
  })
  return { asked: () => [...asked], pinned: () => [...pinned], stored: () => stored }
}

async function openHome(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    if (sessionStorage.getItem('new-pictures-booted')) return
    sessionStorage.setItem('new-pictures-booted', '1')
    localStorage.removeItem('aurora-entry-skip')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#entry-page')).toBeVisible()
}


test('the tile counts what is waiting, opens exactly those pictures, and "Mark all as seen" moves the marker (with Undo)', async ({ page }) => {
  const library = await mockLibrary(page, [41, 42, 43])
  await openHome(page)

  // First time: no marker, so the last 7 days count; the tile says how many and from when.
  const tile = page.locator('#entry-mission-new')
  await expect(tile.locator('#entry-mission-new-count')).toHaveText('3 to go through, from the last week')
  // No marker is sent: the program uses its own, or the last week when it has none.
  expect(library.asked()[0]).toBe('?default_days=7')

  await tile.click()
  await expect(page.locator('#entry-page')).toBeHidden()
  await expect(page.locator('#view-gallery.active')).toBeVisible()
  await expect(page.locator('#gallery-pin-banner-title')).toHaveText('3 new pictures')
  expect(library.pinned()).toEqual([[41, 42, 43]])
  const next = page.locator('#pipeline-next-step')
  await expect(next.locator('.pns-title')).toHaveText('3 new pictures from the last week. What next?')
  await expect(next.locator('.pns-actions button')).toHaveText(['Keep / Reject them', 'Mark all as seen'])
  // Looking is not dealing with them: nothing is remembered yet.
  expect(library.stored()).toBeNull()

  await next.getByRole('button', { name: 'Mark all as seen' }).click()
  const toast = page.locator('.toast').filter({ hasText: 'Marked as seen' })
  await expect(toast).toContainText('made after 2026-11-10 21:15')
  await expect.poll(() => library.stored()).toBe(NEWEST)

  // Undo forgets the marker again.
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => library.stored()).toBeNull()
})

test('"Keep / Reject them" lands on Manual Sort in that mode, limited to the new pictures', async ({ page }) => {
  const library = await mockLibrary(page, [41, 42, 43])
  await openHome(page)
  await page.locator('#entry-mission-new').click()
  await page.locator('#pipeline-next-step').getByRole('button', { name: 'Keep / Reject them' }).click()

  await expect(page.locator('#view-sorting.active')).toBeVisible()
  expect(await page.evaluate(() => (window as any).getManualSortSelectedMode())).toBe('cull')
  // The scope says first that it is this set, not the whole library.
  const only = page.locator('#manual-sort-summary-set-row')
  await expect(only).toBeVisible()
  await expect(only).toContainText('Only')
  await expect(page.locator('#manual-sort-summary-set')).toHaveText('3 new pictures')
  expect(await page.evaluate(() => (window as any).getManualSortFilters().collectionId)).toBe(9300)

  // Finishing the cull is what moves the marker.
  await page.evaluate(() => (window as any).NewPictures.noteCullFinished())
  await expect.poll(() => library.stored()).toBe(NEWEST)
  // Quietly: the cull's own finish line and toast already speak.
  await expect(page.locator('.toast').filter({ hasText: 'new pictures' })).toHaveCount(0)
})

test('with a marker only later pictures count, and "nothing new" says since when and stays on Home', async ({ page }) => {
  const library = await mockLibrary(page, [41, 42, 43])
  // A marker an earlier version kept in this browser: it is handed to the program once.
  await page.addInitScript(([key, time]) => {
    if (!sessionStorage.getItem('new-pictures-marker-set')) {
      sessionStorage.setItem('new-pictures-marker-set', '1')
      localStorage.setItem(key, JSON.stringify({ main: time }))
    }
  }, [MARKER_KEY, NEWEST])
  await openHome(page)

  await expect(page.locator('#entry-mission-new-count')).toHaveText('Nothing new since 2026-11-10 21:15')
  expect(library.stored()).toBe(NEWEST)
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), MARKER_KEY)).toEqual({})
  await page.locator('#entry-mission-new').click()
  await expect(page.locator('.toast').filter({ hasText: 'Nothing new since 2026-11-10 21:15.' })).toBeVisible()
  await expect(page.locator('#entry-page')).toBeVisible()
  expect(library.pinned()).toEqual([])

  // The same door is in the function catalog.
  await page.keyboard.press('Control+k')
  await expect(page.getByText('Go through new pictures', { exact: true })).toBeVisible()
})

test('the Home column still fits with the fourth mission at 1280x720 and 1366x768 (zh-CN too)', async ({ page }) => {
  await mockLibrary(page, [41, 42, 43])
  for (const [width, height, lang] of [[1280, 720, 'zh-CN'], [1366, 768, 'en']] as const) {
    await page.setViewportSize({ width, height })
    await page.addInitScript((language) => {
      localStorage.removeItem('aurora-entry-skip')
      localStorage.setItem('sd-image-sorter-lang', language)
    }, lang)
    await page.goto('/')
    await expect(page.locator('#entry-mission-new')).toBeVisible()
    await expect(page.locator('#entry-mission-new-count')).not.toHaveText('')
    const fit = await page.evaluate(() => {
      const tile = document.getElementById('entry-mission-new')!.getBoundingClientRect()
      const pixiv = document.getElementById('entry-mission-pixiv')!.getBoundingClientRect()
      const rows = Array.from(document.querySelectorAll('.entry-mosaic > *')).filter((node) => (node as HTMLElement).offsetParent)
      const bottom = Math.max(...rows.map((node) => node.getBoundingClientRect().bottom))
      const count = document.getElementById('entry-mission-new-count')!
      return {
        sameRow: Math.abs(tile.top - pixiv.top) < 1 && Math.abs(tile.height - pixiv.height) < 1,
        insideWindow: bottom <= window.innerHeight && tile.right <= window.innerWidth,
        lineFits: count.scrollWidth <= count.clientWidth + 1,
        sideways: document.documentElement.scrollWidth - window.innerWidth,
      }
    })
    expect(fit, `${width}x${height} ${lang}`).toEqual({ sameRow: true, insideWindow: true, lineFits: true, sideways: 0 })
  }
})
