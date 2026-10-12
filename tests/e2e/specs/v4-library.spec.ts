import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, openLibrary as open, pageOverflow, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 library page (served by the same backend at /v4/, next to V3.5 at /).
 * Seeds its own images into the isolated test database, tagged with a search
 * token so other specs' rows never leak in, and removes them afterwards.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4e2etoken'
const COUNT = 24
const PREFIX = 'v4e2e-'
const DIR = 'v4-e2e'

const openLibrary = (page: Page, theme: 'dark' | 'light' = 'dark') => open(page, TOKEN, COUNT, theme)

async function ratingOf(page: Page, id: string): Promise<number> {
  return page.evaluate(async (x) => (await (await fetch(`/api/images/${x}`)).json()).image.user_rating, id)
}

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

for (const viewport of VIEWPORTS) {
  test(`layout fits at ${viewport.width}x${viewport.height} in both themes`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      await openLibrary(page, theme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await page.getByTestId('tile').first().click()
      await expect(page.getByTestId('generation-card')).toContainText('v4e2e-')
      for (const id of ['query-input', 'result-count', 'open-palette', 'theme-toggle']) {
        await expect(page.getByTestId(id)).toBeInViewport()
      }
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    }
  })
}

test('keys: arrows move, number keys rate, space picks', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  await page.getByTestId('tile').first().click()
  const inspected = page.locator('[data-testid="tile"][data-inspected]')
  const first = await inspected.getAttribute('data-id')
  await page.keyboard.press('ArrowRight')
  const second = await inspected.getAttribute('data-id')
  expect(second).not.toBe(first)

  await page.keyboard.press('4')
  await expect.poll(() => ratingOf(page, second!)).toBe(4)
  await page.keyboard.press('0')
  await expect.poll(() => ratingOf(page, second!)).toBe(0)

  await page.keyboard.press('Space')
  await expect(page.getByTestId('selection-bar')).toBeInViewport()
  await expect(page.getByTestId('selection-bar')).toContainText('1 picked')
})

test('Esc closes only the topmost layer', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page)
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await tiles.nth(1).click({ modifiers: ['Control'] })
  await expect(page.getByTestId('selection-bar')).toContainText('2 picked')

  // lightbox, then the palette on top of it
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('palette')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('palette')).toHaveCount(0)
  await expect(page.getByTestId('lightbox')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
  await expect(page.getByTestId('selection-bar')).toContainText('2 picked')

  // a menu is a layer too: Esc closes it and leaves the picks alone
  await page.getByRole('button', { name: /^Sort\s*[:：]/ }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByTestId('selection-bar')).toContainText('2 picked')

  // nothing floating: Esc clears the picks
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)
})

test('lightbox shows tall images whole', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  // v4e2e-03 is 48x120, the tallest shape
  await page.locator('[data-testid="tile"]').filter({ has: page.locator('img') }).nth(3).dblclick()
  await expect(page.getByTestId('lightbox')).toBeVisible()
  const fits = await page.evaluate(() => {
    const stage = document.querySelector('[data-testid="lightbox"] [class*="stage"]')
    const wrap = stage?.querySelector('[class*="imgWrap"]')
    if (!stage || !wrap) return false
    const s = stage.getBoundingClientRect()
    const w = wrap.getBoundingClientRect()
    return w.top >= s.top - 1 && w.bottom <= s.bottom + 1 && w.left >= s.left - 1 && w.right <= s.right + 1
  })
  expect(fits).toBe(true)
})

test('theme toggle cycles and survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, 'dark')
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('search: suggestions, chips and warnings', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  const input = page.getByTestId('query-input')

  // library values: prompt tokens come with counts; Esc closes only the list
  await input.fill(`${TOKEN} prompt:silv`)
  const suggest = page.getByTestId('query-suggest')
  await expect(suggest).toContainText('silver hair')
  await page.keyboard.press('Escape')
  await expect(suggest).toHaveCount(0)
  await expect(input).toHaveValue(`${TOKEN} prompt:silv`)

  // typing again reopens it; Enter takes the highlighted value (quoted, it has a space)
  await input.press('End')
  await input.pressSequentially('e')
  await expect(suggest).toContainText('silver hair')
  await input.press('Enter')
  await expect(input).toHaveValue(`${TOKEN} prompt:"silver hair" `)
  await expect(page.getByTestId('result-count')).toHaveText('24 images')

  // enum keys suggest their fixed values
  await input.fill(`${TOKEN} gen:n`)
  await expect(suggest).toContainText('nai')
  await input.press('Enter')
  await expect(input).toHaveValue(`${TOKEN} gen:nai `)

  // a chip removes its own condition
  const chips = page.getByTestId('query-chips')
  await chips.getByRole('button', { name: /Source/ }).click()
  await expect(input).toHaveValue(TOKEN)

  // a value the language doesn't know becomes a warning, not a silent filter
  await input.fill(`${TOKEN} rating:blue`)
  await expect(chips).toContainText('unknown rating')
  await expect(page.getByTestId('result-count')).toHaveText('24 images')

  // the ? panel lists the syntax and an example adds itself
  await page.getByTestId('query-help').click()
  await page.getByRole('button', { name: 'score>=7' }).click()
  await expect(input).toHaveValue(/score>=7$/)
})

test('filter panel, smart filters and reverse sort', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page)
  const input = page.getByTestId('query-input')
  const count = page.getByTestId('result-count')

  // the panel writes into the query line and the filter really applies
  await page.getByTestId('filter-button').click()
  const panel = page.getByTestId('filter-panel')
  await expect(panel).toBeInViewport()
  await panel.getByRole('button', { name: 'General' }).click()
  await expect(input).toHaveValue(`${TOKEN} rating:general`)
  await panel.getByRole('button', { name: 'General' }).click()
  await expect(input).toHaveValue(TOKEN)
  await panel.getByRole('button', { name: 'Portrait' }).click()
  await expect(input).toHaveValue(`${TOKEN} aspect:portrait`)
  await expect(count).toHaveText('12 images')

  // save it; the rail lists it with its own count
  await page.getByTestId('filter-save-name').fill('tall ones')
  await panel.getByRole('button', { name: 'Save as smart filter' }).click()
  const smart = page.getByTestId('smart-filters')
  await expect(smart).toContainText('tall ones')
  await expect(smart).toContainText('12')

  // clear, then the smart filter brings the query back
  await panel.getByRole('button', { name: 'Clear all' }).click()
  await expect(input).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await smart.getByRole('button', { name: /^tall ones/ }).click()
  await expect(input).toHaveValue(`${TOKEN} aspect:portrait`)
  await expect(count).toHaveText('12 images')

  // delete with undo
  await smart.getByRole('button', { name: /^tall ones/ }).hover()
  await smart.getByRole('button', { name: 'Delete "tall ones"' }).click()
  await expect(page.getByTestId('smart-filters')).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByTestId('smart-filters')).toContainText('tall ones')

  // reverse sort puts the oldest first
  await input.fill(TOKEN)
  await input.press('Enter')
  await expect(count).toHaveText('24 images')
  await expect(page.getByTestId('tile').first()).toHaveAttribute('title', 'v4e2e-00.png')
  await page.getByRole('button', { name: /^Sort\s*[:：]/ }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Reverse order' }).click()
  await expect(page.locator('[data-testid="gallery-scroller"]:not([aria-busy])')).toBeVisible()
  await expect(page.getByTestId('tile').first()).toHaveAttribute('title', 'v4e2e-23.png')
})
