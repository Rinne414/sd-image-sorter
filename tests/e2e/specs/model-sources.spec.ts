import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page, type Route } from '../fixtures/click-ledger'
import { resizeAndSettleUiScale } from '../fixtures/ui-scale'

/**
 * MS1c: the Model Center's "Model sources" card, the source line on model
 * cards, and the one-time "found ComfyUI" question. The backend answers are
 * mocked: the real ones depend on what is installed on the machine.
 *
 * Put a folder path into <PW_E2E_DATA_ROOT>/ms1c-shots-dir.txt to also write
 * screenshots (1366x768, 1920x1080, 2560x1440; zh-CN and en) of every state there.
 */

const COMFY = 'I:\\ComfyUI-aki-v1.6\\ComfyUI'
const HUB = 'C:\\Users\\me\\.cache\\huggingface\\hub'
const NAS = '\\\\NAS\\models'
const EMPTY = 'D:\\old-models'
const MODEL_FILE =
  'I:\\ComfyUI-aki-v1.6\\ComfyUI\\custom_nodes\\comfyui-WD14-Tagger\\models\\wd-eva02-large-tagger-v3.onnx'
const GB = 1024 ** 3
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const

interface Folder { path: string, kind: 'local' | 'network', exists: boolean | null }
interface SourceRow {
  path: string
  kind: string
  origin: string
  is_network: boolean
  version: string | null
  trusted: boolean
  network_pending: boolean
  network_scanned_at: number | null
  model_count: number
  network_not_trusted?: boolean
}
interface Suggestion {
  root: string
  kind: string
  origin: string
  version: string | null
  models: Array<{ model_id: string, variant: string | null, verify: string, size_bytes: number }>
  reusable_bytes: number
}

interface Server {
  folders: Folder[]
  sources: SourceRow[]
  suggestions: Suggestion[]
  matches: number
  reusableBytes: number
  scanStatus: 'running' | 'done'
  needsConfirm: string | null
  posts: Array<Record<string, unknown>>
  deletes: Array<Record<string, unknown>>
  rescans: number
  cards: Array<Record<string, unknown>>
}

function source(path: string, patch: Partial<SourceRow> = {}): SourceRow {
  return {
    path,
    kind: 'comfyui',
    origin: 'trusted',
    is_network: false,
    version: null,
    trusted: true,
    network_pending: false,
    network_scanned_at: null,
    model_count: 0,
    ...patch,
  }
}

function suggestion(root: string, kind: string, models: number, bytes: number): Suggestion {
  return {
    root,
    kind,
    origin: 'probe',
    version: null,
    models: Array.from({ length: models }, (_, index) => ({
      model_id: 'wd14', variant: `variant-${index}`, verify: 'size', size_bytes: bytes / models,
    })),
    reusable_bytes: bytes,
  }
}

const WD14_VARIANT_SOURCE = {
  kind: 'comfyui', root: COMFY, path: MODEL_FILE, verify: 'size', is_network: false, size_bytes: 1260435999,
}

