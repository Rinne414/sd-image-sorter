import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

/**
 * Model Center: a person comes here to get models, so the cards come first.
 * Download source, model-source folders and the network proxy are one folded
 * section ("Download settings") whose one-line summary says their state. It
 * opens by itself when something needs attention, remembers open or closed,
 * and the Ctrl K entry for the network proxy opens it. Backend answers are
 * mocked: the real ones depend on what is installed on the machine.
 */

interface Backend {
  folders: Array<{ path: string, kind: 'local' | 'network', exists: boolean | null }>
  proxy: string
}

const CARDS = Array.from({ length: 8 }, (_, index) => ({
  id: `model-${index}`,
  name: `Model ${index}`,
  group: 'Tagging',
  recommended: index < 6,
  status: 'missing',
  available: false,
  message: 'Not downloaded yet.',
  download_supported: true,
  path: 'L:\\app\\data\\models\\x',
}))

async function mockBackend(page: Page, backend: Backend) {
  await page.route('**/api/models/status', (route: Route) => route.fulfill({ json: { status: 'ok', models: CARDS, health: {} } }))
  await page.route('**/api/models/mirror', (route: Route) =>
    route.fulfill({ json: { mirror: 'auto', options: ['auto', 'hf-mirror', 'modelscope'] } }))
  await page.route(/\/api\/models\/sources\/detect/, (route: Route) =>
    route.fulfill({
      json: {
        sources: backend.folders.map((folder) => ({
          path: folder.path, kind: 'folder', origin: 'trusted', is_network: false, version: null, trusted: true,
          network_pending: false, network_scanned_at: null, model_count: 2,
        })),
        matches: [], suggestions: [], suggested_reusable_bytes: 0, rejected: [], reusable_bytes: 0,
        scan: { status: 'done', scanned_at: null, error: null, completed_generation: 1, roots: [] },
      },
    }))
  await page.route('**/api/models/trusted-folders', (route: Route) =>
    route.fulfill({ json: { folders: backend.folders, program_folders: [] } }))
  await page.route('**/api/network/proxy', async (route: Route) => {
    if (route.request().method() === 'POST') {
      backend.proxy = (route.request().postDataJSON() as { proxy: string }).proxy
    }
    await route.fulfill({ json: { proxy: backend.proxy, system_proxy: '' } })
  })
}

function newBackend(patch: Partial<Backend> = {}): Backend {
  return {
    folders: [
      { path: 'D:\\models', kind: 'local', exists: true },
      { path: 'E:\\more-models', kind: 'local', exists: true },
    ],
    proxy: '',
    ...patch,
  }
}

async function openCenter(page: Page, lang: 'zh-CN' | 'en') {
  await page.addInitScript((value) => {
    localStorage.setItem('sd-image-sorter-lang', value)
    localStorage.setItem('aurora-entry-skip', '1')
  }, lang)
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.locator('#btn-open-model-manager').click()
  await page.locator('[data-settings-tab="models"]').click()
  await expect(page.locator('#model-manager-grid .model-card').first()).toBeVisible()
  await expect(page.locator('#model-network-state')).toContainText(/\S/)
}

const details = (page: Page) => page.locator('#model-network-settings')

for (const [lang, summary] of [
  ['zh-CN', '下载源：自动 · 模型来源：2 个文件夹 · 代理：未设置'],
  ['en', 'Download source: Auto · Model sources: 2 folders · Proxy: not set'],
] as const) {
  test(`the cards come first and the folded settings say their state in words (${lang})`, async ({ page }) => {
    await mockBackend(page, newBackend())
    await openCenter(page, lang)
    await expect(page.locator('#model-network-state')).toHaveText(summary)
    expect(await details(page).evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
    await expect(page.locator('#model-sources-section')).toBeHidden()

    for (const [width, height, limit] of [[1366, 768, 768 * 0.45], [1920, 1080, 1080 / 3], [2560, 1440, 1440 / 3]] as const) {
      await page.setViewportSize({ width, height })
      await expect.poll(async () => {
        const box = await page.locator('#model-manager-grid .model-card').first().boundingBox()
        return box ? box.y : 99999
      }, { message: `${width}x${height}` }).toBeLessThan(limit)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    }
  })
}

test('it remembers open or closed, and opening shows the download source, folders and proxy', async ({ page }) => {
  await mockBackend(page, newBackend())
  await openCenter(page, 'en')
  await details(page).locator('summary').click()
  await expect(page.locator('#model-mirror-select')).toBeVisible()
  await expect(page.locator('[data-testid="model-sources-card"]')).toBeVisible()
  await expect(page.locator('[data-testid="network-proxy-card"]')).toBeVisible()

  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.locator('#btn-open-model-manager').click()
  await page.locator('[data-settings-tab="models"]').click()
  await expect(page.locator('#model-network-state')).toContainText(/\S/)
  expect(await details(page).evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)

  await details(page).locator('summary').click()
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.locator('#btn-open-model-manager').click()
  await page.locator('[data-settings-tab="models"]').click()
  await expect(page.locator('#model-network-state')).toContainText(/\S/)
  expect(await details(page).evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
})

test('it opens by itself when a folder is gone, and says so; the person can still close it', async ({ page }) => {
  await mockBackend(page, newBackend({ folders: [{ path: 'D:\\gone', kind: 'local', exists: false }] }))
  await openCenter(page, 'en')
  await expect(page.locator('.model-network-flag')).toHaveText('Needs a look')
  expect(await details(page).evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)
  await expect(page.locator('[data-testid="model-sources-card"]')).toBeVisible()
  await details(page).locator('summary').click()
  await expect(page.locator('[data-testid="model-sources-card"]')).toBeHidden()
})

test('saving a proxy changes the summary line', async ({ page }) => {
  await mockBackend(page, newBackend())
  await openCenter(page, 'zh-CN')
  await details(page).locator('summary').click()
  await page.locator('#network-proxy-input').fill('127.0.0.1:7890')
  await page.locator('[data-testid="network-proxy-save"]').click()
  await expect(page.locator('#model-network-state')).toHaveText('下载源：自动 · 模型来源：2 个文件夹 · 代理：127.0.0.1:7890')
})

test('the Ctrl K entry for the network proxy opens the folded settings and shows the proxy', async ({ page }) => {
  await mockBackend(page, newBackend())
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('aurora-entry-skip', '1')
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).EntryCatalog.open())
  await page.locator('#entry-catalog-body .catalog-item', { hasText: 'Network proxy' }).click()
  await expect(page.locator('[data-testid="network-proxy-card"]')).toBeInViewport({ timeout: 10_000 })
  expect(await details(page).evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)
})
