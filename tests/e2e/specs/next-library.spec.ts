import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, pageOverflow, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * The new interface at /next/ (docs/DESIGN.md §redesign-2026-10, direction A
 * "Recipe"): the library page with its top edge, scope line, recipe column
 * (only while an image is inspected), action bar and footer line; browser
 * Back; the footer's Clear current library entrance; the classic interface's
 * page links it uses.
 *
 * Needs the frontend-v4 build (it holds next.html): `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'nexte2etoken'
const COUNT = 24
const PREFIX = 'nexte2e-'
const DIR = 'next-e2e'

const COUNT_TEXT: Record<'en' | 'zh-CN', string> = { en: `${COUNT} images`, 'zh-CN': `${COUNT} 张` }

async function openNext(page: Page, lang: 'en' | 'zh-CN' = 'en') {
  await page.addInitScript((language) => {
    const flag = 'nexte2e-init-' + language
    if (sessionStorage.getItem(flag)) return
    sessionStorage.setItem(flag, '1')
    localStorage.setItem('sd-image-sorter-lang', language)
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' }))
    // no update check half a minute after start: the test server would ask GitHub
    localStorage.setItem('sd-v4-update-autocheck', '0')
  }, lang)
  const res = await page.goto('/next/', { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'the new interface is not built: run npm run build in frontend-v4').toBe(200)
  const input = page.getByTestId('query-input')
  await input.fill(TOKEN)
  await input.press('Enter')
  await expect(page.getByTestId('result-count')).toHaveText(COUNT_TEXT[lang])
  await expect(page.locator('[data-testid="gallery-scroller"]:not([aria-busy])')).toBeVisible()
}

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

for (const viewport of VIEWPORTS) {
  test(`the library fits at ${viewport.width}x${viewport.height} in both languages`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const lang of ['en', 'zh-CN'] as const) {
      await openNext(page, lang)
      // every place is a labelled tab on the top edge, all on screen
      for (const id of ['library', 'batch', 'sort', 'reader', 'stylemap']) {
        await expect(page.getByTestId(`next-place-${id}`)).toBeInViewport({ ratio: 1 })
      }
      for (const id of ['next-censor', 'next-similar', 'next-more', 'open-palette', 'next-ai-tag', 'import-button', 'settings-button', 'query-input', 'result-count', 'next-clear-library']) {
        await expect(page.getByTestId(id)).toBeInViewport()
      }
      // no empty column: the recipe column opens with an image and closes with Esc
      await expect(page.getByTestId('generation-card')).toHaveCount(0)
      await page.getByTestId('tile').first().click()
      await expect(page.getByTestId('generation-card')).toContainText(PREFIX)
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('generation-card')).toHaveCount(0)
    }
  })
}

test('a double-click opens the picture it began on: the first click does not move the grid', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openNext(page)
  // not the first tile: the column narrowing the grid moved every later tile
  const tile = page.getByTestId('tile').nth(5)
  const name = await tile.getAttribute('title')
  const before = (await tile.boundingBox())!
  await tile.click()
  // where the second click of a double-click lands, the same tile is still there
  const atPointer = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="tile"]')?.getAttribute('title') ?? null, {
    x: before.x + before.width / 2,
    y: before.y + before.height / 2,
  })
  expect(atPointer).toBe(name)
  // the recipe column follows a moment later
  await expect(page.getByTestId('generation-card')).toContainText(PREFIX)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('generation-card')).toHaveCount(0)
  // a real double-click opens that picture big
  await page.getByTestId('tile').nth(5).dblclick()
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('picks get numbered badges and the action bar', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openNext(page)
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click()
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('pick-badge')).toHaveText(['1', '2'])
  await expect(page.locator('[data-testid="tile"][data-picked]')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('pick-badge')).toHaveCount(0)
})

test('a prompt word in the recipe column adds itself to the search', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openNext(page)
  await page.getByTestId('tile').first().click()
  await page.getByTestId('prompt-word').filter({ hasText: /^smile$/ }).click()
  await expect(page.getByTestId('query-input')).toHaveValue(`${TOKEN} prompt:smile`)
  await expect(page.getByTestId('result-count')).toHaveText(COUNT_TEXT.en)
  await expect(page.getByTestId('next-clear-conditions')).toHaveText('Clear 2 conditions')
  await page.getByTestId('next-clear-conditions').click()
  await expect(page.getByTestId('query-input')).toHaveValue('')
})

test('browser Back closes the big image first, then goes back a page', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openNext(page)
  await page.getByTestId('tile').first().dblclick()
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await page.goBack()
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
  await expect(page.getByTestId('query-input')).toBeVisible()

  await page.getByTestId('next-place-batch').click()
  await expect(page).toHaveURL(/#\/batch$/)
  await page.goBack()
  await expect(page).toHaveURL(/#\/library$/)
  await expect(page.getByTestId('next-place-library')).toHaveAttribute('aria-current', 'page')
  await page.goForward()
  await expect(page).toHaveURL(/#\/batch$/)
})

test('Clear current library on the footer asks first, the same way Settings does', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openNext(page)
  await page.getByTestId('next-clear-library').click()
  await expect(page).toHaveURL(/#\/settings\/library$/)
  const dialog = page.getByTestId('clear-index-dialog')
  await expect(dialog).toBeVisible()
  // Cancel has the focus; nothing is cleared
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await page.goBack()
  await expect(page.getByTestId('result-count')).toHaveText(COUNT_TEXT.en)
})

test('the classic interface opens the page an address names', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    // the entry page shows at launch here, so the link must be what skips it
    localStorage.setItem('aurora-entry-skip', '0')
  })
  await page.goto('/?ui=classic')
  await expect(page.locator('#entry-page')).toBeVisible()
  await page.goto('/?ui=classic&view=stylemap')
  await expect(page.locator('#view-stylemap')).toBeVisible()
  await expect(page.locator('#entry-page')).toBeHidden()
})