function cards(): Array<Record<string, unknown>> {
  return [
    {
      id: 'wd14', name: 'WD14 Tagger', group: 'Tagging', group_key: 'models.group.tagging', recommended: true,
      status: 'ready', status_label: 'Ready', available: true, message: '3 WD14 variant(s) are ready.',
      message_key: 'models.wd14.readyCount', message_params: { count: 3 }, path: MODEL_FILE,
      download_supported: true, variants: ['wd-eva02-large-tagger-v3'], default_variant: 'wd-eva02-large-tagger-v3',
      installed_variants: ['wd-eva02-large-tagger-v3'], source: WD14_VARIANT_SOURCE,
      variant_sources: { 'wd-eva02-large-tagger-v3': WD14_VARIANT_SOURCE },
    },
    {
      id: 'artist', name: 'Artist ID / Kaloscope', group: 'Artist ID', group_key: 'models.group.artist', recommended: true,
      status: 'ready', status_label: 'Ready', available: true, message: 'Kaloscope runtime is ready.',
      message_key: 'models.artist.ready', path: `${COMFY}\\models\\lsnet\\Kaloscope\\best_checkpoint.pth`,
      download_supported: true,
      source: {
        kind: 'comfyui', root: COMFY, path: `${COMFY}\\models\\lsnet\\Kaloscope\\best_checkpoint.pth`,
        verify: 'sha', is_network: false, size_bytes: 2937892740,
      },
    },
    {
      id: 'florence2', name: 'Florence-2 Base', group: 'Captioning', group_key: 'models.group.captioning', recommended: true,
      status: 'ready', status_label: 'Ready', available: true, message: 'Florence-2 ready.',
      message_key: 'models.florence2.ready', message_params: { deps: '' },
      path: `${HUB}\\models--florence-community--Florence-2-base\\snapshots\\00921df66db728a9ceb750f5eca43e5c203a2051`,
      download_supported: true,
      source: {
        kind: 'hf_cache', root: HUB,
        path: `${HUB}\\models--florence-community--Florence-2-base\\snapshots\\00921df66db728a9ceb750f5eca43e5c203a2051`,
        verify: 'revision', is_network: false, size_bytes: 463000000,
      },
    },
    {
      id: 'aesthetic-waifu', name: 'Waifu Scorer V3 (anime aesthetic)', group: 'Scoring', group_key: 'models.group.scoring',
      status: 'ready', status_label: 'Ready', available: true, message: 'Waifu Scorer V3 is installed.',
      message_key: 'models.aestheticWaifu.ready', path: `${NAS}\\waifu_scorer_v3.safetensors`,
      download_supported: true,
      source: {
        kind: 'folder', root: NAS, path: `${NAS}\\waifu_scorer_v3.safetensors`, verify: 'sha', is_network: true,
        size_bytes: 11000000,
      },
    },
    {
      id: 'lucida', name: 'Lucida (subject matting)', group: 'Training', group_key: 'models.group.training',
      status: 'missing', status_label: 'Missing',
      available: false,
      message: `Missing: the file in ComfyUI is gone: ${COMFY}\\models\\lucida\\birefnet.py`,
      message_key: 'models.external.gone',
      message_params: { source: 'ComfyUI', kind: 'comfyui', path: `${COMFY}\\models\\lucida\\birefnet.py` },
      path: 'L:\\app\\data\\models\\lucida', download_supported: true,
    },
    {
      id: 'tipo', name: 'TIPO prompt expansion', group: 'Prompt', group_key: 'models.group.prompt',
      status: 'missing', status_label: 'Missing', available: false, message: 'TIPO weights are not downloaded yet.',
      message_key: 'models.tipo.missing', path: 'L:\\app\\data\\models\\tipo', download_supported: true,
    },
  ]
}

function newServer(): Server {
  return {
    folders: [
      { path: COMFY, kind: 'local', exists: true },
      { path: HUB, kind: 'local', exists: true },
      { path: EMPTY, kind: 'local', exists: true },
    ],
    sources: [
      source(COMFY, { version: '0.36.0', model_count: 5 }),
      source(HUB, { kind: 'hf_cache', origin: 'trusted', model_count: 3 }),
      source(EMPTY, { kind: 'folder', model_count: 0 }),
    ],
    suggestions: [],
    matches: 8,
    reusableBytes: 6.8 * GB,
    scanStatus: 'done',
    needsConfirm: null,
    posts: [],
    deletes: [],
    rescans: 0,
    cards: cards(),
  }
}

function detectPayload(server: Server) {
  return {
    sources: server.sources,
    matches: Array.from({ length: server.matches }, (_, index) => ({ model_id: 'wd14', variant: `v${index}` })),
    suggestions: server.suggestions,
    suggested_reusable_bytes: server.suggestions.reduce((sum, row) => sum + row.reusable_bytes, 0),
    rejected: [],
    reusable_bytes: server.reusableBytes,
    scan: { status: server.scanStatus, scanned_at: null, error: null, completed_generation: 1, roots: [] },
  }
}

