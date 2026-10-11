import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Issue #5 (sd-dataset-tag-editor style workflow in the Dataset Maker): the
 * queue filters by tags — include (AND) + exclude (OR), a visible count, one
 * Clear action, vocabulary clicks add an include filter, the virtualized
 * queue (> 800 items) honours it, and caption actions can target exactly the
 * filtered set. The vocabulary counts themselves: dataset-vocab-shown-captions.
 */

async function stubDatasetRoutes(page: Page, options: { stubVocab?: boolean } = {}) {
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/image-file/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  if (options.stubVocab !== false) {
    await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  }
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
}

async function openDatasetWith(page: Page, captions: Record<number, string>, options: { stubVocab?: boolean } = {}) {
  await stubDatasetRoutes(page, options)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate((entries) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = entries.map(([id]) => id)
    for (const [id, caption] of entries) {
      dm.meta.set(id, { filename: `img_${id}.png`, width: 512, height: 512 })
      dm.captions.set(id, caption)
    }
    ;(window as any).App.switchView('dataset')
  }, Object.entries(captions).map(([id, caption]) => [Number(id), caption] as [number, string]))
  await page.locator('#dataset-tab-workbench').click()
  await page.evaluate(() => (window as any).DatasetMaker._setQueueViewMode('list'))
}

async function openVocabPanel(page: Page) {
  await page.evaluate(() => {
    ;(document.getElementById('dataset-step-cleanup') as HTMLDetailsElement).open = true
  })
  await page.locator('#dataset-vocab-panel > summary').click()
}

async function shownIds(page: Page) {
  return page.locator('#dataset-queue-list .dataset-queue-item').evaluateAll((items) =>
    items.map((item) => Number((item as HTMLElement).dataset.imageId)).sort((a, b) => a - b))
}

/** The scope <select> is wrapped by the dataset custom dropdown; use its real UI. */
async function chooseCaptionScope(page: Page, value: string) {
  const button = page.locator('.dataset-custom-dropdown[data-select-id="dataset-caption-scope"] button')
  // The page scrolls smoothly, and any scroll closes an open dropdown: bring the
  // button into view instantly so no animation runs after the click opens the list.
  await button.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await button.click()
  await page.locator(`.dataset-custom-dropdown-list:not([hidden]) .dataset-custom-dropdown-option[data-value="${value}"]`).click()
  await expect(page.locator('#dataset-caption-scope')).toHaveValue(value)
}

async function addTagFilter(page: Page, tag: string, mode: 'include' | 'exclude') {
  await page.locator('#dataset-queue-tag-input').fill(tag)
  await page.locator(mode === 'include' ? '#btn-dataset-queue-tag-include' : '#btn-dataset-queue-tag-exclude').click()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
})

const FILTER_CAPTIONS = {
  901: '1girl, long hair, hat',
  902: '1girl, Long_Hair',
  903: '1girl, short hair',
  904: 'solo, long hair, smile',
  905: '',
  906: '1girl, long_hair, hat, smile',
}

test('include tags narrow with AND, exclude tags drop with OR, and Clear restores the queue', async ({ page }) => {
  await openDatasetWith(page, FILTER_CAPTIONS)
  const count = page.locator('#dataset-queue-filter-count')
  await expect(count).toBeHidden()

  // Underscore/space and case fold like find/replace: "long_hair" matches "long hair" and "Long_Hair".
  await addTagFilter(page, 'long_hair', 'include')
  await expect.poll(() => shownIds(page)).toEqual([901, 902, 904, 906])
  await expect(count).toHaveText('Showing 4 of 6')
  await expect(page.locator('#dataset-queue-tag-input')).toHaveValue('')
  // Order badges keep each image's real queue position, not its filtered row.
  await expect(page.locator('#dataset-queue-list .dataset-queue-order')).toHaveText(['1', '2', '4', '6'])

  await addTagFilter(page, 'Hat', 'exclude')
  await expect.poll(() => shownIds(page)).toEqual([902, 904])

  await addTagFilter(page, '1girl', 'include')
  await expect.poll(() => shownIds(page)).toEqual([902])
  await expect(count).toHaveText('Showing 1 of 6')
  await expect(page.locator('#dataset-queue-tag-chips .dataset-queue-tag-chip')).toHaveCount(3)

  // A chip removes just its own tag.
  await page.locator('#dataset-queue-tag-chips .dataset-queue-tag-chip[data-tag="1girl"]').click()
  await expect.poll(() => shownIds(page)).toEqual([902, 904])

  // Enter in the box adds an include filter too.
  await page.locator('#dataset-queue-tag-input').fill('smile')
  await page.locator('#dataset-queue-tag-input').press('Enter')
  await expect.poll(() => shownIds(page)).toEqual([904])

  await page.locator('#btn-dataset-queue-clear-filters').click()
  await expect.poll(() => shownIds(page)).toEqual([901, 902, 903, 904, 905, 906])
  await expect(page.locator('#dataset-queue-tag-chips .dataset-queue-tag-chip')).toHaveCount(0)
  await expect(count).toBeHidden()
})

