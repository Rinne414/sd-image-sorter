import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, pageOverflow, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * Every page of the new interface at /next/ (docs/DESIGN.md §redesign-2026-10):
 * each fits every desktop size in both languages under the same top edge and
 * page line; Settings has one theme, the interface note and "reset all
 * settings"; the Censor menu turns the picks into a censoring batch; the
 * Similar menu ranks the library like the image in view.
 *
 * Needs the frontend-v4 build (it holds next.html): `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'nextpagestoken'
const COUNT = 12
const PREFIX = 'nextpages-'
const DIR = 'next-pages'

async function openAt(page: Page, hash: string, lang: 'en' | 'zh-CN' = 'en') {
  await page.addInitScript((language) => {
    const flag = 'nextpages-init-' + language
    if (sessionStorage.getItem(flag)) return
    sessionStorage.setItem(flag, '1')
    localStorage.setItem('sd-image-sorter-lang', language)
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' }))
    localStorage.setItem('sd-v4-update-autocheck', '0')
  }, lang)
  const res = await page.goto(`/next/${hash}`, { waitUntil: 'domcontentloaded' })
  // A change of the hash alone stays in the page and has no response.
  if (res) expect(res.status(), 'the new interface is not built: run npm run build in frontend-v4').toBe(200)
}

/** A page's own line under the top edge: its title is on screen and nothing scrolls sideways. */
async function expectPageFits(page: Page, title: RegExp) {
  await expect(page.getByRole('heading', { level: 1, name: title }).first()).toBeInViewport()
  await expect(page.getByTestId('import-button')).toBeInViewport()
  await expect(page.getByTestId('settings-button')).toBeInViewport()
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
}

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

const PAGES: { hash: string; en: RegExp; zh: RegExp }[] = [
  { hash: '#/batch', en: /^Batches$/, zh: /^批次$/ },
  { hash: '#/sort', en: /^Organize$/, zh: /^分拣$/ },
  { hash: '#/settings/appearance', en: /^Settings$/, zh: /^设置$/ },
  { hash: '#/tools/reader', en: /^Reader$/, zh: /^读图$/ },
  { hash: '#/tools/promptlab', en: /Prompt/, zh: /提示词/ },
]

for (const viewport of VIEWPORTS) {
  test(`every page fits at ${viewport.width}x${viewport.height} in both languages`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const lang of ['en', 'zh-CN'] as const) {
      // a new document per language: a hash change alone keeps the old one
      await page.goto('about:blank')
      for (const p of PAGES) {
        await openAt(page, p.hash, lang)
        await expectPageFits(page, lang === 'en' ? p.en : p.zh)
      }
    }
  })
}

test('Settings: one theme, the interface note, and reset all settings asks first, then resets', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, '#/settings/appearance')
  await expect(page.getByTestId('next-interface-note')).toBeVisible()
  await expect(page.getByText('Follow system', { exact: true })).toHaveCount(0)

  // a setting and a piece of work, to see which one goes
  await page.evaluate(() => {
    localStorage.setItem('sd-v4-ui-scale', '1.3')
    localStorage.setItem('sd-v4-saved-searches', '{"main":[{"id":"x","name":"mine","query":"smile"}]}')
  })
  await page.getByTestId('reset-all-open').click()
  const dialog = page.getByTestId('reset-all-dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Enter') // Cancel has the focus
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-ui-scale'))).toBe('1.3')

  await page.getByTestId('reset-all-open').click()
  await page.getByTestId('reset-all-ok').click()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sd-v4-ui-scale'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-saved-searches'))).toContain('mine')
})

test('Censor turns the picks into a censoring batch, opened on its censor step', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, '#/library')
  const input = page.getByTestId('query-input')
  await input.fill(TOKEN)
  await input.press('Enter')
  await expect(page.getByTestId('result-count')).toHaveText(`${COUNT} images`)
  await page.getByTestId('tile').first().click()
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Space')
  await page.getByTestId('next-censor').click()
  await page.getByRole('menuitem', { name: 'Censor the 2 picked images' }).click()
  await expect(page).toHaveURL(/#\/batch\/\d+$/)
  await expect(page.getByTestId('next-place-batch')).toHaveAttribute('aria-current', 'page')
})

test('Similar ranks the library like the image in view', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, '#/library')
  await page.getByTestId('tile').first().click()
  await page.getByTestId('next-similar').click()
  const item = page.getByRole('menuitem', { name: 'Like the image in view' })
  await expect(item).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'By image…' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Find duplicates…' })).toBeVisible()
})