function foldersPayload(server: Server) {
  return { folders: server.folders, program_folders: ['L:\\app\\models', 'L:\\app\\data\\models'] }
}

async function mockBackend(page: Page, server: Server) {
  await page.route('**/api/models/status', (route: Route) =>
    route.fulfill({ json: { status: 'ok', models: server.cards, health: {} } }))
  await page.route('**/api/models/mirror', (route: Route) =>
    route.fulfill({ json: { mirror: 'auto', options: ['auto', 'hf-mirror', 'modelscope'] } }))
  await page.route(/\/api\/models\/sources\/detect/, (route: Route) => {
    if (route.request().url().includes('rescan=1')) server.rescans += 1
    return route.fulfill({ json: detectPayload(server) })
  })
  await page.route('**/api/models/trusted-folders', async (route: Route) => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({ json: foldersPayload(server) })
    const body = request.postDataJSON() as { path: string, confirm?: boolean }
    if (request.method() === 'DELETE') {
      server.deletes.push(body)
      server.folders = server.folders.filter((folder) => folder.path !== body.path)
      server.sources = server.sources.filter((row) => row.path !== body.path)
      return route.fulfill({ json: foldersPayload(server) })
    }
    server.posts.push(body)
    if (server.needsConfirm && !body.confirm) {
      return route.fulfill({
        status: 400,
        json: {
          error: 'This folder is very broad', type: 'ConfirmationRequired',
          needs_confirm: true, reason: server.needsConfirm,
        },
      })
    }
    const isNetwork = body.path.startsWith('\\\\')
    server.folders.push({ path: body.path, kind: isNetwork ? 'network' : 'local', exists: isNetwork ? null : true })
    const found = server.suggestions.find((row) => row.root === body.path)
    server.sources = server.sources.filter((row) => row.path !== body.path && !row.network_not_trusted)
    server.sources.push(source(body.path, {
      kind: found?.kind ?? 'folder', model_count: found?.models.length ?? 0, is_network: isNetwork,
      network_pending: isNetwork,
    }))
    server.suggestions = server.suggestions.filter((row) => row.root !== body.path)
    return route.fulfill({ json: foldersPayload(server) })
  })
}

function watchConsole(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (/status of 4\d\d/.test(message.text())) return // the mocked 400 of the needs_confirm flow
    problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  return problems
}

async function openCenter(page: Page, lang: 'zh-CN' | 'en' = 'zh-CN') {
  await page.addInitScript((value) => localStorage.setItem('sd-image-sorter-lang', value), lang)
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).EntryPage?.hide?.())
  await page.locator('#btn-open-model-manager').click()
  await page.locator('[data-settings-tab="models"]').click()
  await expect(page.locator('.model-card[data-model-id="wd14"]')).toBeVisible()
}

const sourcesCard = (page: Page) => page.locator('[data-testid="model-sources-card"]')

async function assertCleanLayout(page: Page) {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector('#model-manager-modal .modal-content') as HTMLElement
    const card = document.querySelector('[data-testid="model-sources-card"]') as HTMLElement | null
    const rows = Array.from(document.querySelectorAll('.model-sources-row')) as HTMLElement[]
    const cardBox = card?.getBoundingClientRect()
    return {
      pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      modalX: content.scrollWidth - content.clientWidth,
      cardX: card ? card.scrollWidth - card.clientWidth : 0,
      rowOutside: rows.some((row) => {
        const box = row.getBoundingClientRect()
        return !cardBox || box.left < cardBox.left - 1 || box.right > cardBox.right + 1
      }),
      primaries: card ? card.querySelectorAll('.btn-primary').length : -1,
    }
  })
  expect(overflow.pageX).toBeLessThanOrEqual(0)
  expect(overflow.modalX).toBeLessThanOrEqual(0)
  expect(overflow.cardX).toBeLessThanOrEqual(0)
  expect(overflow.rowOutside).toBe(false)
  expect(overflow.primaries).toBe(0)
}

