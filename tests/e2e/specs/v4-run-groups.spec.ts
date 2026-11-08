import { expect, test, type Page } from '@playwright/test'

/**
 * Group runs in V Opus: pictures from one generation run (same prompt,
 * negative prompt, checkpoint and size, each within 10 minutes of the
 * previous) show as one stack when the View menu's "Group runs" is on.
 * The flat list stays the pictures: the lightbox walks every one.
 *
 * Needs the V Opus build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.use({ viewport: { width: 1920, height: 1080 } })

// 300 pictures in runs of four: same key, a minute apart; a new key every four.
async function mockRuns(page: Page) {
  const base = Date.parse('2026-11-08T12:00:00Z')
  const images = Array.from({ length: 300 }, (_, index) => {
    // Unix seconds, as the real listing sends them (an ISO string crashed nothing; a number did).
    const time = Math.floor((base - index * 60_000) / 1000)
    return {
      id: 90001 + index,
      filename: `run-${Math.floor(index / 4)}-${index % 4}.png`,
      path: `/mock/run-${index}.png`,
      generator: 'comfyui',
      width: 512,
      height: 512,
      file_size: 1000,
      checkpoint: null,
      checkpoint_normalized: null,
      loras: null,
      user_rating: null,
      aesthetic_score: null,
      is_readable: 1,
      metadata_status: 'complete',
      created_at: time,
      library_order_time: time,
      run_key: `k${Math.floor(index / 4)}`,
    }
  })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#579"/></svg>'
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }))
  await page.route('**/api/images**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/images') return route.fallback()
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } })
  })
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
}

async function withGroupRuns(page: Page) {
  await page.addInitScript(() => {
    const prefs = JSON.parse(localStorage.getItem('sd-v4-prefs') || '{}')
    localStorage.setItem('sd-v4-prefs', JSON.stringify({ ...prefs, groupRuns: true }))
  })
}

const tiles = (page: Page) => page.getByTestId('tile')
const stacks = (page: Page) => page.locator('[data-testid="tile"][data-stack]')
const viewMenu = (page: Page) => page.locator('[data-testid="query-bar"] > div:nth-last-child(2) > button')

async function openLibrary(page: Page) {
  await page.goto('/vopus/#/library')
  await expect(tiles(page).first()).toBeVisible()
}

test('Group runs is off by default, turns runs into stacks from the View menu, and is remembered', async ({ page }) => {
  await mockRuns(page)
  await openLibrary(page)
  await expect(stacks(page)).toHaveCount(0)

  await viewMenu(page).click()
  const item = page.locator('[data-item="group-runs"]')
  await expect(item).toHaveAttribute('aria-checked', 'false')
  await item.click()
  await expect(stacks(page).first()).toBeVisible()
  await expect(stacks(page).first().getByTestId('run-open')).toHaveText('×4')
  await expect(stacks(page).first()).toHaveAttribute('data-run-ids', '90001,90002,90003,90004')

  await page.reload()
  await expect(stacks(page).first()).toBeVisible()
  await viewMenu(page).click()
  await expect(page.locator('[data-item="group-runs"]')).toHaveAttribute('aria-checked', 'true')

  // Another layout keeps it on.
  await page.locator('[data-item="grid"]').click()
  await expect(stacks(page).first()).toBeVisible()
})

test('a stack opens in place and folds back', async ({ page }) => {
  await mockRuns(page)
  await withGroupRuns(page)
  await openLibrary(page)
  await stacks(page).first().getByTestId('run-open').click()
  const members = page.locator('[data-testid="tile"][data-run-member]')
  await expect(members).toHaveCount(4)
  await expect(members.first()).toHaveAttribute('data-id', '90001')
  await members.first().getByTestId('run-fold').click()
  await expect(members).toHaveCount(0)
  await expect(stacks(page).first()).toHaveAttribute('data-id', '90001')
})

test('picking a stack picks its whole run: Ctrl, Shift either way and Space', async ({ page }) => {
  await mockRuns(page)
  await withGroupRuns(page)
  await openLibrary(page)
  const bar = page.getByTestId('selection-bar')

  await stacks(page).first().click({ modifiers: ['Control'] })
  await expect(bar).toHaveAttribute('aria-label', '4 picked')
  await expect(stacks(page).first()).toHaveAttribute('data-picked', 'true')
  await expect(stacks(page).first()).toContainText('1–4')
  await stacks(page).first().click({ modifiers: ['Control'] })
  await expect(bar).toHaveCount(0)

  // Shift onto a later stack takes that whole run, not just its first picture.
  await stacks(page).first().click({ modifiers: ['Control'] })
  await stacks(page).nth(2).click({ modifiers: ['Shift'] })
  await expect(bar).toHaveAttribute('aria-label', '12 picked')
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)

  // And backwards from a stack.
  await stacks(page).nth(2).click({ modifiers: ['Control'] })
  await stacks(page).first().click({ modifiers: ['Shift'] })
  await expect(bar).toHaveAttribute('aria-label', '12 picked')
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)

  // Space on the inspected stack picks all of it.
  await stacks(page).nth(1).click()
  await page.keyboard.press('Space')
  await expect(bar).toHaveAttribute('aria-label', '4 picked')
  await expect(stacks(page).nth(1)).toHaveAttribute('data-picked', 'true')
  await page.keyboard.press('Escape')

  // One picture of a run picked is not the stack: open it, pick its first, fold it.
  await stacks(page).first().getByTestId('run-open').click()
  await page.locator('[data-testid="tile"][data-run-member]').first().click({ modifiers: ['Control'] })
  await expect(bar).toHaveAttribute('aria-label', '1 picked')
  await page.locator('[data-testid="tile"][data-run-member]').first().getByTestId('run-fold').click()
  await expect(stacks(page).first()).not.toHaveAttribute('data-picked', 'true')
  await page.keyboard.press('Escape')

  // The lightbox opens on the stack's first picture and walks into the closed run.
  await stacks(page).first().dblclick()
  const lightbox = page.getByTestId('lightbox')
  await expect(lightbox).toBeVisible()
  await expect(lightbox.getByTestId('lightbox-image').locator('img').first()).toHaveAttribute('src', /\/90001\b/)
  await page.keyboard.press('ArrowRight')
  await expect(lightbox.getByTestId('lightbox-image').locator('img').first()).toHaveAttribute('src', /\/90002\b/)
})

