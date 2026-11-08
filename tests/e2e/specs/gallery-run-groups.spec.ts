import { expect, test } from '@playwright/test'

/**
 * Pictures from one generation run (same prompt, negative prompt, checkpoint
 * and size, each within 10 minutes of the previous) show as one stack in the
 * classic gallery when "Group runs" is on. The flat list stays as it is.
 */

test.use({ viewport: { width: 1920, height: 1080 } })

const picture = (id: number, runKey: string | null, minute: number) => ({
  id,
  run_key: runKey,
  created_at: `2026-11-08T10:${String(minute).padStart(2, '0')}:00`,
})

test('runs are next to each other, share a key and stay within ten minutes', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).GalleryRunGroups)).toBe('object')
  const result = await page.evaluate((images) => {
    const { groupRuns } = (window as any).GalleryRunGroups
    const closed = groupRuns(images)
    const firstKey = closed.find((item: any) => item._stack)._stack.key
    const opened = groupRuns(images, { openKeys: new Set([firstKey]) })
    const shape = (items: any[]) => items.map((item) => (item._stack
      ? `stack ${item.id} x${item._stack.size} [${item._stack.ids.join(',')}]`
      : item._runMember ? `member ${item.id} ${item._runMember.position + 1}/${item._runMember.size}` : `single ${item.id}`)
      + ` @${item._flatIndex}`)
    return { closed: shape(closed), opened: shape(opened) }
  }, [
    picture(1, 'a', 50), picture(2, 'a', 49), picture(3, 'a', 47), // one run
    picture(4, 'b', 46), // another prompt
    picture(5, 'a', 45), // the first prompt again, but not next to its run
    picture(6, 'c', 40), picture(7, 'c', 20), // same key, 20 minutes apart
    picture(8, null, 19), picture(9, null, 18), // no key: never grouped
  ])
  expect(result.closed).toEqual([
    'stack 1 x3 [1,2,3] @0',
    'single 4 @3',
    'single 5 @4',
    'single 6 @5',
    'single 7 @6',
    'single 8 @7',
    'single 9 @8',
  ])
  expect(result.opened.slice(0, 3)).toEqual(['member 1 1/3 @0', 'member 2 2/3 @1', 'member 3 3/3 @2'])

  // The grid's items read the pictures themselves: a rating set later shows through.
  const ratingShows = await page.evaluate(() => {
    const images: Array<Record<string, unknown>> = [{ id: 1, run_key: 'a', created_at: '2026-11-08T10:00:00' }, { id: 2, run_key: 'a', created_at: '2026-11-08T10:01:00' }]
    const [stack] = (window as any).GalleryRunGroups.groupRuns(images)
    images[0].user_rating = 5
    return stack.user_rating
  })
  expect(ratingShows).toBe(5)
})

// 300 pictures in runs of four: same key, a minute apart; a new key every four.
async function mockRuns(page: import('@playwright/test').Page) {
  const base = Date.parse('2026-11-08T12:00:00Z')
  const images = Array.from({ length: 300 }, (_, index) => ({
    id: 90001 + index,
    filename: `run-${Math.floor(index / 4)}-${index % 4}.png`,
    path: `/mock/run-${index}.png`,
    generator: 'comfyui',
    width: 512,
    height: 512,
    run_key: `k${Math.floor(index / 4)}`,
    created_at: new Date(base - index * 60_000).toISOString(),
    library_order_time: new Date(base - index * 60_000).toISOString(),
  }))
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#579"/></svg>'
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }))
  await page.route('**/api/images**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/images') return route.fallback()
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } })
  })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('aurora-entry-skip', '1')
  })
}

const stacks = (page: import('@playwright/test').Page) => page.locator('#gallery-grid .gallery-item.gallery-stack')
const groupButton = (page: import('@playwright/test').Page) => page.locator('#btn-group-runs')

