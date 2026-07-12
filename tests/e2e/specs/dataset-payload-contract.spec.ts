import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * FE-4 + FE-1 invariant pins: the Dataset Maker export wire format.
 *
 * FE-1 (editor consolidation) is a large mechanical refactor whose one hard
 * promise is "the wire format does not change". These tests pin:
 *
 *   1. the exact key set `_buildExportPayload()` produces (POSTed verbatim
 *      to /api/dataset/export by _runExport);
 *   2. the exact key set the export-preview request carries
 *      (payload + output_mode override + limit);
 *   3. FE-4 (decision #11): the preview renders SERVER-provided output
 *      names only — the offline render_stem re-implementation is deleted,
 *      and a missing payload builder shows an error instead of silently
 *      synthesizing stems client-side.
 *
 * If a change here is intentional, update backend + docs/API.md + this pin
 * in the same commit.
 */

test.describe.configure({ mode: 'serial' })

const EXPORT_PAYLOAD_KEYS = [
  'blacklist',
  'caption_transforms',
  'common_tags',
  'content_mode',
  'dataset_scan_tokens',
  'image_ids',
  'image_nl_overrides',
  'image_op',
  'image_overrides',
  'image_paths',
  'image_types',
  'mask_export',
  'naming_pattern',
  'normalize_tag_underscores',
  'output_folder',
  'output_mode',
  'overwrite_policy',
  'prefix',
  'template_options',
  'trainer_batch',
  'trainer_config',
  'trainer_repeats',
  'trigger',
].sort()

// The pipeline preview reuses the export payload and adds a row cap.
const PREVIEW_PAYLOAD_KEYS = [...EXPORT_PAYLOAD_KEYS, 'limit'].sort()

async function seedDatasetQueue(page: Page) {
  await page.route('**/api/image-thumbnail/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._setActive === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [501, 502]
    dm.meta.set(501, { filename: 'contract-a.png', width: 1024, height: 1024 })
    dm.meta.set(502, { filename: 'contract-b.png', width: 1024, height: 1024 })
    dm.captions.set(501, '1girl, standing')
    dm.captions.set(502, '1girl, sitting')
    ;(window as any).App.switchView('dataset')
    dm._setActive(501)
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('export payload key set is pinned (the /api/dataset/export wire format)', async ({ page }) => {
  await seedDatasetQueue(page)
  const keys = await page.evaluate(() => {
    const payload = (window as any).DatasetMaker._buildExportPayload()
    return Object.keys(payload).sort()
  })
  expect(keys).toEqual(EXPORT_PAYLOAD_KEYS)
})

test('export-preview request carries the pinned payload and renders SERVER output names', async ({ page }) => {
  await seedDatasetQueue(page)

  let capturedBody: Record<string, unknown> | null = null
  await page.route('**/api/dataset/export-preview', async (route) => {
    capturedBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      json: {
        total: 2,
        returned: 1,
        items: [
          {
            index: 1,
            image_id: 501,
            filename: 'contract-a.png',
            output_image_name: 'server_rendered_001.png',
            output_caption_name: 'server_rendered_001.txt',
            caption: '1girl, standing',
            thumbnail_url: '',
          },
        ],
      },
    })
  })

  await page.evaluate(() => (window as any).DatasetMaker._refreshExportPreview())
  const list = page.locator('#dataset-export-preview-list')
  // FE-4: the rendered name is exactly what the server said — no client-side
  // stem synthesis exists anymore.
  await expect(list).toContainText('server_rendered_001.png')

  expect(capturedBody).not.toBeNull()
  expect(Object.keys(capturedBody!).sort()).toEqual(PREVIEW_PAYLOAD_KEYS)
})

test('missing payload builder shows an error instead of an offline preview (FE-4)', async ({ page }) => {
  await seedDatasetQueue(page)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.__realBuildExportPayload = dm._buildExportPayload
    dm._buildExportPayload = null
  })
  await page.evaluate(() => (window as any).DatasetMaker._refreshExportPreview())
  const list = page.locator('#dataset-export-preview-list')
  await expect(list).toContainText('Preview unavailable')
  // No synthesized filename rows — the old fallback rendered .png/.txt pairs.
  await expect(list.locator('.dataset-export-preview-pair')).toHaveCount(0)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._buildExportPayload = dm.__realBuildExportPayload
    delete dm.__realBuildExportPayload
  })
})