test("right-click on a stack acts on the whole run, and its Pick picks every picture", async ({ page }) => {
  await mockRuns(page)
  await withGroupRuns(page)
  await openLibrary(page)
  await stacks(page).first().click({ button: 'right' })
  const menu = page.getByTestId('card-menu')
  await expect(menu).toContainText('Acts on the 4 pictures of this run')
  await menu.getByRole('menuitem', { name: /Pick the 4 pictures of this run/ }).click()
  await expect(page.getByTestId('selection-bar')).toHaveAttribute('aria-label', '4 picked')
  await expect(stacks(page).first()).toHaveAttribute('data-picked', 'true')

  // Picked now, it is one of the picks: the menu acts on the picks, as on any picked card.
  await stacks(page).first().click({ button: 'right' })
  await expect(menu).toContainText('Acts on the 4 picked images')
  await page.keyboard.press('Escape')
})

test('a stack that looks unpicked gets the run menu, and the menu key finds a picture inside a stack', async ({ page }) => {
  await mockRuns(page)
  await withGroupRuns(page)
  await openLibrary(page)
  const menu = page.getByTestId('card-menu')

  // Only the first stack's cover picked, next to the second stack: the first looks unpicked.
  await stacks(page).first().getByTestId('run-open').click()
  await page.locator('[data-testid="tile"][data-run-member]').first().click({ modifiers: ['Control'] })
  await page.locator('[data-testid="tile"][data-run-member]').first().getByTestId('run-fold').click()
  await stacks(page).nth(1).click({ modifiers: ['Control'] })
  await expect(page.getByTestId('selection-bar')).toHaveAttribute('aria-label', '5 picked')
  await stacks(page).first().click({ button: 'right' })
  await expect(menu).toContainText('Acts on the 4 pictures of this run')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  // The big image walked into a closed stack, then closed: the menu key opens the run's menu.
  await stacks(page).first().dblclick()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('lightbox').getByTestId('lightbox-image').locator('img').first()).toHaveAttribute('src', /\/90002\b/)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
  await page.keyboard.press('Shift+F10')
  await expect(menu).toContainText('Acts on the 4 pictures of this run')
})

test('a place remembered on a picture inside a stack comes back at that stack', async ({ page }) => {
  await mockRuns(page)
  await openLibrary(page)
  // Scroll the flat grid so the app saves its place for this search.
  await page.getByTestId('gallery-scroller').evaluate((el) => el.scrollTo({ top: 9000 }))
  await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem('sd-v4-scroll')))).toBe(true)
  // Point the saved place at the second picture of run 40 (place 161 of 300): with
  // Group runs on it is inside a closed stack, and the grid shows only 75 stacks.
  const hidden = 90001 + 4 * 40 + 1
  await page.evaluate((id) => {
    const store = JSON.parse(localStorage.getItem('sd-v4-scroll')!)
    for (const library of Object.keys(store)) store[library] = { ...store[library], id, index: 4 * 40 + 1, at: Date.now() }
    localStorage.setItem('sd-v4-scroll', JSON.stringify(store))
    const prefs = JSON.parse(localStorage.getItem('sd-v4-prefs') || '{}')
    localStorage.setItem('sd-v4-prefs', JSON.stringify({ ...prefs, groupRuns: true }))
  }, hidden)
  await page.reload()
  await expect(stacks(page).first()).toBeVisible()
  // The grid comes back at that run's stack, not at the end.
  await expect.poll(() => page.evaluate((id) => {
    const box = document.querySelector('[data-testid="gallery-scroller"]')!.getBoundingClientRect()
    const tile = [...document.querySelectorAll<HTMLElement>('[data-testid="tile"][data-run-ids]')]
      .find((el) => el.dataset.runIds!.split(',').includes(String(id)))
    if (!tile) return 'not drawn'
    const r = tile.getBoundingClientRect()
    return r.bottom > box.top && r.top < box.bottom ? 'on screen' : 'off screen'
  }, hidden)).toBe('on screen')
})

test('runs are grouped only when sorted by date, and the switch says so', async ({ page }) => {
  await mockRuns(page)
  await withGroupRuns(page)
  await openLibrary(page)
  await expect(stacks(page).first()).toBeVisible()
  await page.locator('[data-testid="query-bar"] > div:nth-last-child(3) > button').click()
  await page.locator('[data-item="name"]').click()
  await expect(stacks(page)).toHaveCount(0)
  await viewMenu(page).click()
  await expect(page.locator('[data-item="group-runs"]')).toContainText('Group runs (when sorted by date)')
})
