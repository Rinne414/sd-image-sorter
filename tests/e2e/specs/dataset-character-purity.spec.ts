import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

/**
 * Classic Dataset Maker: character purity (CCIP) reads pictures imported from a
 * folder too, by their paths, and a large folder import by its scan. It used to
 * skip them ("local imports are not in the DB yet"), so a dataset built from a
 * folder could not be checked. The CCIP endpoints are answered here (no model
 * is downloaded or run); the backend side is pinned by test_character_purity.py.
 */

const json = (route: Route, body: unknown) => route.fulfill({ json: body as object })

async function bootWithQueue(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._setActive === 'function' && !!(window as any).CharacterPurity)
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.waitForFunction(() => {
    const dm = (window as any).DatasetMaker
    return dm?._trainerContractState?.status === 'ready' && dm?._pendingProjectSettings === null
  })
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [801, 802, -21, -22]
    for (const [id, name] of [[801, 'lib-a.png'], [802, 'lib-b.png'], [-21, 'folder-a.png'], [-22, 'folder-b.png']] as const) {
      dm.meta.set(id, { filename: name, width: 512, height: 512 })
      dm.captions.set(id, '1girl')
    }
    dm.localItemPaths.set(-21, 'D:\\set\\folder-a.png')
    dm.localItemPaths.set(-22, 'D:\\set\\folder-b.png')
    dm._setActive(801)
  })
}

test('folder pictures are analysed with the Library ones and a flagged one can be located', async ({ page }) => {
  const started: Array<Record<string, unknown>> = []
  await page.route('**/api/dataset/character-purity/**', (route) => {
    const url = route.request().url()
    if (url.includes('/status')) {
      return json(route, { available: true, preparing: false, prepare_error: null, default_threshold: 0.178, missing_files: [] })
    }
    return json(route, {
      status: 'done', job_id: 'e2e-ccip', current: 4, total: 4, extracted: 4, failed: 0, message: '',
      result: {
        medoid_image_id: 801, threshold: 0.178, extracted: 4, failed: 0,
        items: [
          { image_id: 0, path: 'D:\\set\\folder-b.png', distance: 0.51, outlier: true },
          { image_id: 802, distance: 0.06, outlier: false },
          { image_id: 0, path: 'D:\\set\\folder-a.png', distance: 0.04, outlier: false },
          { image_id: 801, distance: 0, outlier: false },
        ],
      },
    })
  })
  await page.route('**/api/dataset/character-purity', (route) => {
    started.push(route.request().postDataJSON())
    return json(route, { status: 'starting', job_id: 'e2e-ccip', total: 4, message: '' })
  })
  await bootWithQueue(page)

  await page.evaluate(() => (window as any).CharacterPurity.run())
  await expect.poll(() => started.length).toBe(1)
  expect(started[0]).toMatchObject({ image_ids: [801, 802], image_paths: ['D:\\set\\folder-a.png', 'D:\\set\\folder-b.png'] })

  const results = page.locator('#ccip-results')
  await expect(results).toContainText('4 images analyzed')
  await expect(results).not.toContainText('local-import')
  const flagged = results.locator('.ccip-row-outlier')
  await expect(flagged).toHaveCount(1)
  await expect(flagged).toContainText('folder-b.png')
  // The card sits in the Workbench tab.
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-character-purity').evaluate((el) => { (el as HTMLDetailsElement).open = true })
  await flagged.click()
  expect(await page.evaluate(() => Number((window as any).DatasetMaker.activeId))).toBe(-22)
})