test.describe('model sources card', () => {
  test('lists the trusted folders with their type and model count, including empty ones', async ({ page }) => {
    const problems = watchConsole(page)
    await mockBackend(page, newServer())
    await openCenter(page)

    const card = sourcesCard(page)
    await expect(card.locator('.model-card-title')).toHaveText('模型来源')
    await expect(card.locator('[data-testid="model-sources-summary"]')).toContainText('正在使用这些文件夹里的 8 个现成模型，省下约 6.80 GB')
    const rows = card.locator('.model-sources-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText(COMFY)
    await expect(rows.nth(0)).toContainText('ComfyUI 0.36.0 · 5 个模型')
    await expect(rows.nth(1)).toContainText('Hugging Face 缓存 · 3 个模型')
    await expect(rows.nth(2)).toContainText('文件夹 · 0 个模型')
    await expect(card.getByRole('button', { name: '移除' })).toHaveCount(3)
    await expect(card.getByRole('button', { name: '重新扫描' })).toBeVisible()
    await expect(card.getByRole('button', { name: '+ 添加文件夹' })).toBeVisible()
    await assertCleanLayout(page)
    expect(problems).toEqual([])
  })

  test('says in English too, and an empty list explains what adding does', async ({ page }) => {
    const server = newServer()
    server.folders = []
    server.sources = []
    server.matches = 0
    server.reusableBytes = 0
    await mockBackend(page, server)
    await openCenter(page, 'en')

    const card = sourcesCard(page)
    await expect(card.locator('.model-card-title')).toHaveText('Model sources')
    await expect(card.locator('[data-testid="model-sources-summary"]')).toContainText('only reads those files')
    await expect(card.locator('.model-sources-list')).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Rescan' })).toBeVisible()
    await expect(card.getByRole('button', { name: '+ Add folder' })).toBeVisible()
  })

  test('removing a folder asks the backend and refreshes the card and the model cards', async ({ page }) => {
    const server = newServer()
    await mockBackend(page, server)
    await openCenter(page)

    await sourcesCard(page).locator('.model-sources-row', { hasText: EMPTY }).getByRole('button', { name: '移除' }).click()

    await expect(sourcesCard(page).locator('.model-sources-row')).toHaveCount(2)
    expect(server.deletes).toEqual([{ path: EMPTY }])
  })

  test('the add button flips its label and adds a typed folder', async ({ page }) => {
    const server = newServer()
    await mockBackend(page, server)
    await openCenter(page)
    const card = sourcesCard(page)

    await card.getByRole('button', { name: '+ 添加文件夹' }).click()
    await expect(card.getByRole('button', { name: '取消添加' })).toBeVisible()
    await card.locator('#model-source-path-input').fill('"E:\\models"')
    await card.getByRole('button', { name: '添加', exact: true }).click()

    await expect(card.locator('.model-sources-row')).toHaveCount(4)
    expect(server.posts).toEqual([{ path: 'E:\\models', confirm: false }])
    await expect(card.getByRole('button', { name: '+ 添加文件夹' })).toBeVisible()
  })

  test('a very broad folder shows why and is added only after the user confirms', async ({ page }) => {
    const server = newServer()
    server.needsConfirm = 'drive_root'
    const problems = watchConsole(page)
    await mockBackend(page, server)
    await openCenter(page)
    const card = sourcesCard(page)

    await card.getByRole('button', { name: '+ 添加文件夹' }).click()
    await card.locator('#model-source-path-input').fill('E:\\')
    await card.getByRole('button', { name: '添加', exact: true }).click()

    const dialog = page.locator('#confirm-modal')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('#confirm-title')).toHaveText('要信任整个文件夹吗？')
    await expect(dialog.locator('#confirm-message')).toContainText('整个磁盘')
    await expect(dialog.locator('#btn-confirm-ok')).toHaveText('仍然信任')
    await dialog.locator('#btn-confirm-ok').click()

    await expect(card.locator('.model-sources-row')).toHaveCount(4)
    expect(server.posts).toEqual([
      { path: 'E:\\', confirm: false },
      { path: 'E:\\', confirm: true },
    ])
    expect(problems).toEqual([])
  })

  test('declining the broad-folder question adds nothing', async ({ page }) => {
    const server = newServer()
    server.needsConfirm = 'home'
    await mockBackend(page, server)
    await openCenter(page)
    const card = sourcesCard(page)

    await card.getByRole('button', { name: '+ 添加文件夹' }).click()
    await card.locator('#model-source-path-input').fill('C:\\Users\\me')
    await card.getByRole('button', { name: '添加', exact: true }).click()
    await page.locator('#confirm-modal #btn-confirm-cancel').click()

    await expect(card.locator('.model-sources-row')).toHaveCount(3)
    expect(server.posts).toHaveLength(1)
  })

  test('a network source says it is slow and shows its pending state; an untrusted COMFYUI_PATH NAS can be added', async ({ page }) => {
    const server = newServer()
    server.folders.push({ path: NAS, kind: 'network', exists: null })
    server.sources.push(source(NAS, { kind: 'folder', is_network: true, network_pending: true }))
    server.sources.push(source('\\\\NAS2\\ComfyUI', {
      origin: 'env', is_network: true, trusted: false, network_not_trusted: true,
    }))
    await mockBackend(page, server)
    await openCenter(page)
    const card = sourcesCard(page)

    const nas = card.locator('.model-sources-row', { hasText: NAS }).first()
    await expect(nas).toContainText('正在检查网络磁盘…')
    await expect(nas).toContainText('网络磁盘，加载较慢')
    const hint = card.locator('.model-sources-row.is-hint')
    await expect(hint).toContainText('\\\\NAS2\\ComfyUI')
    await expect(hint).toContainText('加入前不会读取')
    await hint.getByRole('button', { name: '加入这个 NAS' }).click()

    await expect.poll(() => server.posts).toEqual([{ path: '\\\\NAS2\\ComfyUI', confirm: false }])
    await expect(card.locator('.model-sources-row.is-hint')).toHaveCount(0)
    await assertCleanLayout(page)
  })

  test('the drive scan in progress is shown and the card refreshes when it finishes', async ({ page }) => {
    const server = newServer()
    server.scanStatus = 'running'
    await mockBackend(page, server)
    await openCenter(page)
    const card = sourcesCard(page)

    await expect(card.locator('[data-testid="model-sources-summary"]')).toHaveText('正在磁盘上查找 ComfyUI…')
    await expect(card.getByRole('button', { name: '扫描中…' })).toBeDisabled()
    server.scanStatus = 'done'
    await expect(card.locator('[data-testid="model-sources-summary"]')).toContainText('现成模型', { timeout: 10_000 })
    await expect(card.getByRole('button', { name: '重新扫描' })).toBeEnabled()
  })
})

