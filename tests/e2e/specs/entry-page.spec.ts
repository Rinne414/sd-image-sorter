import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import type { Request, Response } from '@playwright/test'

import { expect, test } from '../fixtures/click-ledger'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const backendMain = path.join(repoRoot, 'backend', 'main.py')
const backendPythonCandidates = process.platform === 'win32'
  ? [
      path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
      path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
      'python',
    ]
  : [
      path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
      'python3',
      'python',
      path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
    ]

interface EntrySummary {
  library_total: number
  added_today: number
  unviewed: number
  streak_days: number
  today_touched: number
}

interface IsolatedBackend {
  baseURL: string
  dataRoot: string
  port: number
  process: ChildProcess
  spawnError: Error | null
  output: string[]
}

function commandExists(candidate: string): boolean {
  if (candidate.includes(path.sep) || candidate.includes('/')) {
    return fs.existsSync(candidate)
  }
  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    return execFileSync(lookupCommand, [candidate], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0
  } catch {
    return false
  }
}

const backendPython = process.env.PW_BACKEND_PYTHON
  || backendPythonCandidates.find((candidate) => commandExists(candidate))
  || backendPythonCandidates[0]

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function waitForProcessExit(child: ChildProcess, timeoutMilliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const onExit = () => {
      if (timeout !== null) clearTimeout(timeout)
      resolve(true)
    }
    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) {
      child.removeListener('exit', onExit)
      resolve(true)
      return
    }
    timeout = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, timeoutMilliseconds)
  })
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not reserve an isolated entry-page test port.')))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