test('Group runs is off by default, turns runs into stacks, and is remembered', async ({ page }) => {
  await mockRuns(page)
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item[data-id]').first()).toBeVisible()
  await expect(groupButton(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(stacks(page)).toHaveCount(0)

  await groupButton(page).click()
  await expect(groupButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(stacks(page).first()).toBeVisible()
  await expect(stacks(page).first().locator('.gallery-stack-open')).toHaveText('×4')
  await expect(stacks(page).first()).toHaveAttribute('data-run-ids', '90001,90002,90003,90004')

  await page.reload()
  await expect(stacks(page).first()).toBeVisible()
  await expect(groupButton(page)).toHaveAttribute('aria-pressed', 'true')

  // Changing the size keeps the switch on (the size buttons share its row).
  await page.locator('.view-btn[data-size="large"]').click()
  await expect(page.locator('.view-btn[data-size="large"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(groupButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(stacks(page).first()).toBeVisible()
})

test('a stack opens in place and folds back', async ({ page }) => {
  await mockRuns(page)
  await page.addInitScript(() => localStorage.setItem('sd-sorter:group-runs', '1'))
  await page.goto('/')
  const first = stacks(page).first()
  await expect(first).toBeVisible()
  await first.locator('.gallery-stack-open').click()
  const members = page.locator('#gallery-grid .gallery-item.gallery-run-member')
  await expect(members).toHaveCount(4)
  await expect(members.first()).toHaveAttribute('data-id', '90001')
  await members.first().locator('.gallery-stack-close').click()
  await expect(members).toHaveCount(0)
  await expect(stacks(page).first()).toHaveAttribute('data-id', '90001')
})

test('selecting a stack selects its whole run, and preview walks every picture', async ({ page }) => {
  await mockRuns(page)
  await page.addInitScript(() => localStorage.setItem('sd-sorter:group-runs', '1'))
  await page.goto('/')
  await expect(stacks(page).first()).toBeVisible()

  await page.evaluate(() => (window as any).App.setSelectionMode(true))
  await stacks(page).first().click({ position: { x: 40, y: 40 } })
  await expect.poll(() => page.evaluate(() => [...(window as any).App.AppState.selectedIds].sort())).toEqual([90001, 90002, 90003, 90004])
  await expect(stacks(page).first()).toHaveClass(/selected/)
  // The pick-order chip names every picture in the stack, not just the first.
  await expect(stacks(page).first()).toHaveAttribute('data-sel-order', '1–4')
  await stacks(page).first().click({ position: { x: 40, y: 40 } })
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.selectedIds.size)).toBe(0)

  // Shift on a later stack takes the range from the last pick through that whole run.
  await stacks(page).first().click({ position: { x: 40, y: 40 } })
  await stacks(page).nth(2).click({ position: { x: 40, y: 40 }, modifiers: ['Shift'] })
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.selectedIds.size)).toBe(12)
  await expect(stacks(page).nth(1)).toHaveClass(/selected/)
  await expect(stacks(page).nth(2)).toHaveClass(/selected/)
  await page.evaluate(() => (window as any).Gallery.clearSelection())
  await page.evaluate(() => (window as any).App.setSelectionMode(false))

  await stacks(page).first().click({ position: { x: 40, y: 40 } })
  await expect(page.locator('#modal-image')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).Gallery.currentPreviewIndex)).toBe(0)
  await page.keyboard.press('ArrowRight')
  // The next picture is the second one of the run, inside the closed stack.
  await expect.poll(() => page.evaluate(() => (window as any).Gallery.images[(window as any).Gallery.currentPreviewIndex].id)).toBe(90002)
})

test('a stack stays whole in selection: ranges either way, and one picture of it is not the stack', async ({ page }) => {
  await mockRuns(page)
  await page.addInitScript(() => localStorage.setItem('sd-sorter:group-runs', '1'))
  await page.goto('/')
  await expect(stacks(page).first()).toBeVisible()
  await page.evaluate(() => (window as any).App.setSelectionMode(true))
  const selected = () => page.evaluate(() => [...(window as any).App.AppState.selectedIds].map(Number).sort((a, b) => a - b))
  const count = () => page.evaluate(() => (window as any).App.AppState.selectedIds.size)

  // Backwards from a stack: the anchor's whole run stays in the range.
  await stacks(page).nth(2).click({ position: { x: 40, y: 40 } })
  await stacks(page).first().click({ position: { x: 40, y: 40 }, modifiers: ['Shift'] })
  await expect.poll(count).toBe(12)
  await page.evaluate(() => (window as any).Gallery.clearSelection())

  // Shift on the anchor stack itself selects that run, not just its first picture.
  await stacks(page).first().click({ position: { x: 40, y: 40 } })
  await stacks(page).first().click({ position: { x: 40, y: 40 }, modifiers: ['Shift'] })
  await expect.poll(selected).toEqual([90001, 90002, 90003, 90004])
  await page.evaluate(() => (window as any).Gallery.clearSelection())

  // One picture inside a closed stack (the context menu can pick it) is not the stack,
  // also after the tile is drawn again.
  await page.evaluate(() => (window as any).Gallery.toggleSelection(90001))
  await expect.poll(count).toBe(1)
  await expect(stacks(page).first()).not.toHaveClass(/selected/)
  // Redraw the tiles the way scrolling away and back does (no selection sync afterwards).
  await page.evaluate(() => (window as any).Gallery.virtualList.setItems((window as any).Gallery._displayItems()))
  await expect(stacks(page).first()).not.toHaveClass(/selected/)
  await expect(stacks(page).first()).not.toHaveAttribute('data-sel-order', /./)
})

test('runs are grouped only when sorted by date', async ({ page }) => {
  await mockRuns(page)
  await page.addInitScript(() => localStorage.setItem('sd-sorter:group-runs', '1'))
  await page.goto('/')
  await expect(stacks(page).first()).toBeVisible()
  await page.evaluate(() => {
    const app = (window as any).App
    app.AppState.filters.sortBy = 'name_asc'
    ;(window as any).Gallery.setImages((window as any).Gallery.images)
  })
  await expect(stacks(page)).toHaveCount(0)
  await expect(groupButton(page)).toHaveAttribute('title', 'Runs are grouped only when sorted by date')
})