test.describe('model cards served from a trusted folder', () => {
  test('a ready card names the folder and verification; the full path is in the location fold', async ({ page }) => {
    await mockBackend(page, newServer())
    await openCenter(page)

    const artist = page.locator('.model-card[data-model-id="artist"]')
    await expect(artist.locator('.model-card-source')).toContainText('来源：ComfyUI · I:\\…\\best_checkpoint.pth（校验一致）')
    await artist.locator('.model-card-location summary').click()
    await expect(artist.locator('.model-card-location')).toContainText(`${COMFY}\\models\\lsnet\\Kaloscope\\best_checkpoint.pth`)

    const florence = page.locator('.model-card[data-model-id="florence2"]')
    await expect(florence.locator('.model-card-source')).toContainText('来源：Hugging Face 缓存')
    await expect(florence.locator('.model-card-source')).toContainText('florence-community/Florence-2-base @ 00921df6')
    await expect(florence.locator('.model-card-source')).toContainText('版本一致')

    const nas = page.locator('.model-card[data-model-id="aesthetic-waifu"]')
    await expect(nas.locator('.model-card-source')).toContainText('网络磁盘')

    await expect(page.locator('.model-card[data-model-id="tipo"] .model-card-source')).toHaveCount(0)
  })

  test('a variant list replaces the path when several variants come from the folder', async ({ page }) => {
    const server = newServer()
    const wd14 = server.cards[0] as any
    wd14.variant_sources = { 'wd-eva02-large-tagger-v3': WD14_VARIANT_SOURCE, 'wd-convnext-tagger-v3': WD14_VARIANT_SOURCE }
    await mockBackend(page, server)
    await openCenter(page)

    await expect(page.locator('.model-card[data-model-id="wd14"] .model-card-source'))
      .toContainText('来源：ComfyUI · wd-eva02-large-tagger-v3, wd-convnext-tagger-v3')
  })

  test('a file that went missing names its path and offers the download into the program folder', async ({ page }) => {
    await mockBackend(page, newServer())
    await openCenter(page)

    const lucida = page.locator('.model-card[data-model-id="lucida"]')
    await expect(lucida.locator('.model-card-message')).toHaveText(`缺失：ComfyUI 里的文件已不见：${COMFY}\\models\\lucida\\birefnet.py`)
    await expect(lucida.locator('.btn-prepare-model')).toHaveText('下载到程序文件夹')
    await expect(page.locator('.model-card[data-model-id="tipo"] .btn-prepare-model')).toHaveText('立即准备')
  })

  test('says the same in English', async ({ page }) => {
    await mockBackend(page, newServer())
    await openCenter(page, 'en')

    await expect(page.locator('.model-card[data-model-id="artist"] .model-card-source'))
      .toContainText('Source: ComfyUI · I:\\…\\best_checkpoint.pth (checksum matches)')
    await expect(page.locator('.model-card[data-model-id="lucida"] .model-card-message'))
      .toHaveText(`Missing: the file in ComfyUI is gone: ${COMFY}\\models\\lucida\\birefnet.py`)
    await expect(page.locator('.model-card[data-model-id="lucida"] .btn-prepare-model')).toHaveText('Download to the program folder')
  })
})

