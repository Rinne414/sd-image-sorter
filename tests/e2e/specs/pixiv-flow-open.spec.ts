import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Pixiv-upload flow without hard stops: "select all matching" expands to ids,
 * the censor queue goes to the publish set in order, a whole-queue rename
 * also names images not loaded yet, and the whole queue survives a reload.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

function censorPairs(ids: number[]) {
  return {
    pairs: ids.map((id) => ({
      image_id: id,
      filename: `img-${id}.png`,
      path: `C:/set/img-${id}.png`,
      width: 64,
      height: 64,
      file_size: 100,
      found: false,
      missing: false,
    })),
  }
}

async function stubPublishPairs(page: Page, calls: number[][]) {
  await page.route('**/api/publish/censor-pairs', async (route) => {
    const ids = (route.request().postDataJSON() as { image_ids: number[] }).image_ids
    calls.push(ids)
    await route.fulfill({ json: censorPairs(ids) })
  })
}

test('"select all matching" expands to every id instead of the images on screen', async ({ page }) => {
  await page.route('**/api/images/selection-chunk**', async (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') || 0)
    const json = offset === 0
      ? { image_ids: [1, 2, 3], has_more: true, next_offset: 3 }
      : { image_ids: [4, 5], has_more: false, next_offset: 5 }
    await route.fulfill({ json })
  })
  await page.goto('/')
  const ids = await page.evaluate(async () => {
    const state = (window as any).App.AppState
    state.selectionScope = 'filtered'
    state.selectionToken = 'token-e2e'
    state.selectionTotal = 5
    state.selectedIds = new Set()
    state.selectionFilterKey = (window as any).getSelectionFilterCacheKey(state.filters)
    return (window as any).expandGallerySelectionIds()
  })
  expect(ids).toEqual([1, 2, 3, 4, 5])
})

test('the censor queue goes to the publish set in queue order', async ({ page }) => {
  const calls: number[][] = []
  await stubPublishPairs(page, calls)
  await page.goto('/')
  await page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    state.queue = [31, 12, 27].map((id) => ({
      id, originalFilename: `img-${id}.png`, outputFilename: `img-${id}.png`, editOperations: [],
    }))
  })
  await page.evaluate(() => (window as any).App.switchView('censor'))
  await page.locator('#btn-censor-to-publish-set').click()

  await expect(page.locator('#publish-set-modal.visible')).toBeVisible()
  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0]).toEqual([31, 12, 27])
})

test('a whole-queue rename also numbers images that load later', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => (window as any).App.switchView('censor'))
  const names = await page.evaluate(() => {
    const w = window as any
    const state = w.__CENSOR_STATE__
    state.queue = [1, 2].map((id) => ({ id, originalFilename: `a${id}.png`, outputFilename: `a${id}.png`, editOperations: [] }))
    state.selectedItems.clear()
    state.tokenQueueSource = {
      selectionToken: 'token-e2e', total: 4, exactTotal: true, hasMore: true, nextOffset: 2,
      loadedIds: new Set([1, 2]), loadedCount: 2, loading: false, visibleImageIds: [],
    }
    ;(document.getElementById('rename-use-original') as HTMLInputElement).checked = false
    ;(document.getElementById('rename-only-selected') as HTMLInputElement).checked = false
    ;(document.getElementById('rename-base') as HTMLInputElement).value = 'set'
    ;(document.getElementById('rename-start') as HTMLInputElement).value = '1'
    w.applyBatchRename()
    w.appendCensorQueueImages([{ id: 3, filename: 'a3.png' }, { id: 4, filename: 'a4.png' }], { tokenSource: state.tokenQueueSource })
    return state.queue.map((item: any) => item.outputFilename)
  })
  expect(names).toEqual(['set_001.png', 'set_002.png', 'set_003.png', 'set_004.png'])
  await expect(page.locator('#toast-container .toast', { hasText: 'continue the numbering' }).first()).toBeVisible()
})

test('the whole censor queue is stored, not just the first 500', async ({ page }) => {
  await page.goto('/')
  const stored = await page.evaluate(() => {
    const w = window as any
    w.__CENSOR_STATE__.queue = Array.from({ length: 800 }, (_, index) => ({
      id: index + 1, originalFilename: `f${index + 1}.png`, outputFilename: `set_${index + 1}.png`, editOperations: [],
    }))
    w.persistCensorQueue()
    return JSON.parse(localStorage.getItem('censor-queue-v1') || '{}').items.length
  })
  expect(stored).toBe(800)
})

test('one clicked thumbnail does not narrow Batch Rename to that image', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    state.queue = [1, 2, 3].map((id) => ({ id, originalFilename: `b${id}.png`, outputFilename: `b${id}.png`, editOperations: [] }))
    state.selectedItems = new Set([2])
  })
  await page.evaluate(() => (window as any).App.switchView('censor'))
  await page.locator('#btn-batch-rename').click()
  await expect(page.locator('#rename-only-selected')).not.toBeChecked()
})

test('images that load after a rename never reuse a name, even after one was removed', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => (window as any).App.switchView('censor'))
  const names = await page.evaluate(() => {
    const w = window as any
    const state = w.__CENSOR_STATE__
    state.queue = [1, 2].map((id) => ({ id, originalFilename: `a${id}.png`, outputFilename: `a${id}.png`, editOperations: [] }))
    state.selectedItems.clear()
    state.tokenQueueSource = {
      selectionToken: 'token-e2e', total: 4, exactTotal: true, hasMore: true, nextOffset: 2,
      loadedIds: new Set([1, 2]), loadedCount: 2, loading: false, visibleImageIds: [],
    }
    ;(document.getElementById('rename-use-original') as HTMLInputElement).checked = false
    ;(document.getElementById('rename-only-selected') as HTMLInputElement).checked = false
    ;(document.getElementById('rename-base') as HTMLInputElement).value = 'set'
    ;(document.getElementById('rename-start') as HTMLInputElement).value = '1'
    w.applyBatchRename()
    // The user drops set_001 from the queue before the rest loads.
    state.queue = state.queue.filter((item: any) => item.id !== 1)
    w.appendCensorQueueImages([{ id: 3, filename: 'a3.png' }, { id: 4, filename: 'a4.png' }], { tokenSource: state.tokenQueueSource })
    return state.queue.map((item: any) => item.outputFilename)
  })
  expect(names[0]).toBe('set_002.png')
  expect(new Set(names.map((name: string) => name.toLowerCase())).size).toBe(names.length)
})
