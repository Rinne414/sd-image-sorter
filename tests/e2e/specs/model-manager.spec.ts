import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const defaultPort = process.env.PW_WEB_SERVER_PORT || process.env.SD_IMAGE_SORTER_PORT || '19087'
const e2eDataDir = path.join(repoRoot, '.tmp', `e2e-data-${defaultPort}`)

async function resetModelFixtures() {
  await fs.rm(path.join(e2eDataDir, 'models'), { recursive: true, force: true })
  await fs.rm(path.join(e2eDataDir, 'config'), { recursive: true, force: true })
}

async function openModelManager(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#btn-open-model-manager').click()
  await expect(page.locator('#model-manager-modal')).toBeVisible()
  await expect(page.locator('.model-card').first()).toBeVisible({ timeout: 15_000 })
}

async function mockMinimalModelStatus(page: Page) {
  await page.route('**/api/models/status', async (route) => {
    await route.fulfill({
      json: {
        status: 'ok',
        models: [
          {
            id: 'wd14',
            name: 'WD14 Tagger',
            group: 'Tagging',
            status: 'missing',
            status_label: 'Missing',
            available: false,
            message: 'WD14 files are missing.',
            download_supported: true,
          },
        ],
        health: {},
      },
    })
  })
  await page.route('**/api/models/mirror', async (route) => {
    await route.fulfill({ json: { mirror: 'auto', options: ['auto', 'hf-mirror', 'modelscope'] } })
  })
}

function diskUsagePayload(overrides: Record<string, unknown> = {}) {
  return {
    safe_to_clean: [
      {
        key: 'thumbnails',
        label_key: 'disk.cache.thumbnails',
        path: '/tmp/sd-image-sorter/thumbnails',
        size_bytes: null,
        size_complete: false,
        exists: true,
      },
      {
        key: 'pip_cache',
        label_key: 'disk.cache.pip',
        path: '/tmp/sd-image-sorter/pip-cache',
        size_bytes: 1024 * 1024,
        size_complete: true,
        exists: true,
      },
    ],
    preserved: [
      {
        key: 'models',
        label_key: 'disk.preserved.models',
        size_bytes: null,
        size_complete: false,
      },
    ],
    settings: { thumbnail_cache_max_mb: 500 },
    thumbnail_cache: {
      file_count: 10000,
      file_count_complete: false,
      total_size_bytes: null,
      total_size_mb: null,
      max_size_bytes: 500 * 1024 * 1024,
      max_size_mb: 500,
      limit_enabled: true,
    },
    runtime_environment: {
      venv_path: '/tmp/sd-image-sorter/backend/venv',
      venv_exists: true,
      venv_size_bytes: null,
      venv_size_complete: false,
      rebuild_core_pending: false,
      rebuild_marker_path: '/tmp/sd-image-sorter/data/state/rebuild-core-venv.json',
    },
    ...overrides,
  }
}