test.describe('the one-time question', () => {
  function withComfyFound(): Server {
    const server = newServer()
    server.folders = []
    server.sources = []
    server.matches = 0
    server.reusableBytes = 0
    server.suggestions = [suggestion(COMFY, 'comfyui', 5, 5.9 * GB)]
    return server
  }

  test('offers the ComfyUI it found; "Later" is remembered, a rescan asks again, "Add and use" adds it', async ({ page }) => {
    const server = withComfyFound()
    await mockBackend(page, server)
    await openCenter(page)

    const dialog = page.locator('#confirm-modal')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('#confirm-title')).toHaveText('找到 ComfyUI')
    await expect(dialog.locator('#confirm-message')).toContainText(`${COMFY} 里有 5 个本程序要用的模型（约 5.90 GB）。`)
    await expect(dialog.locator('#confirm-message')).toContainText('加入信任文件夹后直接使用，不再重复下载。')
    await expect(dialog.locator('#confirm-message')).toContainText('程序只读取这些文件，不会修改 ComfyUI。')
    await expect(dialog.locator('#btn-confirm-cancel')).toHaveText('以后再说')
    await expect(dialog.locator('#btn-confirm-ok')).toHaveText('加入并使用')
    await dialog.locator('#btn-confirm-cancel').click()
    await expect(dialog).toBeHidden()
    expect(server.posts).toEqual([])

    // Remembered: closing and opening the Model Center again does not ask.
    await page.locator('#model-manager-close').click()
    await page.locator('#btn-open-model-manager').click()
    await page.locator('[data-settings-tab="models"]').click()
    await expect(sourcesCard(page)).toBeVisible()
    await page.waitForTimeout(600)
    await expect(dialog).toBeHidden()

    // Rescan asks again.
    await sourcesCard(page).getByRole('button', { name: '重新扫描' }).click()
    await expect(dialog).toBeVisible()
    expect(server.rescans).toBe(1)
    await dialog.locator('#btn-confirm-ok').click()

    await expect.poll(() => server.posts).toEqual([{ path: COMFY, confirm: false }])
    await expect(sourcesCard(page).locator('.model-sources-row')).toHaveCount(1)
    await expect(dialog).toBeHidden()
  })

  test('lists every folder it found and adds all of them', async ({ page }) => {
    const server = withComfyFound()
    server.suggestions.push(suggestion(HUB, 'hf_cache', 3, 1.2 * GB))
    await mockBackend(page, server)
    await openCenter(page)

    const dialog = page.locator('#confirm-modal')
    await expect(dialog.locator('#confirm-message')).toContainText('这些文件夹里共有 8 个本程序要用的模型（约 7.10 GB）：')
    await expect(dialog.locator('#confirm-message')).toContainText(`• ${HUB} — 3 个模型`)
    await dialog.locator('#btn-confirm-ok').click()

    await expect.poll(() => server.posts.map((post) => post.path)).toEqual([COMFY, HUB])
  })

  test('a broad folder inside the question still waits for its own confirmation', async ({ page }) => {
    const server = withComfyFound()
    server.needsConfirm = 'system'
    await mockBackend(page, server)
    await openCenter(page)

    await page.locator('#confirm-modal #btn-confirm-ok').click()
    await expect(page.locator('#confirm-title')).toHaveText('要信任整个文件夹吗？')
    await expect(page.locator('#confirm-message')).toContainText('系统文件夹')
    await page.locator('#confirm-modal #btn-confirm-ok').click()

    await expect.poll(() => server.posts).toEqual([
      { path: COMFY, confirm: false },
      { path: COMFY, confirm: true },
    ])
  })

  test('does not ask on the settings tab; asks once the Model Center tab opens', async ({ page }) => {
    const server = withComfyFound()
    await mockBackend(page, server)
    await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
    await page.goto('/')
    await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
    await page.evaluate(() => (window as any).EntryPage?.hide?.())
    await page.locator('#btn-open-model-manager').click()
    await page.waitForTimeout(800)
    await expect(page.locator('#confirm-modal')).toBeHidden()

    await page.locator('[data-settings-tab="models"]').click()
    await expect(page.locator('#confirm-modal')).toBeVisible()
  })

  test('asks in English with the English labels', async ({ page }) => {
    await mockBackend(page, withComfyFound())
    await openCenter(page, 'en')

    const dialog = page.locator('#confirm-modal')
    await expect(dialog.locator('#confirm-title')).toHaveText('Found ComfyUI')
    await expect(dialog.locator('#btn-confirm-cancel')).toHaveText('Later')
    await expect(dialog.locator('#btn-confirm-ok')).toHaveText('Add and use')
    await expect(dialog.locator('#confirm-message')).toContainText('never changes ComfyUI')
  })

  test('the buttons of the shared confirm dialog are restored afterwards', async ({ page }) => {
    await mockBackend(page, withComfyFound())
    await openCenter(page)
    await page.locator('#confirm-modal #btn-confirm-cancel').click()

    await expect(page.locator('#btn-confirm-ok')).toHaveText('确认执行')
    await expect(page.locator('#btn-confirm-cancel')).toHaveText('取消')
  })
})