test('clicking a vocabulary tag adds it as an include filter and clicking again removes it', async ({ page }) => {
  await openDatasetWith(page, FILTER_CAPTIONS, { stubVocab: false })
  await openVocabPanel(page)
  const hatLabel = page.locator('#dataset-vocab-list .dataset-vocab-tag-label', { hasText: /^hat$/ })
  await expect(hatLabel).toHaveAttribute('aria-pressed', 'false')

  await hatLabel.click()
  await expect.poll(() => shownIds(page)).toEqual([901, 906])
  await expect(hatLabel).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#dataset-queue-tag-chips .dataset-queue-tag-chip.is-include')).toHaveText(/hat/)

  await hatLabel.click()
  await expect.poll(() => shownIds(page)).toEqual([901, 902, 903, 904, 905, 906])
  await expect(hatLabel).toHaveAttribute('aria-pressed', 'false')
})

test('caption actions can target exactly the filtered set and say so', async ({ page }) => {
  await openDatasetWith(page, FILTER_CAPTIONS)
  await addTagFilter(page, 'hat', 'include')
  await expect.poll(() => shownIds(page)).toEqual([901, 906])

  await page.evaluate(() => {
    ;(document.getElementById('dataset-step-cleanup') as HTMLDetailsElement).open = true
    ;(document.getElementById('dataset-step-findreplace') as HTMLDetailsElement).open = true
  })
  await chooseCaptionScope(page, 'filtered')
  await expect(page.locator('#dataset-caption-scope-summary')).toHaveText('Changes the 2 images shown in the queue.')
  await expect(page.locator('#dataset-findreplace-scope-summary')).toHaveText('Changes the 2 images shown in the queue.')

  await page.locator('#dataset-find-input').fill('smile')
  await page.locator('#dataset-replace-input').fill('grin')
  await page.locator('#btn-dataset-find-replace').click()

  const captionOf = (id: number) => page.evaluate((imageId) => {
    const dm = (window as any).DatasetMaker
    return dm.captionEdits.has(imageId) ? dm.captionEdits.get(imageId) : dm.captions.get(imageId)
  }, id)
  await expect.poll(() => captionOf(906)).toBe('1girl, long_hair, hat, grin')
  // 904 has "smile" but is hidden by the filter, so it is untouched.
  expect(await captionOf(904)).toBe('solo, long hair, smile')

  // Other scopes describe their own target set.
  await chooseCaptionScope(page, 'all')
  await expect(page.locator('#dataset-caption-scope-summary')).toHaveText('Changes all 6 images.')
})

test('select all, shift ranges and next/previous stay inside the filtered queue', async ({ page }) => {
  await openDatasetWith(page, FILTER_CAPTIONS)
  await addTagFilter(page, 'short_hair', 'exclude')
  await expect.poll(() => shownIds(page)).toEqual([901, 902, 904, 905, 906])

  // Removing "selected" images must never reach images the filter hides.
  await page.locator('#btn-dataset-queue-select-all').click()
  const selection = () => page.evaluate(() =>
    [...(window as any).DatasetMaker._queueSelection].map(Number).sort((a: number, b: number) => a - b))
  expect(await selection()).toEqual([901, 902, 904, 905, 906])

  await page.locator('#btn-dataset-queue-clear-selection').click()
  await page.locator('#dataset-queue-list .dataset-queue-item[data-image-id="902"]').click({ modifiers: ['Control'] })
  await page.locator('#dataset-queue-list .dataset-queue-item[data-image-id="905"]').click({ modifiers: ['Shift'] })
  expect(await selection()).toEqual([902, 904, 905])

  const activeId = () => page.evaluate(() => Number((window as any).DatasetMaker.activeId))
  await page.locator('#dataset-queue-list .dataset-queue-item[data-image-id="902"]').click()
  await page.locator('#btn-dataset-next-image').click()
  await expect.poll(activeId).toBe(904)
  await page.locator('#btn-dataset-prev-image').click()
  await expect.poll(activeId).toBe(902)

  // A filter change drops selected images that it hides.
  await page.locator('#btn-dataset-queue-select-all').click()
  await addTagFilter(page, 'hat', 'include')
  await expect.poll(() => shownIds(page)).toEqual([901, 906])
  expect(await selection()).toEqual([901, 906])
})