test.describe('Model Manager', () => {
  test.beforeEach(async () => {
    await resetModelFixtures()
  })

  test('model download progress updates while the frontend remains responsive', async ({ page }) => {
    await openModelManager(page)

    const card = page.locator('.model-card[data-model-id="artist"]')
    await expect(card.locator('.model-card-status')).toContainText(/Missing|缺失/)

    const prepareButton = card.locator('.btn-prepare-model')
    await prepareButton.click()

    await expect(prepareButton).toContainText(/best_checkpoint\.pth.*MB/i, { timeout: 10_000 })

    const closeButton = page.locator('#model-manager-close')
    await expect(closeButton).toBeVisible()
    await expect(closeButton).toBeEnabled()
    await page.locator('#model-mirror-select').selectOption('hf-mirror')
    await expect(card.locator('.model-card-status')).toContainText(/Ready|已就绪/, { timeout: 30_000 })
  })

  test('Kaloscope prepare completes and changes Artist ID from Missing to Ready', async ({ page, request }) => {
    await openModelManager(page)

    const card = page.locator('.model-card[data-model-id="artist"]')
    await expect(card.locator('.model-card-status')).toContainText(/Missing|缺失/)

    await card.locator('.btn-prepare-model').click()
    await expect(card.locator('.model-card-status')).toContainText(/Ready|已就绪/, { timeout: 30_000 })

    const response = await request.get('/api/models/status')
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body.health.artist.available).toBe(true)
    expect(body.health.artist.checkpoint_path).toContain('data')
    expect(body.health.artist.runtime_path).toContain('data')
  })


  test('disk usage explains cache tradeoff, handles incomplete large scans, and saves the cache limit', async ({ page }) => {
    await mockMinimalModelStatus(page)

    let cachePayload = diskUsagePayload()
    const settingsPayloads: unknown[] = []

    await page.route('**/api/disk/cache-status', async (route) => {
      await route.fulfill({ json: cachePayload })
    })
    await page.route('**/api/disk/settings', async (route) => {
      const body = route.request().postDataJSON()
      settingsPayloads.push(body)
      const thumbnailLimit = Number(body?.thumbnail_cache_max_mb)
      cachePayload = diskUsagePayload({
        settings: { thumbnail_cache_max_mb: thumbnailLimit },
        thumbnail_cache: {
          file_count: 1200,
          file_count_complete: true,
          total_size_bytes: 64 * 1024 * 1024,
          total_size_mb: 64,
          max_size_bytes: thumbnailLimit * 1024 * 1024,
          max_size_mb: thumbnailLimit,
          limit_enabled: thumbnailLimit > 0,
        },
      })
      await route.fulfill({
        json: {
          settings: { thumbnail_cache_max_mb: thumbnailLimit },
          thumbnail_cache: cachePayload.thumbnail_cache,
          limit_cleanup: {
            deleted_count: 3,
            freed_bytes: 12 * 1024 * 1024,
          },
        },
      })
    })

    await openModelManager(page)

    const diskBody = page.locator('#disk-usage-body')
    await expect(diskBody).toContainText(/Thumbnail cache limit|缩略图缓存上限/)
    await expect(diskBody).toContainText(/large \/ not fully scanned|未完整扫描/i)
    await expect(diskBody).toContainText(/CPU\/?IO|CPU.*IO|CPU.*I\/O/i)
    await expect(page.locator('#thumbnail-cache-limit-input')).toHaveValue('500')

    await page.locator('#thumbnail-cache-limit-input').fill('128')
    await page.locator('#btn-save-cache-settings').click()

    await expect.poll(() => settingsPayloads.length).toBe(1)
    expect(settingsPayloads[0]).toEqual({ thumbnail_cache_max_mb: 128 })
    await expect(page.locator('#thumbnail-cache-limit-input')).toHaveValue('128')
    await expect(diskBody).toContainText(/128 MB/)
    await expect(page.locator('.toast-message').last()).toContainText(/Cache limit saved|已保存缓存上限/)
  })

  test('disk runtime rebuild warns about preserved data and only schedules the launcher rebuild', async ({ page }) => {
    await mockMinimalModelStatus(page)

    let rebuildRequests = 0
    let cachePayload = diskUsagePayload()

    await page.route('**/api/disk/cache-status', async (route) => {
      await route.fulfill({ json: cachePayload })
    })
    await page.route('**/api/disk/runtime/rebuild-core', async (route) => {
      rebuildRequests += 1
      cachePayload = diskUsagePayload({
        runtime_environment: {
          venv_path: '/tmp/sd-image-sorter/backend/venv',
          venv_exists: true,
          venv_size_bytes: null,
          venv_size_complete: false,
          rebuild_core_pending: true,
          rebuild_marker_path: '/tmp/sd-image-sorter/data/state/rebuild-core-venv.json',
        },
      })
      await route.fulfill({
        json: {
          scheduled: true,
          restart_required: true,
          runtime_environment: cachePayload.runtime_environment,
        },
      })
    })

    await openModelManager(page)

    await page.locator('#btn-rebuild-core-runtime').click()
    await expect(page.locator('#confirm-modal.visible')).toBeVisible()
    await expect(page.locator('#confirm-title')).toContainText(/Rebuild lightweight runtime|重建轻量运行环境/i)
    await expect(page.locator('#confirm-message')).toContainText(/app-owned Python runtime/)
    await expect(page.locator('#confirm-message')).toContainText(/images\.db/)
    await expect(page.locator('#confirm-message')).toContainText(/settings|设置/i)
    await expect(page.locator('#confirm-message')).toContainText(/caches|缓存/i)
    await expect(page.locator('#confirm-message')).toContainText(/downloaded models|已下载模型/i)
    await expect(page.locator('#confirm-message')).toContainText(/Heavy AI Python packages|重型 AI Python 包/i)
    await expect(page.locator('#confirm-message')).toContainText(/large \/ not fully scanned|未完整扫描/i)

    await page.locator('#btn-confirm-ok').click()

    await expect.poll(() => rebuildRequests).toBe(1)
    await expect(page.locator('#btn-rebuild-core-runtime')).toBeDisabled()
    await expect(page.locator('#btn-rebuild-core-runtime')).toContainText(/Rebuild scheduled|已安排重建/)
    await expect(page.locator('.toast-message').last()).toContainText(/start it again|重新启动/)
  })

  test('disk cleanup asks again before deleting a cache whose size was not fully scanned', async ({ page }) => {
    await mockMinimalModelStatus(page)

    let cleanupRequests = 0

    await page.route('**/api/disk/cache-status', async (route) => {
      await route.fulfill({ json: diskUsagePayload() })
    })
    await page.route('**/api/disk/cleanup', async (route) => {
      cleanupRequests += 1
      expect(route.request().postDataJSON()).toEqual({ keys: ['thumbnails'] })
      await route.fulfill({ json: { cleaned: [{ key: 'thumbnails', freed_bytes: 0 }], errors: [] } })
    })

    await openModelManager(page)

    await page.locator('.disk-cache-checkbox').evaluateAll((checkboxes) => {
      for (const checkbox of checkboxes) (checkbox as HTMLInputElement).checked = false
    })
    await page.locator('.disk-cache-checkbox[data-key="thumbnails"]').check()
    await page.locator('#btn-clean-caches').click()

    await expect(page.locator('#confirm-modal.visible')).toBeVisible()
    await expect(page.locator('#confirm-title')).toContainText(/unknown size|大小未知/i)
    await expect(page.locator('#confirm-message')).toContainText(/images\.db/)
    await expect(page.locator('#confirm-message')).toContainText(/models|模型/i)
    await expect.poll(() => cleanupRequests).toBe(0)

    await page.locator('#btn-confirm-ok').click()

    await expect.poll(() => cleanupRequests).toBe(1)
  })


  test('prepare system-python install guard shows actionable setup guidance', async ({ page }) => {
    await mockMinimalModelStatus(page)

    let progressCalls = 0
    await page.route('**/api/disk/cache-status', async (route) => {
      await route.fulfill({ json: diskUsagePayload() })
    })
    await page.route('**/api/models/prepare', async (route) => {
      await route.fulfill({ json: { status: 'downloading', model_id: 'wd14', message: 'Download started in background.' } })
    })
    await page.route('**/api/models/download-progress', async (route) => {
      progressCalls += 1
      await route.fulfill({
        json: {
          active: false,
          downloaded: 0,
          total: 0,
          filename: '',
          prepare_result: {
            active: false,
            model_id: 'wd14',
            status: 'error',
            message: 'Refusing to install optional AI Python packages into the system Python environment. Start SD Image Sorter with run.bat, run-portable.bat, or run.sh so the app-owned Python runtime is used. Packages not installed: torch>=2.0.0',
            error_type: 'UnsafeSystemPythonInstall',
            provider: 'Python runtime',
            target_dir: '/tmp/sd-image-sorter/models/wd14',
            external_url: 'https://example.com/manual-setup',
            manual_steps: [
              'Close this SD Image Sorter window.',
              'Start the app with run.bat, run-portable.bat, or run.sh so it uses the app-owned Python runtime.',
              'Open Feature Setup again and click Prepare for this feature.',
            ],
          },
        },
      })
    })

    await openModelManager(page)
    await page.locator('.model-card[data-model-id="wd14"] .btn-prepare-model').click()

    await expect.poll(() => progressCalls).toBeGreaterThan(0)
    await expect(page.locator('#model-setup-guide-backdrop')).toBeVisible()
    await expect(page.locator('#model-setup-guide-title')).toContainText(/Manual setup required|需要手动设置/)
    await expect(page.locator('#model-setup-guide-backdrop')).toContainText(/system Python environment/)
    await expect(page.locator('#model-setup-guide-backdrop')).toContainText(/run-portable\.bat/)
    await expect(page.locator('#model-setup-guide-backdrop')).toContainText(/app-owned Python runtime/)

    await expect(page.locator('#model-setup-guide-open')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.locator('#model-setup-guide-close')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.locator('#model-setup-guide-close-x')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator('#model-setup-guide-close')).toBeFocused()
  })

  // See docs/TECHNICAL_DEBT_NOTES.md → Debt-19. The Playwright fixture creates a
  // single 32 MB stub `sam3-model.safetensors` file, but after the SAM3 backend
  // switch to `transformers.Sam3Model.from_pretrained(directory)`, the runtime
  // requires a directory containing `config.json` + `model.safetensors` + tokenizer
  // files. The prepare flow downloads the stub but `get_sam3_checkpoint_path()`
  // never returns a path because the directory is incomplete. Real ModelScope
  // downloads deliver a complete bundle, so production is unaffected. Re-enable
  // when the fixture is updated to produce a full stub bundle.
  test.fixme('SAM3 prepare shows byte progress and refreshes the card after completion', async ({ page, request }) => {
    await openModelManager(page)

    const card = page.locator('.model-card[data-model-id="sam3"]')
    await expect(card.locator('.model-card-status')).toContainText(/Missing|缺失/)

    const prepareButton = card.locator('.btn-prepare-model')
    await prepareButton.click()
    await expect(prepareButton).toContainText(/model\.safetensors.*MB/i, { timeout: 10_000 })

    await expect(card.locator('.model-card-path code')).toContainText(/model\.safetensors/, { timeout: 30_000 })

    const response = await request.get('/api/models/status')
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body.health.censor.sam3.checkpoint_path).toContain('model.safetensors')
  })

  // Cascading EBUSY follow-on from the SAM3 prepare test above (see Debt-19):
  // when that test errors out it leaves a `.tmp` file locked on Windows, which
  // makes this test's pre-cleanup `rm -rf data/models/sam3/...` fail. Re-enable
  // together with the SAM3 prepare test once the fixture is fixed.
  test.fixme('no model card shows Downloaded badge - only Ready or Missing', async ({ page }) => {
    await openModelManager(page)

    const statusBadges = page.locator('.model-card-status')
    const count = await statusBadges.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      const text = await statusBadges.nth(i).textContent()
      expect(text?.trim()).toMatch(/^(Ready|Missing|已就绪|缺失)$/)
    }

    await expect(page.locator('.model-card-status.is-downloaded')).toHaveCount(0)
    await expect(page.getByText(/^Downloaded$/)).toHaveCount(0)
  })
})