test.describe('desktop layouts', () => {
  for (const viewport of VIEWPORTS) {
    test(`no overflow, overlap or console errors at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      const problems = watchConsole(page)
      const server = newServer()
      server.folders.push({ path: NAS, kind: 'network', exists: null })
      server.sources.push(source(NAS, { kind: 'folder', is_network: true, network_pending: true }))
      server.sources.push(source('\\\\NAS2\\ComfyUI', {
        origin: 'env', is_network: true, trusted: false, network_not_trusted: true,
      }))
      await mockBackend(page, server)
      await page.setViewportSize(viewport)
      await openCenter(page)
      await resizeAndSettleUiScale(page, viewport)
      await sourcesCard(page).getByRole('button', { name: '+ 添加文件夹' }).click()

      await assertCleanLayout(page)
      expect(problems).toEqual([])
    })
  }
})

// The runner passes only an allow-list of variables to the tests, so the target
// folder is read from a file inside the run's data root.
function shotsDir(): string | undefined {
  const root = process.env.PW_E2E_DATA_ROOT
  if (!root) return undefined
  try {
    return fs.readFileSync(path.join(root, 'ms1c-shots-dir.txt'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}
const SHOTS_DIR = shotsDir()
test.describe('screenshots', () => {
  test.skip(!SHOTS_DIR, 'no ms1c-shots-dir.txt in the data root')

  for (const lang of ['zh-CN', 'en'] as const) {
    test(`every state at the desktop widths (${lang})`, async ({ page }) => {
      test.setTimeout(240_000)
      const dir = SHOTS_DIR as string
      fs.mkdirSync(dir, { recursive: true })
      const shot = async (name: string, viewport: { width: number, height: number }) => {
        await page.waitForTimeout(250)
        await page.screenshot({ path: path.join(dir, `${name}-${lang}-${viewport.width}x${viewport.height}.png`) })
      }
      const server = newServer()
      server.folders.push({ path: NAS, kind: 'network', exists: null })
      server.sources.push(source(NAS, { kind: 'folder', is_network: true, network_pending: true }))
      server.sources.push(source('\\\\NAS2\\ComfyUI', {
        origin: 'env', is_network: true, trusted: false, network_not_trusted: true,
      }))
      await mockBackend(page, server)
      await page.setViewportSize(VIEWPORTS[0])
      await openCenter(page, lang)

      for (const viewport of VIEWPORTS) {
        await resizeAndSettleUiScale(page, viewport)
        const card = sourcesCard(page)
        await card.scrollIntoViewIfNeeded()
        await shot('1-sources-card', viewport)
        await page.locator('.model-card[data-model-id="artist"]').scrollIntoViewIfNeeded()
        await shot('2-model-card-source-line', viewport)
        await page.locator('.model-card[data-model-id="lucida"]').scrollIntoViewIfNeeded()
        await shot('3-model-card-gone', viewport)
      }
    })
  }

  for (const lang of ['zh-CN', 'en'] as const) {
    test(`the question and the broad-folder confirmation (${lang})`, async ({ page }) => {
      test.setTimeout(240_000)
      const dir = SHOTS_DIR as string
      fs.mkdirSync(dir, { recursive: true })
      const server = newServer()
      server.folders = []
      server.sources = []
      server.matches = 0
      server.reusableBytes = 0
      server.suggestions = [suggestion(COMFY, 'comfyui', 5, 5.9 * GB)]
      server.needsConfirm = 'drive_root'
      await mockBackend(page, server)
      await page.setViewportSize(VIEWPORTS[0])
      await openCenter(page, lang)

      for (const viewport of VIEWPORTS) {
        await resizeAndSettleUiScale(page, viewport)
        await expect(page.locator('#confirm-modal')).toBeVisible()
        await page.waitForTimeout(250)
        await page.screenshot({ path: path.join(dir, `4-ask-${lang}-${viewport.width}x${viewport.height}.png`) })
      }
      await page.locator('#confirm-modal #btn-confirm-ok').click()
      await expect(page.locator('#confirm-title')).toHaveText(lang === 'en' ? 'Trust this whole folder?' : '要信任整个文件夹吗？')
      for (const viewport of VIEWPORTS) {
        await resizeAndSettleUiScale(page, viewport)
        await page.waitForTimeout(250)
        await page.screenshot({ path: path.join(dir, `5-needs-confirm-${lang}-${viewport.width}x${viewport.height}.png`) })
      }
    })
  }
})