test('the virtualized queue (over 800 images) renders only images that pass the tag filter', async ({ page }) => {
  const QUEUE_SIZE = 1700
  const FIRST_ID = 20_000
  const captions: Record<number, string> = {}
  for (let i = 0; i < QUEUE_SIZE; i += 1) {
    const id = FIRST_ID + i
    captions[id] = i % 2 === 0 ? '1girl, blue sky' : '1girl, indoors'
  }
  await openDatasetWith(page, captions)
  await expect(page.locator('#dataset-queue-list.is-virtualized')).toBeVisible()

  await addTagFilter(page, 'blue_sky', 'include')
  await expect(page.locator('#dataset-queue-filter-count')).toHaveText('Showing 850 of 1,700')
  const list = page.locator('#dataset-queue-list')
  await expect(list).toHaveClass(/is-virtualized/)
  await expect(list).toHaveAttribute('data-virtual-rows', '850')
  await expect.poll(async () => (await shownIds(page)).length).toBeGreaterThan(1)
  expect((await shownIds(page)).every((id) => (id - FIRST_ID) % 2 === 0)).toBe(true)
  const firstRow = page.locator(`#dataset-queue-list .dataset-queue-item[data-image-id="${FIRST_ID + 2}"]`)
  await expect(firstRow.locator('.dataset-queue-order')).toHaveText('3')

  // Scrolling deep into the filtered list still shows only matching rows.
  await list.evaluate((el) => { el.scrollTop = Math.floor(el.scrollHeight * 0.8) })
  await expect.poll(async () => Math.min(...(await shownIds(page)))).toBeGreaterThan(FIRST_ID + 1000)
  expect((await shownIds(page)).every((id) => (id - FIRST_ID) % 2 === 0)).toBe(true)
})

async function expectFiltersReset(page: Page, ids: number[]) {
  await expect(page.locator('#dataset-queue-tag-chips .dataset-queue-tag-chip')).toHaveCount(0)
  await expect(page.locator('#dataset-queue-filter-count')).toBeHidden()
  await expect(page.locator('#dataset-queue-caption-filter')).toHaveValue('all')
  await expect.poll(() => shownIds(page)).toEqual(ids)
  expect(await page.evaluate(() => (window as any).DatasetMaker._queueTagFilter))
    .toEqual({ include: [], exclude: [] })
}

test('loading a project starts with no queue filter so its images are not hidden', async ({ page }) => {
  await openDatasetWith(page, FILTER_CAPTIONS)
  await page.locator('#dataset-queue-caption-filter').selectOption('tagged')
  await addTagFilter(page, 'hat', 'include')
  await expect.poll(() => shownIds(page)).toEqual([901, 906])

  const settings = await page.evaluate(() => (window as any).DatasetMaker._serializeProjectSettings())
  const now = '2026-10-10T00:00:00Z'
  const project = {
    id: 95,
    name: 'Filter reset',
    revision: 1,
    archived_at: null,
    created_at: now,
    updated_at: now,
    settings,
    items: [951, 952].map((id, position) => ({
      position, item_type: 'library', source_image_id: id, image_id: id, missing: false,
    })),
    missing_image_ids: [],
  }
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: {
      projects: [{
        id: 95, name: project.name, revision: 1, archived_at: null,
        created_at: now, updated_at: now, item_count: 2, missing_image_count: 0,
      }],
    },
  }))
  await page.route('**/api/dataset/projects/95', (route) => route.fulfill({ json: project }))
  await page.route(/\/api\/annotations\/projects\/95\/training-captions\/heads(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { project_id: 95, items: [], has_more: false, next_after_subject_id: null } }))
  await page.evaluate(() => (window as any).DatasetMaker._refreshProjectLists())

  await page.getByTestId('dataset-project-selector').selectOption('95')
  // The unsaved draft holds images, so loading asks before replacing it.
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await page.locator('#btn-confirm-ok').click()
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  await expectFiltersReset(page, [951, 952])
})

test('clearing the dataset drops the queue filter before the next import', async ({ page }) => {
  await openDatasetWith(page, FILTER_CAPTIONS)
  await addTagFilter(page, 'hat', 'include')
  await addTagFilter(page, 'smile', 'exclude')
  await expect.poll(() => shownIds(page)).toEqual([901])

  await page.locator('#btn-dataset-clear').click()
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await page.locator('#btn-confirm-ok').click()
  await expect.poll(() => page.evaluate(() => (window as any).DatasetMaker.imageIds.length)).toBe(0)

  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [961, 962]
    dm.captions.set(961, '1girl, smile')
    dm.captions.set(962, 'solo')
    dm._renderQueue()
  })
  await expectFiltersReset(page, [961, 962])
})
