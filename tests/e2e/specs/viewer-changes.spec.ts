import { expect, test, type Page } from '@playwright/test'

/**
 * The picture viewer's "Changed from the picture before": only the
 * differences, the compared picture one click away, and no section at all
 * when there is nothing to compare.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function mockViewer(page: Page, changes: Record<number, unknown>) {
  const images = [5001, 5002, 5003].map((id) => ({
    id, filename: `try-${id}.png`, path: `/mock/try-${id}.png`, prompt: id === 5003 ? '' : '1girl, rain', generator: 'comfyui',
  }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    const changed = url.pathname.match(/^\/api\/images\/(\d+)\/changes$/)
    const one = url.pathname.match(/^\/api\/images\/(\d+)$/)
    if (changed) await route.fulfill({ json: changes[Number(changed[1])] ?? { before: null, comparable: false } })
    else if (one) await route.fulfill({ json: { image: images.find((image) => image.id === Number(one[1])), tags: [] } })
    else if (url.pathname === '/api/images') await route.fulfill({ json: { images, total: 3, has_more: false, next_cursor: null } })
    else await route.continue()
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
}

test('the viewer lists what changed from the picture before and opens that picture', async ({ page }) => {
  await mockViewer(page, {
    5001: {
      before: { id: 5002, filename: 'try-5002.png' }, after: { id: 5001, filename: 'try-5001.png' },
      comparable: true, same: false, picked: false,
      seed: { before: 1, after: 2, same: false },
      settings: [{ key: 'steps', before: 28, after: 30 }, { key: 'cfg', before: 7, after: 5.5 }],
      loras: { added: [{ name: 'detail', weight: 0.8 }], removed: [], reweighted: [{ name: 'flat', before: 1, after: 0.6 }] },
      prompt: { added: ['umbrella'], removed: ['hat'] },
      negative_prompt: { added: [], removed: [] },
    },
    5002: {
      before: { id: 5003, filename: 'try-5003.png' }, after: { id: 5002, filename: 'try-5002.png' },
      comparable: true, same: true, picked: false,
      seed: { before: 1, after: 2, same: false }, settings: [],
      loras: { added: [], removed: [], reweighted: [] }, prompt: { added: [], removed: [] }, negative_prompt: { added: [], removed: [] },
    },
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()

  await page.evaluate(() => (window as any).Gallery.openPreview(5001))
  const section = page.locator('#modal-changes-section')
  await expect(section).toBeVisible()
  await expect(section.locator('.modal-change-word.is-added').first()).toHaveText('+ umbrella')
  await expect(section.locator('.modal-change-word.is-removed').first()).toHaveText('- hat')
  await expect(section).toContainText('Steps')
  await expect(section.locator('.modal-change-before').first()).toHaveText('28')
  await expect(section.locator('.modal-change-after').first()).toHaveText('30')
  await expect(section).toContainText('+ detail (0.8)')
  await expect(section).toContainText('LoRA flat')
  await expect(section).toContainText('The seed differs too.')
  // Nothing sticks out of the info column.
  const fits = await section.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
  expect(fits).toBe(true)

  // The compared picture is one click away; it has the same recipe.
  await section.locator('.modal-change-link').click()
  await expect(page.locator('#modal-filename')).toHaveText('try-5002.png')
  await expect(section).toContainText('Same prompt and settings; only the seed differs.')

  // A picture with no generation data shows no section at all.
  await page.evaluate(() => (window as any).Gallery.openPreview(5003))
  await expect(page.locator('#modal-filename')).toHaveText('try-5003.png')
  await expect(section).toBeHidden()
})

test('two selected pictures are compared side by side from the selection bar', async ({ page }) => {
  const asked: string[] = []
  await mockViewer(page, {
    5002: {
      before: { id: 5001, filename: 'try-5001.png' }, after: { id: 5002, filename: 'try-5002.png' },
      comparable: true, same: false, picked: true,
      seed: { before: 1, after: 1, same: true },
      settings: [{ key: 'sampler', before: 'Euler a', after: 'DPM++ 2M' }],
      loras: { added: [], removed: [], reweighted: [] },
      prompt: { added: ['umbrella'], removed: [] },
      negative_prompt: { added: [], removed: [] },
    },
  })
  page.on('request', (request) => {
    if (request.url().includes('/changes')) asked.push(new URL(request.url()).pathname + new URL(request.url()).search)
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  const select = (ids: number[]) => page.evaluate((list) => {
    const app = (window as any).App
    app.setSelectionMode(true)
    app.clearSelectedIds?.({ scope: 'visible' })
    app.mutateSelectedIds((selected: Set<number>) => { list.forEach((id) => selected.add(id)) }, { scope: 'visible' })
    app.updateSelectionUI()
    app.emitSelectionStateChanged()
  }, ids)

  // One or three selected: it says what it needs and opens nothing.
  await select([5001])
  await page.locator('#btn-gallery-action-more').click()
  await page.locator('#btn-compare-selected').click()
  await expect(page.locator('#toast-container .toast').last()).toContainText('Select exactly two pictures')
  expect(asked).toEqual([])

  await select([5002, 5001])
  await page.locator('#btn-gallery-action-more').click()
  await page.locator('#btn-compare-selected').click()
  const dialog = page.locator('#compare-two-modal')
  await expect(dialog).toHaveClass(/visible/)
  // The earlier picture is the one compared against, whatever the click order.
  expect(asked).toEqual(['/api/images/5002/changes?against=5001'])
  await expect(dialog.locator('.compare-two-picture')).toHaveText([/Before\s*try-5001\.png/, /After\s*try-5002\.png/])
  await expect(dialog.locator('.modal-change-word.is-added')).toHaveText('+ umbrella')
  await expect(dialog.locator('.modal-change-after')).toHaveText('DPM++ 2M')
  await expect(dialog).toContainText('The seed is the same.')

  // Either picture opens in the viewer from here.
  await dialog.locator('.compare-two-picture').last().click()
  await expect(dialog).not.toHaveClass(/visible/)
  await expect(page.locator('#modal-filename')).toHaveText('try-5002.png')
})
