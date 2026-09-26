import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * The Dataset Maker workbench keys (A/D/arrows step, X drop, Z undo drop,
 * Delete remove) checked `#view-dataset.hidden`, but views switch with the
 * `.active` class, so the keys worked on every page: Delete in the Gallery or
 * in Censor Edit removed the dataset's current image.
 */

test.use({ viewport: { width: 1366, height: 768 } })

async function seedDatasetQueue(page: Page) {
  await page.route('**/api/image-thumbnail/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.waitForFunction(() => {
    const dm = (window as any).DatasetMaker
    return dm?._trainerContractState?.status === 'ready' && dm?._pendingProjectSettings === null
  })
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [701, 702, 703]
    for (const id of dm.imageIds) dm.meta.set(id, { filename: `hotkey-${id}.png`, width: 512, height: 512 })
    dm._renderQueue()
    dm._setActive(701)
    dm._setPipelineTab('workbench')
  })
}

function datasetState(page: Page) {
  return page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return { ids: [...dm.imageIds], active: dm.activeId }
  })
}

async function blurEverything(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

test('workbench keys act in Dataset Maker and nowhere else', async ({ page }) => {
  await seedDatasetQueue(page)
  await blurEverything(page)
  await page.keyboard.press('d')
  await expect.poll(() => datasetState(page)).toEqual({ ids: [701, 702, 703], active: 702 })

  for (const view of ['gallery', 'censor']) {
    await page.evaluate((name) => (window as any).App.switchView(name), view)
    await expect(page.locator(`#view-${view}`)).toHaveClass(/active/)
    await blurEverything(page)
    for (const key of ['Delete', 'd', 'a', 'x']) {
      await page.keyboard.press(key)
    }
    expect(await datasetState(page)).toEqual({ ids: [701, 702, 703], active: 702 })
  }
})
