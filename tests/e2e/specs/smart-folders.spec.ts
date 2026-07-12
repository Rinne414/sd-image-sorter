/**
 * Smart Folders v1 wiring spec.
 *
 * A saved filter preset can be PINNED from the filter modal's presets bar;
 * pinned presets appear as a persistent gallery-sidebar section with a LIVE
 * image count (POST /api/images/count, stubbed here) and one click applies
 * the full preset filter state through the same loadFilterPreset path the
 * presets UI uses. 0 pins = section hidden; >8 pins = capped list with a
 * "manage presets" overflow link.
 *
 * Backend routes are stubbed; presets/pins are seeded via localStorage so the
 * spec exercises the frontend wiring deterministically.
 */
import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1600, height: 900 } })

const MOCK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#dbe7f5"/>
  <circle cx="32" cy="32" r="14" fill="#7a93b8"/>
</svg>
`.trim()

const IMAGES = [
  { id: 9301, filename: 'smart-folder-1.png', path: 'L:/smart-folder-1.png', width: 64, height: 64 },
  { id: 9302, filename: 'smart-folder-2.png', path: 'L:/smart-folder-2.png', width: 64, height: 64 },
]

const PRESET_NAME = 'Neon City'
const PRESETS_KEY = 'sd-image-sorter-filter-presets'
const PINS_KEY = 'sd-image-sorter-smart-folder-pins'

async function mockRoutes(page: Page, countRequests: Array<Record<string, unknown>>) {
  const fulfillImage = async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  }
  await page.route('**/api/image-thumbnail/**', fulfillImage)
  await page.route('**/api/image-file/**', fulfillImage)
  await page.route('**/api/images?**', async (route) => {
    await route.fulfill({
      json: { images: IMAGES, total: IMAGES.length, has_more: false, next_cursor: null },
    })
  })
  await page.route('**/api/images/count', async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>
    countRequests.push(payload)
    await route.fulfill({ json: { count: 42, exact: true } })
  })
}

async function openFilterModal(page: Page) {
  await page.locator('#btn-open-filters').click()
  await expect(page.locator('#filter-modal')).toBeVisible()
}

async function closeFilterModal(page: Page) {
  await page.evaluate(() => (window as any).App.hideModal('filter-modal'))
  await expect(page.locator('#filter-modal')).toBeHidden()
}

test('pin toggle surfaces a live-count sidebar entry that applies the preset', async ({ page }) => {
  const countRequests: Array<Record<string, unknown>> = []
  await mockRoutes(page, countRequests)

  // Seed one saved preset (existing presets-store schema, untouched by pins).
  await page.addInitScript(({ presetsKey, presetName }) => {
    window.localStorage.setItem(presetsKey, JSON.stringify({
      [presetName]: { tags: ['neon'], tagMode: 'and' },
    }))
  }, { presetsKey: PRESETS_KEY, presetName: PRESET_NAME })

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // 0 pinned presets -> the section stays hidden.
  await expect(page.locator('#smart-folders-section')).toBeHidden()

  // Pin from the presets bar inside the filter modal.
  await openFilterModal(page)
  const pinButton = page.locator(`#filter-presets-list [data-preset-action="pin"][data-preset-name="${PRESET_NAME}"]`)
  await expect(pinButton).toBeVisible()
  await expect(pinButton).toHaveAttribute('aria-pressed', 'false')
  await pinButton.click()
  await expect(
    page.locator(`#filter-presets-list [data-preset-action="pin"][data-preset-name="${PRESET_NAME}"]`)
  ).toHaveAttribute('aria-pressed', 'true')

  // Pins persist in their own key beside the presets store.
  await expect.poll(async () => page.evaluate(
    (pinsKey) => JSON.parse(window.localStorage.getItem(pinsKey) || '[]'),
    PINS_KEY,
  )).toEqual([PRESET_NAME])

  await closeFilterModal(page)

  // Sidebar entry renders with the stubbed live count.
  const section = page.locator('#smart-folders-section')
  await expect(section).toBeVisible()
  const row = page.locator(`.smart-folder-row[data-smart-folder="${PRESET_NAME}"]`)
  await expect(row).toBeVisible()
  await expect(row.locator('.smart-folder-name')).toHaveText(PRESET_NAME)
  await expect(row.locator('.smart-folder-count')).toHaveText('42')

  // The count request carried the preset's filter contract.
  expect(countRequests.some((request) =>
    Array.isArray(request.tags) && (request.tags as string[]).includes('neon')
  )).toBe(true)

  // Clicking the entry restores the preset's filter state through the same
  // path presets use (loadFilterPreset -> FilterStore sync -> reload).
  await row.click()
  await expect.poll(async () => page.evaluate(
    () => (window as any).App.AppState.filters.tags
  )).toEqual(['neon'])

  // Pins survive a reload.
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator(`.smart-folder-row[data-smart-folder="${PRESET_NAME}"]`)).toBeVisible()

  // Unpin -> section hides again (empty state).
  await openFilterModal(page)
  await page.locator(`#filter-presets-list [data-preset-action="pin"][data-preset-name="${PRESET_NAME}"]`).click()
  await closeFilterModal(page)
  await expect(page.locator('#smart-folders-section')).toBeHidden()
  await expect.poll(async () => page.evaluate(
    (pinsKey) => JSON.parse(window.localStorage.getItem(pinsKey) || '[]'),
    PINS_KEY,
  )).toEqual([])
})

test('more than 8 pins collapse into a manage-presets overflow link', async ({ page }) => {
  const countRequests: Array<Record<string, unknown>> = []
  await mockRoutes(page, countRequests)

  await page.addInitScript(({ presetsKey, pinsKey }) => {
    const names = Array.from({ length: 10 }, (_, index) => `Pinned ${index + 1}`)
    const presets: Record<string, unknown> = {}
    for (const name of names) presets[name] = { tags: [], tagMode: 'and' }
    window.localStorage.setItem(presetsKey, JSON.stringify(presets))
    window.localStorage.setItem(pinsKey, JSON.stringify(names))
  }, { presetsKey: PRESETS_KEY, pinsKey: PINS_KEY })

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await expect(page.locator('#smart-folders-section')).toBeVisible()
  await expect(page.locator('.smart-folder-row')).toHaveCount(8)

  const more = page.locator('.smart-folder-more')
  await expect(more).toBeVisible()
  await expect(more).toContainText('2')

  // The overflow link routes to preset management (the filter modal).
  await more.click()
  await expect(page.locator('#filter-modal')).toBeVisible()
  await expect(page.locator('#filter-presets-list .preset-item')).toHaveCount(10)
})