async function waitForEntrySummary(
  backend: IsolatedBackend,
  timeoutMilliseconds: number,
): Promise<EntrySummary> {
  const deadline = Date.now() + timeoutMilliseconds
  let lastError = 'server did not accept a request'
  while (Date.now() < deadline) {
    if (backend.spawnError !== null) {
      throw new Error(
        `Isolated entry backend failed to spawn: ${backend.spawnError.message}. Output: ${backend.output.join('')}`,
      )
    }
    if (backend.process.exitCode !== null) {
      throw new Error(
        `Isolated entry backend exited with code ${backend.process.exitCode}. Output: ${backend.output.join('')}`,
      )
    }
    try {
      const response = await fetch(`${backend.baseURL}/api/entry/summary`)
      if (response.ok) return await response.json() as EntrySummary
      lastError = `HTTP ${response.status}: ${await response.text()}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await wait(100)
  }
  throw new Error(
    `Isolated entry backend did not become ready at ${backend.baseURL}: ${lastError}. Output: ${backend.output.join('')}`,
  )
}

async function startIsolatedBackend(): Promise<IsolatedBackend> {
  const port = await reserveLoopbackPort()
  const dataRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sd-image-sorter-entry-'))
  const output: string[] = []
  const child = spawn(backendPython, [backendMain, '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SD_IMAGE_SORTER_DATA_DIR: dataRoot,
      SD_IMAGE_SORTER_DB_PATH: path.join(dataRoot, 'images.db'),
      SD_IMAGE_SORTER_CONFIG_DIR: path.join(dataRoot, 'config'),
      SD_IMAGE_SORTER_STATE_DIR: path.join(dataRoot, 'state'),
      SD_IMAGE_SORTER_TMP_DIR: path.join(dataRoot, 'tmp'),
      SD_IMAGE_SORTER_UPDATE_DIR: path.join(dataRoot, 'update'),
      SD_IMAGE_SORTER_THUMBNAIL_DIR: path.join(dataRoot, 'thumbnails'),
      SD_IMAGE_SORTER_CACHE_DIR: path.join(dataRoot, 'cache'),
      SD_IMAGE_SORTER_DISABLE_ENV_FILES: '1',
      SD_IMAGE_SORTER_DISABLE_LEGACY_MODEL_COPY: '1',
      SD_IMAGE_SORTER_LOG_LEVEL: 'WARNING',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const backend: IsolatedBackend = {
    baseURL: `http://127.0.0.1:${port}`,
    dataRoot,
    port,
    process: child,
    spawnError: null,
    output,
  }
  child.once('error', (error) => {
    backend.spawnError = error
  })
  child.stdout.on('data', (chunk) => output.push(String(chunk)))
  child.stderr.on('data', (chunk) => output.push(String(chunk)))
  try {
    await waitForEntrySummary(backend, 30_000)
    return backend
  } catch (error) {
    const startError = error instanceof Error ? error : new Error(String(error))
    try {
      await stopIsolatedBackend(backend)
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      throw new Error(
        `Isolated entry backend startup failed: ${startError.message}; cleanup also failed: ${cleanupMessage}`,
      )
    }
    throw startError
  }
}

async function stopIsolatedBackend(backend: IsolatedBackend): Promise<void> {
  let terminationError: Error | null = null
  let cleanupError: Error | null = null
  try {
    if (
      backend.process.exitCode === null
      && backend.process.signalCode === null
      && !(backend.spawnError !== null && backend.process.pid === undefined)
    ) {
      backend.process.kill()
      const stopped = await waitForProcessExit(backend.process, 5_000)
      if (!stopped) {
        if (process.platform === 'win32' && backend.process.pid) {
          execFileSync('taskkill', ['/pid', String(backend.process.pid), '/T', '/F'], {
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } else {
          backend.process.kill('SIGKILL')
        }
        if (!await waitForProcessExit(backend.process, 5_000)) {
          throw new Error(`Isolated entry backend on port ${backend.port} did not terminate.`)
        }
      }
    }
  } catch (error) {
    terminationError = error instanceof Error ? error : new Error(String(error))
  } finally {
    try {
      await fsPromises.rm(backend.dataRoot, { recursive: true, force: true })
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error))
    }
  }
  if (terminationError !== null && cleanupError !== null) {
    throw new Error(
      `Isolated entry backend termination failed: ${terminationError.message}; cleanup also failed: ${cleanupError.message}`,
    )
  }
  if (terminationError !== null) throw terminationError
  if (cleanupError !== null) throw cleanupError
}

/**
 * v4.0 Aurora shell — mission entry page (canvas #11a, Phase 2).
 *
 * The suite-wide storageState sets aurora-entry-skip=1 so every other spec
 * lands straight in the gallery; the opt-in tests here remove that key via an
 * init script BEFORE the app boots on each navigation.
 *
 * Covered behaviors:
 * - entry shows at launch by default and every mosaic tile is present;
 * - tiles navigate into the real views (missions are shortcuts, never cages);
 * - top-level ESC returns to the entry overlay without losing view state;
 * - the 跳过入口页 setting suppresses the entry at the next launch;
 * - the suite-default skip flag keeps the entry hidden (regression guard for
 *   the other 150 specs' boot expectations).
 */

test.describe.configure({ mode: 'serial' })

test.describe('Entry page (opted in)', () => {
  test.beforeEach(async ({ page }) => {
    // One-shot opt-in: clear the suite-wide skip flag on the FIRST load only
    // (sessionStorage survives same-tab navigations), so tests that write
    // their own preference and reload see it respected.
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem('entry-spec-booted')) {
        window.sessionStorage.setItem('entry-spec-booted', '1')
        window.localStorage.removeItem('aurora-entry-skip')
      }
    })
    await page.goto('/')
    await expect(page.locator('#entry-page')).toBeVisible()
  })

  test('shows the mission mosaic at launch', async ({ page }) => {
    await expect(page.locator('#entry-mission-lora')).toBeVisible()
    await expect(page.locator('#entry-mission-pixiv')).toBeVisible()
    await expect(page.locator('#entry-fn-gallery')).toBeVisible()
    // Owner 2026-07-07: 自由模式 removed (redundant with the Library tile);
    // 隐私处理 surfaced; 全部工具 became the function catalog; language +
    // update check live in the entry corner now.
    await expect(page.locator('#entry-free-mode')).toHaveCount(0)
    await expect(page.locator('#entry-fn-privacy')).toBeVisible()
    await expect(page.locator('#entry-all-tools')).toBeVisible()
    await expect(page.locator('#entry-lang-btn')).toBeVisible()
    await expect(page.locator('#entry-update-btn')).toBeVisible()
    // No saved manual-sort session in the e2e fixture DB → the continue slab
    // stays hidden and its mission tile stays visible.
    await expect(page.locator('#entry-anchor')).toBeHidden()
    await expect(page.locator('#entry-mission-organize')).toBeVisible()
    // Library tile carries the live total from /api/entry/summary.
    await expect(page.locator('#entry-count-gallery')).not.toHaveText('')
  })

  test('empty library stats settle at zero and all generators stay localized', async ({ page }) => {
    const backend = await startIsolatedBackend()
    const consoleProblems: string[] = []
    const requestProblems: string[] = []
    const pageProblems: string[] = []
    const summaryRequests: Request[] = []
    const summaryResponses: Response[] = []
    page.on('console', (message) => {
      if (
        ['warning', 'error'].includes(message.type())
        && message.location().url.startsWith(backend.baseURL)
      ) {
        consoleProblems.push(`${message.type()}: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => pageProblems.push(error.message))
    page.on('request', (request) => {
      if (!request.url().startsWith(backend.baseURL)) return
      if (new URL(request.url()).pathname === '/api/entry/summary') summaryRequests.push(request)
    })
    page.on('requestfailed', (request) => {
      if (request.url().startsWith(backend.baseURL)) {
        requestProblems.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}`)
      }
    })
    page.on('response', (response) => {
      if (!response.url().startsWith(backend.baseURL)) return
      const url = new URL(response.url())
      if (url.pathname === '/api/entry/summary') summaryResponses.push(response)
      if (response.status() >= 400) {
        requestProblems.push(`${response.request().method()} ${response.url()}: HTTP ${response.status()}`)
      }
    })

    try {
      await page.addInitScript(() => {
        window.localStorage.removeItem('aurora-entry-skip')
        window.localStorage.setItem('sd-image-sorter-lang', 'en')
      })
      await page.setViewportSize({ width: 1366, height: 768 })
      await page.goto(backend.baseURL, { waitUntil: 'domcontentloaded' })
      await expect.poll(() => summaryRequests.length).toBeGreaterThan(0)
      await expect.poll(() => summaryResponses.length).toBeGreaterThan(0)
      expect(summaryRequests).toHaveLength(1)
      expect(summaryResponses).toHaveLength(1)
      const summaryResponse = summaryResponses[0]
      expect(summaryResponse.status()).toBe(200)
      expect(await summaryResponse.json()).toMatchObject({
        library_total: 0,
        added_today: 0,
        unviewed: 0,
        streak_days: 0,
        today_touched: 0,
      })
      await expect(page.locator('#entry-page')).toBeVisible()

      const statIds = [
        '#entry-stat-total',
        '#entry-stat-added',
        '#entry-stat-touched',
        '#entry-streak-num',
      ]
      for (const statId of statIds) {
        await expect(page.locator(statId)).toHaveText('0')
      }

      for (const viewport of [
        { width: 1366, height: 768 },
        { width: 1920, height: 1080 },
        { width: 2560, height: 1440 },
      ]) {
        await page.setViewportSize(viewport)
        const geometry = await page.locator('.identity-stats').evaluate((stats) => {
          const box = stats.getBoundingClientRect()
          return {
            horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            insideViewport: box.left >= 0 && box.right <= window.innerWidth + 1
              && box.top >= 0 && box.bottom <= window.innerHeight + 1,
          }
        })
        expect(geometry).toEqual({ horizontalOverflow: 0, insideViewport: true })
      }

      await page.locator('#entry-fn-gallery').click()
      await expect(page.locator('#entry-page')).toBeHidden()
      const generatorSummary = page.locator('#summary-generators')
      await expect(generatorSummary).toHaveText('All')
      expect(await page.evaluate(() => (window as any).FilterStore.DEFAULT_FILTER_GENERATORS.length)).toBe(14)

      await page.locator('#btn-language-toggle').click()
      await expect(generatorSummary).toHaveText('全部')
      await page.locator('#btn-language-toggle').click()
      await expect(generatorSummary).toHaveText('All')

      for (const viewport of [
        { width: 1366, height: 768 },
        { width: 1920, height: 1080 },
        { width: 2560, height: 1440 },
      ]) {
        await page.setViewportSize(viewport)
        const geometry = await generatorSummary.evaluate((summary) => {
          const box = summary.getBoundingClientRect()
          const row = summary.closest('.summary-row')?.getBoundingClientRect()
          return {
            horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            visible: box.width > 0 && box.height > 0,
            insideRow: Boolean(row && box.left >= row.left - 1 && box.right <= row.right + 1),
          }
        })
        expect(geometry).toEqual({ horizontalOverflow: 0, visible: true, insideRow: true })
      }

      expect(consoleProblems).toEqual([])
      expect(pageProblems).toEqual([])
      expect(requestProblems).toEqual([])
    } finally {
      await stopIsolatedBackend(backend)
    }
  })

  test('library tile enters the gallery view', async ({ page }) => {
    await page.click('#entry-fn-gallery')
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-gallery')).toBeVisible()
  })

  test('mission tile enters its host view and scopes the nav bar (LoRA → dataset)', async ({ page }) => {
    await page.click('#entry-mission-lora')
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-dataset')).toBeVisible()
    // Owner 2026-07-07: missions scope the top bar to their pipeline tabs.
    await expect(page.locator('#nav-mission-chip')).toBeVisible()
    await expect(page.locator('#nav-tab-dataset')).toBeVisible()
    await expect(page.locator('#nav-tab-reader')).toBeHidden()
    // The chip's ✕ restores the user's own tab set.
    await page.click('#nav-mission-exit')
    await expect(page.locator('#nav-mission-chip')).toBeHidden()
    await expect(page.locator('#nav-tab-reader')).toBeVisible()
  })

  test('top-level ESC returns to the entry overlay', async ({ page }) => {
    await page.click('#entry-fn-gallery')
    await expect(page.locator('#entry-page')).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(page.locator('#entry-page')).toBeVisible()
    // The app underneath stays mounted (overlay, not a view switch).
    await page.click('#entry-fn-gallery')
    await expect(page.locator('#view-gallery')).toBeVisible()
  })

  test('ESC with a modal open closes the modal, not the view', async ({ page }) => {
    await page.click('#entry-fn-gallery')
    await page.click('#btn-scan')
    await expect(page.locator('#scan-modal')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#entry-page')).toBeHidden()
  })

  test('cover display-mode switch persists and keeps the legacy flag in sync', async ({ page }) => {
    const switcher = page.locator('#entry-hero-mode-switch')
    await expect(switcher).toBeVisible()
    // Default mode is single (no stored preference in the fixture profile).
    await expect(switcher.locator('[data-mode="single"]')).toHaveClass(/active/)

    await switcher.locator('[data-mode="film"]').click()
    await expect(switcher.locator('[data-mode="film"]')).toHaveClass(/active/)
    expect(await page.evaluate(() => window.localStorage.getItem('aurora-entry-hero-mode'))).toBe('film')

    // "off" replaces the removed one-way 不想展示 link and keeps the legacy
    // flag in sync so the settings toggle agrees.
    await switcher.locator('[data-mode="off"]').click()
    await expect(switcher.locator('[data-mode="off"]')).toHaveClass(/active/)
    expect(await page.evaluate(() => window.localStorage.getItem('aurora-entry-hero-off'))).toBe('1')
  })

  test('model-center tile shows readiness and lands on the AI Models tab', async ({ page }) => {
    const tile = page.locator('#entry-fn-models')
    await expect(tile).toBeVisible()
    // Live ready/total count from /api/models/status.
    await expect(page.locator('#entry-count-models')).toHaveText(/\d+\/\d+/)
    await tile.click()
    // Owner 2026-07-07: deep-links to the Models tab of the combined
    // Settings & Models modal, not its default Settings tab — and the modal
    // title follows the active tab so the room matches the door.
    await expect(page.locator('[data-settings-tab="models"]')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#model-manager-title')).toHaveText(/Model Center|模型中心/)
  })

  test('all-features tile opens the function catalog', async ({ page }) => {
    await page.click('#entry-all-tools')
    await expect(page.locator('#entry-catalog-modal.visible')).toBeVisible()
    // Rows render for every group; 隐私处理 is finally discoverable here.
    await expect(page.locator('#entry-catalog-body .catalog-item').first()).toBeVisible()
    await page.click('#entry-catalog-close')
    await expect(page.locator('#entry-catalog-modal.visible')).toHaveCount(0)
  })

  test('privacy tile reaches the Reader obfuscation tool', async ({ page }) => {
    await page.click('#entry-fn-privacy')
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-reader')).toBeVisible()
    await expect(page.locator('#reader-tool-panel-obfuscation')).toBeVisible()
  })

  test('跳过入口页 setting suppresses the entry at next launch', async ({ page }) => {
    await page.click('#entry-settings-btn')
    const toggle = page.locator('#btn-settings-entry-toggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    // The toggle wrote aurora-entry-skip=1; drop the opt-in init script by
    // reloading — localStorage now carries the user's own preference.
    await page.goto('/')
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-gallery')).toBeVisible()
  })
})

test.describe('Entry page (suite default)', () => {
  test('stays hidden when the skip flag is set', async ({ page }) => {
    const entrySummaryRequests: Request[] = []
    const currentSortRequests: Request[] = []
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname === '/api/entry/summary') entrySummaryRequests.push(request)
      if (pathname === '/api/sort/current') currentSortRequests.push(request)
    })
    await page.goto('/')
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-gallery')).toBeVisible()
    expect(entrySummaryRequests).toEqual([])
    expect(currentSortRequests).toHaveLength(1)
  })
})
