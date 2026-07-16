import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { expect, test, type APIRequestContext, type Page, type Request, type Route } from '../fixtures/click-ledger'
import { createTestImage } from '../fixtures/test-helpers'

type ScanProgress = {
  status: string
  message?: string
  run_id: number
  source: 'manual' | 'library_auto_refresh' | 'library_rescan' | null
}

type ScanIdentity = {
  run_id: number
  source: 'manual' | 'library_auto_refresh' | 'library_rescan'
}

type BackgroundScanSource = 'library_auto_refresh' | 'library_rescan'

type ScanStart = ScanIdentity & {
  status: 'started'
}

type LibraryRoot = {
  id: number
}

type LibraryRootsResponse = {
  roots: LibraryRoot[]
}

type ImageListResponse = {
  images: Array<{ id: number; filename: string }>
}

type BrowserRequestRecord = {
  method: string
  pathname: string
}

type BrowserEvidence = {
  consoleProblems: string[]
  failedResponses: string[]
  navigationCount: number
  requests: BrowserRequestRecord[]
}

type AutoRefreshFixture = {
  libraryDir: string
  newSource: string
  protectedHashes: Map<string, string>
  tempRoot: string
}

type MockScanStep = {
  status: string
  libraryReady?: boolean
  errors?: number
  processed?: number
  transportError?: string
  runId?: number
  source?: 'manual' | 'library_auto_refresh' | 'library_rescan'
}

const DESKTOP_VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]

const fixtureRoots = new Set<string>()
const REPO_ROOT = path.resolve(__dirname, '../../..')

async function readSha256(filePath: string): Promise<string> {
  const contents = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(contents).digest('hex')
}

async function createAutoRefreshFixture(testName: string): Promise<AutoRefreshFixture> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `sd-sorter-${testName}-`))
  fixtureRoots.add(tempRoot)
  const sourceDir = path.join(tempRoot, 'source')
  const libraryDir = path.join(tempRoot, 'library')
  await fs.mkdir(sourceDir, { recursive: true })
  await fs.mkdir(libraryDir, { recursive: true })

  const seedSource = await createTestImage(sourceDir, 'seed-source.png', {
    width: 96,
    height: 96,
    color: 'teal',
    generator: 'webui',
    prompt: 'idle auto refresh seed',
    negativePrompt: 'none',
    checkpoint: 'idle_auto_refresh_test.safetensors',
  })
  const newSource = await createTestImage(sourceDir, 'new-source.png', {
    width: 96,
    height: 96,
    color: 'purple',
    generator: 'webui',
    prompt: 'idle auto refresh addition',
    negativePrompt: 'none',
    checkpoint: 'idle_auto_refresh_test.safetensors',
  })
  const librarySeed = path.join(libraryDir, 'seed.png')
  await fs.copyFile(seedSource, librarySeed)

  return {
    libraryDir,
    newSource,
    protectedHashes: new Map([
      [seedSource, await readSha256(seedSource)],
      [newSource, await readSha256(newSource)],
      [librarySeed, await readSha256(librarySeed)],
    ]),
    tempRoot,
  }
}

async function waitForScanTerminal(
  request: APIRequestContext,
  expectedIdentity: ScanIdentity | null,
  timeoutMs: number,
): Promise<ScanProgress> {
  let terminalProgress: ScanProgress | null = null
  await expect.poll(
    async () => {
      const response = await request.get('/api/scan/progress')
      expect(response.ok()).toBeTruthy()
      const progress = await response.json() as ScanProgress
      if (expectedIdentity) {
        expect(progress.run_id).toBe(expectedIdentity.run_id)
        expect(progress.source).toBe(expectedIdentity.source)
      }
      if (['done', 'error', 'cancelled'].includes(progress.status)) {
        terminalProgress = progress
      }
      return progress.status
    },
    { timeout: timeoutMs, intervals: [100, 250, 500] },
  ).toMatch(/^(done|error|cancelled)$/)
  if (!terminalProgress) {
    throw new Error(`Scan did not reach a terminal state within ${timeoutMs}ms`)
  }
  return terminalProgress
}

async function resetServerState(request: APIRequestContext): Promise<void> {
  const progressResponse = await request.get('/api/scan/progress')
  expect(progressResponse.ok()).toBeTruthy()
  const progress = await progressResponse.json() as ScanProgress
  if (['starting', 'running', 'cancelling'].includes(progress.status)) {
    if (!progress.source || progress.run_id <= 0) {
      throw new Error(`Active scan returned invalid identity ${progress.run_id}/${progress.source}`)
    }
    const cancelResponse = await request.post('/api/scan/cancel', {
      data: { run_id: progress.run_id, source: progress.source },
    })
    expect(cancelResponse.ok()).toBeTruthy()
    await waitForScanTerminal(request, null, 30_000)
  }

  const resetResponse = await request.post('/api/scan/reset')
  expect(resetResponse.ok()).toBeTruthy()

  const rootsResponse = await request.get('/api/library-roots')
  expect(rootsResponse.ok()).toBeTruthy()
  const roots = await rootsResponse.json() as LibraryRootsResponse
  for (const root of roots.roots) {
    const deleteResponse = await request.delete(`/api/library-roots/${root.id}`)
    expect(deleteResponse.ok()).toBeTruthy()
  }

  const clearResponse = await request.delete('/api/clear-gallery')
  expect(clearResponse.ok()).toBeTruthy()
}

async function startManualScanAndWait(
  request: APIRequestContext,
  libraryDir: string,
): Promise<ScanProgress> {
  const response = await request.post('/api/scan', {
    data: {
      folder_path: libraryDir,
      recursive: true,
      quick_import: true,
      force_reparse: false,
      cleanup_missing: false,
    },
  })
  expect(response.ok()).toBeTruthy()
  const startResult = await response.json() as ScanStart
  expect(startResult.status).toBe('started')
  expect(startResult.source).toBe('manual')
  const terminal = await waitForScanTerminal(request, startResult, 60_000)
  expect(terminal.status, terminal.message).toBe('done')
  return terminal
}

async function scanInitialLibrary(
  request: APIRequestContext,
  libraryDir: string,
): Promise<void> {
  await startManualScanAndWait(request, libraryDir)
  const resetResponse = await request.post('/api/scan/reset')
  expect(resetResponse.ok()).toBeTruthy()
  expect((await resetResponse.json() as { status: string }).status).toBe('reset')
}

async function startAutoRefreshViaApi(request: APIRequestContext): Promise<ScanStart> {
  const response = await request.post('/api/library/auto-refresh', { data: {} })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { status: string; scan?: ScanStart }
  expect(payload.status).toBe('started')
  expect(payload.scan?.source).toBe('library_auto_refresh')
  if (!payload.scan) {
    throw new Error('Auto-refresh start response did not include scan identity')
  }
  return payload.scan
}

async function getApiImageCount(request: APIRequestContext): Promise<number> {
  const response = await request.get('/api/images?limit=50')
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as ImageListResponse
  return payload.images.length
}

async function waitForApiImageCount(
  request: APIRequestContext,
  expectedCount: number,
): Promise<void> {
  await expect.poll(
    async () => getApiImageCount(request),
    { timeout: 60_000, intervals: [100, 250, 500] },
  ).toBe(expectedCount)
}

async function waitForBrowserScanDone(page: Page): Promise<void> {
  await page.waitForResponse(async (response) => {
    const url = new URL(response.url())
    if (url.pathname !== '/api/scan/progress' || !response.ok()) {
      return false
    }
    const progress = await response.json() as ScanProgress
    return progress.status === 'done'
  }, { timeout: 60_000 })
}

function collectBrowserEvidence(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = {
    consoleProblems: [],
    failedResponses: [],
    navigationCount: 0,
    requests: [],
  }

  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type())) {
      evidence.consoleProblems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      evidence.navigationCount += 1
    }
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) {
      evidence.requests.push({ method: request.method(), pathname: url.pathname })
    }
  })
  page.on('response', (response) => {
    if (response.status() >= 400) {
      evidence.failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`)
    }
  })

  return evidence
}

async function openReadyGallery(page: Page, expectedCount: number): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => (
    document.documentElement.dataset.appReady === '1'
    && Boolean((window as typeof window & { AutoRefresh?: object }).AutoRefresh)
  ))
  await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(expectedCount, { timeout: 30_000 })
  await page.waitForLoadState('networkidle')
}

async function enableAndTriggerAutoRefresh(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const autoRefresh = (window as typeof window & {
      AutoRefresh?: {
        _lastActivity: number
        setEnabled: (enabled: boolean) => void
        _tick: () => Promise<void>
      }
    }).AutoRefresh
    if (!autoRefresh) {
      throw new Error('AutoRefresh is not available')
    }
    autoRefresh.setEnabled(true)
    autoRefresh._lastActivity = 0
    await autoRefresh._tick()
  })
}

async function setManualAutoTagChecked(page: Page): Promise<void> {
  await page.evaluate(() => {
    const checkbox = document.querySelector<HTMLInputElement>('#scan-auto-tag')
    if (!checkbox) {
      throw new Error('Manual scan auto-tag checkbox is not available')
    }
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('#scan-auto-tag')).toBeChecked()
}

function resetFlowEvidence(evidence: BrowserEvidence): number {
  evidence.consoleProblems.length = 0
  evidence.failedResponses.length = 0
  evidence.requests.length = 0
  return evidence.navigationCount
}

function assertNoForbiddenBackgroundWrites(evidence: BrowserEvidence): void {
  const forbiddenWrites = evidence.requests.filter((request) => (
    request.method !== 'GET'
    && (
      /^\/api\/(?:tag|tags|smart-tag)(?:\/|$)/.test(request.pathname)
      || /^\/api\/collections(?:\/|$)/.test(request.pathname)
    )
  ))
  expect(forbiddenWrites).toEqual([])
}

async function assertNoManualScanUi(page: Page): Promise<void> {
  await expect(page.locator('#scan-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#tag-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#pipeline-next-step')).toBeHidden()
}

async function assertProtectedFilesUnchanged(fixture: AutoRefreshFixture): Promise<void> {
  for (const [filePath, expectedHash] of fixture.protectedHashes.entries()) {
    expect(await readSha256(filePath)).toBe(expectedHash)
  }
}

async function assertDesktopGalleryHealth(page: Page): Promise<void> {
  for (const viewport of DESKTOP_VIEWPORTS) {
    await page.setViewportSize(viewport)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    const health = await page.evaluate(() => {
      const firstCard = document.querySelector<HTMLElement>('#gallery-grid .gallery-item')
      const cardRect = firstCard?.getBoundingClientRect()
      return {
        cardHasSize: Boolean(cardRect && cardRect.width > 0 && cardRect.height > 0),
        cardWithinViewport: Boolean(cardRect && cardRect.left >= 0 && cardRect.right <= window.innerWidth + 1),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      }
    })
    expect(health, `${viewport.width}x${viewport.height}`).toEqual({
      cardHasSize: true,
      cardWithinViewport: true,
      horizontalOverflow: false,
    })
  }
}

async function installMockedBackgroundProgress(
  page: Page,
  identity: { runId: number; source: BackgroundScanSource },
  steps: MockScanStep[],
): Promise<void> {
  await page.evaluate(({ expectedRunId, expectedSource, pollSteps }) => {
    const probeWindow = window as typeof window & {
      __backgroundScanPollProbe?: { calls: number }
      App?: {
        API: { getScanProgress: () => Promise<object> }
      }
    }
    const app = probeWindow.App
    if (!app) throw new Error('App is not available')
    document.getElementById('toast-container')?.replaceChildren()
    probeWindow.__backgroundScanPollProbe = { calls: 0 }
    app.API.getScanProgress = async () => {
      const callIndex = probeWindow.__backgroundScanPollProbe?.calls ?? 0
      if (probeWindow.__backgroundScanPollProbe) {
        probeWindow.__backgroundScanPollProbe.calls += 1
      }
      const step = pollSteps[Math.min(callIndex, pollSteps.length - 1)]
      if (step.transportError) throw new Error(step.transportError)
      const isIdle = step.status === 'idle'
      return {
        run_id: isIdle ? 0 : (step.runId ?? expectedRunId),
        source: isIdle ? null : (step.source ?? expectedSource),
        status: step.status,
        library_ready: step.libraryReady === true,
        errors: step.errors ?? 0,
        processed: step.processed ?? 0,
        current: step.processed ?? 0,
        message: step.status === 'error' ? 'Synthetic scan failure' : step.status,
      }
    }
  }, {
    expectedRunId: identity.runId,
    expectedSource: identity.source,
    pollSteps: steps,
  })
}

async function beginMockedAutoRefreshProgress(
  page: Page,
  runId: number,
  steps: MockScanStep[],
): Promise<void> {
  await installMockedBackgroundProgress(page, { runId, source: 'library_auto_refresh' }, steps)
  await page.evaluate((expectedRunId) => {
    const app = (window as typeof window & {
      App?: { beginAutoRefreshScanProgress: (start: ScanStart) => Promise<void> }
    }).App
    if (!app) throw new Error('App is not available')
    void app.beginAutoRefreshScanProgress({
      status: 'started',
      run_id: expectedRunId,
      source: 'library_auto_refresh',
    })
  }, runId)
}

async function beginMockedLibraryRescanProgress(
  page: Page,
  runId: number,
  steps: MockScanStep[],
): Promise<void> {
  await installMockedBackgroundProgress(page, { runId, source: 'library_rescan' }, steps)
  await page.evaluate((expectedRunId) => {
    const app = (window as typeof window & {
      App?: { beginLibraryRescanScanProgress: (start: ScanStart) => Promise<void> }
    }).App
    if (!app) throw new Error('App is not available')
    void app.beginLibraryRescanScanProgress({
      status: 'started',
      run_id: expectedRunId,
      source: 'library_rescan',
    })
  }, runId)
}

async function waitForMockPollCalls(page: Page, expectedCalls: number): Promise<void> {
  await page.waitForFunction((calls) => (
    (window as typeof window & { __backgroundScanPollProbe?: { calls: number } })
      .__backgroundScanPollProbe?.calls === calls
  ), expectedCalls, { timeout: 15_000 })
}

test.describe('Idle library auto-refresh completion', () => {
  test.setTimeout(180_000)

  test.beforeEach(async ({ request }) => {
    await resetServerState(request)
  })

  test.afterEach(async ({ request }) => {
    await resetServerState(request)
    for (const fixtureRoot of fixtureRoots) {
      await fs.rm(fixtureRoot, { recursive: true, force: true })
    }
    fixtureRoots.clear()
  })

  test('active Gallery reaches N+1 without reload or manual scan side effects', async ({ page, request }) => {
    const fixture = await createAutoRefreshFixture('active-gallery')
    await scanInitialLibrary(request, fixture.libraryDir)
    expect(await getApiImageCount(request)).toBe(1)

    const evidence = collectBrowserEvidence(page)
    await openReadyGallery(page, 1)
    await setManualAutoTagChecked(page)
    const navigationBaseline = resetFlowEvidence(evidence)

    const copiedImage = path.join(fixture.libraryDir, 'new.png')
    await fs.copyFile(fixture.newSource, copiedImage)
    fixture.protectedHashes.set(copiedImage, await readSha256(copiedImage))
    const browserScanDone = waitForBrowserScanDone(page)
    await enableAndTriggerAutoRefresh(page)

    await waitForApiImageCount(request, 2)
    await browserScanDone
    await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(2, { timeout: 60_000 })
    expect(evidence.navigationCount).toBe(navigationBaseline)
    assertNoForbiddenBackgroundWrites(evidence)
    await assertNoManualScanUi(page)
    await assertProtectedFilesUnchanged(fixture)
    await assertDesktopGalleryHealth(page)
    expect(evidence.consoleProblems).toEqual([])
    expect(evidence.failedResponses).toEqual([])
  })

  test('non-Gallery view defers the image request until Gallery is opened', async ({ page, request }) => {
    const fixture = await createAutoRefreshFixture('deferred-gallery')
    await scanInitialLibrary(request, fixture.libraryDir)
    expect(await getApiImageCount(request)).toBe(1)

    const evidence = collectBrowserEvidence(page)
    await openReadyGallery(page, 1)
    await setManualAutoTagChecked(page)
    await page.evaluate(() => {
      const app = (window as typeof window & { App?: { switchView: (view: string) => void } }).App
      if (!app) throw new Error('App is not available')
      app.switchView('sorting')
    })
    await page.waitForFunction(() => (
      (window as typeof window & { App?: { AppState?: { currentView?: string } } })
        .App?.AppState?.currentView === 'sorting'
    ))
    const navigationBaseline = resetFlowEvidence(evidence)

    const copiedImage = path.join(fixture.libraryDir, 'new.png')
    await fs.copyFile(fixture.newSource, copiedImage)
    fixture.protectedHashes.set(copiedImage, await readSha256(copiedImage))
    const browserScanDone = waitForBrowserScanDone(page)
    await enableAndTriggerAutoRefresh(page)

    await waitForApiImageCount(request, 2)
    await browserScanDone
    await page.waitForFunction(() => (
      (window as typeof window & { App?: { AppState?: { galleryNeedsRefresh?: boolean } } })
        .App?.AppState?.galleryNeedsRefresh === true
    ), undefined, { timeout: 30_000 })
    expect(evidence.requests.filter((requestRecord) => requestRecord.pathname === '/api/images')).toEqual([])

    await page.evaluate(() => {
      const app = (window as typeof window & { App?: { switchView: (view: string) => void } }).App
      if (!app) throw new Error('App is not available')
      app.switchView('gallery')
    })
    await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(2, { timeout: 60_000 })
    expect(evidence.requests.some((requestRecord) => requestRecord.pathname === '/api/images')).toBeTruthy()
    expect(evidence.navigationCount).toBe(navigationBaseline)
    assertNoForbiddenBackgroundWrites(evidence)
    await assertNoManualScanUi(page)
    await assertProtectedFilesUnchanged(fixture)
    expect(evidence.consoleProblems).toEqual([])
    expect(evidence.failedResponses).toEqual([])
  })

  test('reload and a second tab resume an auto-refresh terminal without manual effects', async ({ page, request }) => {
    const fixture = await createAutoRefreshFixture('resume-auto-refresh')
    await scanInitialLibrary(request, fixture.libraryDir)

    const firstEvidence = collectBrowserEvidence(page)
    await openReadyGallery(page, 1)
    await setManualAutoTagChecked(page)

    const copiedImage = path.join(fixture.libraryDir, 'new.png')
    await fs.copyFile(fixture.newSource, copiedImage)
    fixture.protectedHashes.set(copiedImage, await readSha256(copiedImage))
    const scanStart = await startAutoRefreshViaApi(request)
    const terminal = await waitForScanTerminal(request, scanStart, 60_000)
    expect(terminal.status, terminal.message).toBe('done')

    resetFlowEvidence(firstEvidence)
    await page.reload()
    await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
    await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(2, { timeout: 30_000 })
    await assertNoManualScanUi(page)
    assertNoForbiddenBackgroundWrites(firstEvidence)

    const secondPage = await page.context().newPage()
    const secondEvidence = collectBrowserEvidence(secondPage)
    await openReadyGallery(secondPage, 2)
    await assertNoManualScanUi(secondPage)
    assertNoForbiddenBackgroundWrites(secondEvidence)
    expect(firstEvidence.consoleProblems).toEqual([])
    expect(firstEvidence.failedResponses).toEqual([])
    expect(secondEvidence.consoleProblems).toEqual([])
    expect(secondEvidence.failedResponses).toEqual([])
    await assertProtectedFilesUnchanged(fixture)
    await secondPage.close()
  })

  test('manual completion stays pending until reset, then auto-refresh can start', async ({ request }) => {
    const fixture = await createAutoRefreshFixture('manual-completion-pending')
    await scanInitialLibrary(request, fixture.libraryDir)

    const manualResponse = await request.post('/api/scan', {
      data: {
        folder_path: fixture.libraryDir,
        recursive: true,
        quick_import: true,
        force_reparse: false,
        cleanup_missing: false,
      },
    })
    expect(manualResponse.ok()).toBeTruthy()
    const manualStart = await manualResponse.json() as ScanStart
    const manualTerminal = await waitForScanTerminal(request, manualStart, 60_000)
    expect(manualTerminal.status, manualTerminal.message).toBe('done')

    const pendingResponse = await request.post('/api/library/auto-refresh', { data: {} })
    expect(pendingResponse.ok()).toBeTruthy()
    expect(await pendingResponse.json()).toEqual({
      status: 'skipped',
      reason: 'manual_completion_pending',
    })

    const resetResponse = await request.post('/api/scan/reset')
    expect(resetResponse.ok()).toBeTruthy()
    expect((await resetResponse.json() as { status: string }).status).toBe('reset')

    const autoStart = await startAutoRefreshViaApi(request)
    const autoTerminal = await waitForScanTerminal(request, autoStart, 60_000)
    expect(autoTerminal.status, autoTerminal.message).toBe('done')
  })

  test('auto-refresh poller handles active, library-ready, cancelling, cancelled and redirected identities', async ({ page }) => {
    await openReadyGallery(page, 0)

    await beginMockedAutoRefreshProgress(page, 101, [
      { status: 'starting' },
      { status: 'running', libraryReady: true },
      { status: 'done' },
    ])
    await waitForMockPollCalls(page, 3)
    await assertNoManualScanUi(page)

    await beginMockedAutoRefreshProgress(page, 102, [
      { status: 'cancelling' },
      { status: 'cancelled', processed: 1 },
    ])
    await waitForMockPollCalls(page, 2)
    await expect(page.locator('#toast-container .toast.info')).toHaveCount(1)
    await assertNoManualScanUi(page)

    await beginMockedAutoRefreshProgress(page, 103, [
      { status: 'done', runId: 104, source: 'library_rescan' },
    ])
    await waitForMockPollCalls(page, 2)
    await assertNoManualScanUi(page)
  })

  test('auto-refresh poller distinguishes brief idle, long idle, terminal error and unknown status', async ({ page }) => {
    await openReadyGallery(page, 0)

    await beginMockedAutoRefreshProgress(page, 105, [
      { status: 'idle' },
      { status: 'running' },
      { status: 'done' },
    ])
    await waitForMockPollCalls(page, 3)
    await expect(page.locator('#toast-container .toast.error')).toHaveCount(0)

    await beginMockedAutoRefreshProgress(
      page,
      106,
      Array.from({ length: 11 }, () => ({ status: 'idle' })),
    )
    await waitForMockPollCalls(page, 11)
    await expect(page.locator('#toast-container .toast.error .toast-message')).toContainText(/did not start|未能启动/)

    await beginMockedAutoRefreshProgress(page, 107, [{ status: 'error' }])
    await waitForMockPollCalls(page, 1)
    await expect(page.locator('#toast-container .toast.error .toast-message')).toContainText(/Synthetic scan failure/)

    await beginMockedAutoRefreshProgress(page, 108, [{ status: 'future_status' }])
    await waitForMockPollCalls(page, 1)
    await expect(page.locator('#toast-container .toast.error .toast-message')).toContainText(/future_status/)
  })

  test('auto-refresh poller recovers from one transport failure and surfaces retry exhaustion', async ({ page }) => {
    await openReadyGallery(page, 0)

    await beginMockedAutoRefreshProgress(page, 109, [
      { status: 'running', transportError: 'temporary disconnect' },
      { status: 'done' },
    ])
    await waitForMockPollCalls(page, 2)
    await expect(page.locator('#toast-container .toast.error')).toHaveCount(0)

    await beginMockedAutoRefreshProgress(page, 110, [
      { status: 'running', transportError: 'persistent disconnect' },
    ])
    await waitForMockPollCalls(page, 4)
    await expect(page.locator('#toast-container .toast.error .toast-message')).toContainText(/track|跟踪|进度/)
  })

  test('Library Rescan uses source-specific terminal and recovery messages', async ({ page }) => {
    await openReadyGallery(page, 0)
    const rescanCopy = /Library Rescan|图库重新扫描/
    const idleCopy = /Idle library refresh|空闲图库刷新/

    await beginMockedLibraryRescanProgress(page, 111, [
      { status: 'cancelled', processed: 1 },
    ])
    await waitForMockPollCalls(page, 1)
    const cancelledMessage = page.locator('#toast-container .toast.info .toast-message')
    await expect(cancelledMessage).toContainText(rescanCopy)
    await expect(cancelledMessage).not.toContainText(idleCopy)

    await beginMockedLibraryRescanProgress(page, 112, [
      { status: 'done', errors: 2 },
    ])
    await waitForMockPollCalls(page, 1)
    const fileErrorMessage = page.locator('#toast-container .toast.warning .toast-message')
    await expect(fileErrorMessage).toContainText(rescanCopy)
    await expect(fileErrorMessage).not.toContainText(idleCopy)

    await beginMockedLibraryRescanProgress(page, 113, [{ status: 'error' }])
    await waitForMockPollCalls(page, 1)
    const terminalErrorMessage = page.locator('#toast-container .toast.error .toast-message')
    await expect(terminalErrorMessage).toContainText(rescanCopy)
    await expect(terminalErrorMessage).not.toContainText(idleCopy)

    await beginMockedLibraryRescanProgress(page, 114, [{ status: 'future_status' }])
    await waitForMockPollCalls(page, 1)
    const unknownStatusMessage = page.locator('#toast-container .toast.error .toast-message')
    await expect(unknownStatusMessage).toContainText(rescanCopy)
    await expect(unknownStatusMessage).not.toContainText(idleCopy)

    await beginMockedLibraryRescanProgress(page, 115, [
      { status: 'running', transportError: 'persistent rescan disconnect' },
    ])
    await waitForMockPollCalls(page, 4)
    const pollErrorMessage = page.locator('#toast-container .toast.error .toast-message')
    await expect(pollErrorMessage).toContainText(rescanCopy)
    await expect(pollErrorMessage).not.toContainText(idleCopy)
  })

  test('manual completion acknowledgement posts the strict run identity exactly once', async ({ page }) => {
    await openReadyGallery(page, 0)
    await page.evaluate(() => {
      const app = (window as typeof window & { App?: { showModal: (id: string) => void } }).App
      if (!app) throw new Error('App is not available')
      app.showModal('scan-modal')
    })
    await page.locator('#scan-folder-path').fill('L:/synthetic/manual')
    await page.locator('#scan-auto-tag').uncheck()
    await page.evaluate(() => {
      const probeWindow = window as typeof window & {
        __manualAckProbe?: { calls: Array<{ endpoint: string; data: object }> }
        App?: {
          API: {
            getScanProgress: () => Promise<object>
            post: (endpoint: string, data: object) => Promise<object>
            startScan: () => Promise<ScanStart>
          }
        }
      }
      const app = probeWindow.App
      if (!app) throw new Error('App is not available')
      document.getElementById('toast-container')?.replaceChildren()
      probeWindow.__manualAckProbe = { calls: [] }
      app.API.startScan = async () => ({ status: 'started', run_id: 201, source: 'manual' })
      app.API.getScanProgress = async () => ({
        run_id: 201,
        source: 'manual',
        status: 'done',
        step: 'done',
        current: 1,
        processed: 1,
        total: 1,
        errors: 0,
        new: 1,
        library_ready: true,
        message: 'Synthetic manual import complete',
      })
      app.API.post = async (endpoint: string, data: object) => {
        if (endpoint === '/api/scan/acknowledge' || endpoint === '/api/scan/reset') {
          probeWindow.__manualAckProbe?.calls.push({ endpoint, data })
        }
        return { status: 'acknowledged', run_id: 201, source: 'manual' }
      }
    })

    await page.locator('#btn-start-scan').click()
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & { __manualAckProbe?: { calls: object[] } })
        .__manualAckProbe?.calls.length ?? 0
    ))).toBe(1)
    const calls = await page.evaluate(() => (
      (window as typeof window & {
        __manualAckProbe?: { calls: Array<{ endpoint: string; data: object }> }
      }).__manualAckProbe?.calls ?? []
    ))

    expect(calls).toEqual([{
      endpoint: '/api/scan/acknowledge',
      data: { run_id: 201, source: 'manual' },
    }])
    await expect(page.locator('#toast-container .toast.error')).toHaveCount(0)
  })

  test('manual completion acknowledgement reports a concrete invalid-response failure', async ({ page }) => {
    await openReadyGallery(page, 0)
    await page.evaluate(() => {
      const app = (window as typeof window & { App?: { showModal: (id: string) => void } }).App
      if (!app) throw new Error('App is not available')
      app.showModal('scan-modal')
    })
    await page.locator('#scan-folder-path').fill('L:/synthetic/manual-failure')
    await page.locator('#scan-auto-tag').uncheck()
    await page.evaluate(() => {
      const probeWindow = window as typeof window & {
        __manualAckFailureProbe?: { calls: number }
        App?: {
          API: {
            getScanProgress: () => Promise<object>
            post: (endpoint: string, data: object) => Promise<object>
            startScan: () => Promise<ScanStart>
          }
        }
      }
      const app = probeWindow.App
      if (!app) throw new Error('App is not available')
      document.getElementById('toast-container')?.replaceChildren()
      probeWindow.__manualAckFailureProbe = { calls: 0 }
      app.API.startScan = async () => ({ status: 'started', run_id: 202, source: 'manual' })
      app.API.getScanProgress = async () => ({
        run_id: 202,
        source: 'manual',
        status: 'done',
        step: 'done',
        current: 1,
        processed: 1,
        total: 1,
        errors: 0,
        new: 1,
        library_ready: true,
        message: 'Synthetic manual import complete',
      })
      app.API.post = async (endpoint: string) => {
        if (endpoint === '/api/scan/acknowledge') {
          if (probeWindow.__manualAckFailureProbe) probeWindow.__manualAckFailureProbe.calls += 1
          return { status: 'done', message: 'Cannot acknowledge the terminal state' }
        }
        return {}
      }
    })

    await page.locator('#btn-start-scan').click()
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & { __manualAckFailureProbe?: { calls: number } })
        .__manualAckFailureProbe?.calls ?? 0
    ))).toBe(1)
    await expect(page.locator('#toast-container .toast.error .toast-message')).toContainText(/completion state|完成状态|刷新/)
    await expect(page.locator('#pipeline-next-step')).toBeHidden()
    await expect(page.locator('#tag-modal')).not.toHaveClass(/visible/)
  })

  test('one manual terminal claim permits side effects in only one of two tabs', async ({ page, request }) => {
    const fixture = await createAutoRefreshFixture('manual-claim-two-tabs')
    const terminal = await startManualScanAndWait(request, fixture.libraryDir)
    const context = page.context()
    const progressPattern = '**/api/scan/progress'
    const runningConsumers = new Set<Page>()
    const pendingTerminalRoutes = new Map<Page, Route>()
    let acknowledgementRequests = 0
    const progressHandler = async (route: Route): Promise<void> => {
      const consumer = route.request().frame()?.page()
      if (!consumer) throw new Error('Scan progress request has no consumer page')
      if (!runningConsumers.has(consumer)) {
        runningConsumers.add(consumer)
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...terminal,
            status: 'running',
            step: 'scan',
            library_ready: false,
            message: 'Synthetic owned manual run',
          }),
        })
        return
      }

      if (pendingTerminalRoutes.has(consumer)) {
        throw new Error('Consumer requested scan progress twice before terminal release')
      }
      pendingTerminalRoutes.set(consumer, route)
      if (pendingTerminalRoutes.size < 2) return
      const routes = [...pendingTerminalRoutes.values()]
      pendingTerminalRoutes.clear()
      await Promise.all(routes.map(async (pendingRoute) => {
        await pendingRoute.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(terminal),
        })
      }))
    }
    const acknowledgementListener = (browserRequest: Request): void => {
      if (
        browserRequest.method() === 'POST'
        && new URL(browserRequest.url()).pathname === '/api/scan/acknowledge'
      ) {
        acknowledgementRequests += 1
      }
    }
    await context.route(progressPattern, progressHandler)
    context.on('request', acknowledgementListener)
    const firstConsumer = await context.newPage()
    const secondConsumer = await context.newPage()

    try {
      await Promise.all([
        openReadyGallery(firstConsumer, 1),
        openReadyGallery(secondConsumer, 1),
      ])
      await expect.poll(() => acknowledgementRequests, { timeout: 10_000 }).toBe(2)
      await expect.poll(async () => (
        Number(await firstConsumer.locator('#pipeline-next-step').isVisible())
        + Number(await secondConsumer.locator('#pipeline-next-step').isVisible())
      ), { timeout: 10_000 }).toBe(1)
      await expect(firstConsumer.locator('#tag-modal')).not.toHaveClass(/visible/)
      await expect(secondConsumer.locator('#tag-modal')).not.toHaveClass(/visible/)

      const losingConsumer = await firstConsumer.locator('#pipeline-next-step').isVisible()
        ? secondConsumer
        : firstConsumer
      await expect(losingConsumer.locator('#pipeline-next-step')).toBeHidden()
      await expect(losingConsumer.locator('#toast-container .toast.error')).toHaveCount(0)
      await expect(losingConsumer.locator('#scan-progress-container')).toBeHidden()
      await expect(losingConsumer.locator('#btn-start-scan')).toBeEnabled()
      await expect(losingConsumer.locator('#scan-modal')).not.toHaveClass(/visible/)
    } finally {
      context.off('request', acknowledgementListener)
      await context.unroute(progressPattern, progressHandler)
      await firstConsumer.close()
      await secondConsumer.close()
    }
  })

  test('a lost manual claim rebinds to the newer scan identity', async ({ page }) => {
    await openReadyGallery(page, 0)
    await page.evaluate(() => {
      const app = (window as typeof window & { App?: { showModal: (id: string) => void } }).App
      if (!app) throw new Error('App is not available')
      app.showModal('scan-modal')
    })
    await page.locator('#scan-folder-path').fill('L:/synthetic/manual-rebind')
    await page.locator('#scan-auto-tag').uncheck()
    await page.evaluate(() => {
      const probeWindow = window as typeof window & {
        __manualRebindProbe?: { progressCalls: number }
        App?: {
          API: {
            getScanProgress: () => Promise<object>
            post: (endpoint: string, data: object) => Promise<object>
            startScan: () => Promise<ScanStart>
          }
        }
      }
      const app = probeWindow.App
      if (!app) throw new Error('App is not available')
      document.getElementById('toast-container')?.replaceChildren()
      probeWindow.__manualRebindProbe = { progressCalls: 0 }
      app.API.startScan = async () => ({ status: 'started', run_id: 203, source: 'manual' })
      app.API.getScanProgress = async () => {
        const probe = probeWindow.__manualRebindProbe
        if (!probe) throw new Error('Manual rebind probe is not available')
        probe.progressCalls += 1
        if (probe.progressCalls === 1) {
          return {
            run_id: 203,
            source: 'manual',
            status: 'done',
            step: 'done',
            current: 1,
            processed: 1,
            total: 1,
            errors: 0,
            new: 1,
            library_ready: true,
            message: 'Superseded manual import complete',
          }
        }
        return {
          run_id: 204,
          source: 'library_rescan',
          status: 'done',
          step: 'done',
          current: 1,
          processed: 1,
          total: 1,
          errors: 0,
          new: 0,
          library_ready: true,
          message: 'Newer Library Rescan complete',
        }
      }
      app.API.post = async (endpoint: string) => {
        if (endpoint !== '/api/scan/acknowledge') throw new Error(`Unexpected POST ${endpoint}`)
        const error = new Error('Scan progress changed before acknowledgement') as Error & {
          apiStatus: number
          apiData: object
        }
        error.apiStatus = 409
        error.apiData = {
          code: 'scan_identity_mismatch',
          message: 'Scan progress changed before acknowledgement',
          current: {
            run_id: 204,
            source: 'library_rescan',
            status: 'running',
          },
        }
        throw error
      }
    })

    await page.locator('#btn-start-scan').click()
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & { __manualRebindProbe?: { progressCalls: number } })
        .__manualRebindProbe?.progressCalls ?? 0
    ))).toBe(2)
    await expect(page.locator('#toast-container .toast.error')).toHaveCount(0)
    await expect(page.locator('#pipeline-next-step')).toBeHidden()
    await expect(page.locator('#tag-modal')).not.toHaveClass(/visible/)
    await expect(page.locator('#scan-progress-container')).toBeHidden()
    await expect(page.locator('#btn-start-scan')).toBeEnabled()
  })

  test('an observed manual run ends quietly when another tab claims it before the next poll', async ({ page, request }) => {
    const fixture = await createAutoRefreshFixture('manual-claim-canonical-idle')
    const terminal = await startManualScanAndWait(request, fixture.libraryDir)
    const secondConsumer = await page.context().newPage()
    const secondEvidence = collectBrowserEvidence(secondConsumer)
    const progressPattern = '**/api/scan/progress'
    let releaseCanonicalIdle = false
    let secondConsumerPolls = 0

    await secondConsumer.route(progressPattern, async (route) => {
      secondConsumerPolls += 1
      if (releaseCanonicalIdle) {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...terminal,
          status: 'running',
          step: 'scan',
          library_ready: false,
          message: 'Synthetic owned manual run',
        }),
      })
    })

    try {
      await secondConsumer.goto('/')
      await secondConsumer.waitForFunction(() => document.documentElement.dataset.appReady === '1')
      await expect(secondConsumer.locator('#gallery-grid .gallery-item')).toHaveCount(1)
      await expect.poll(() => secondConsumerPolls, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)

      await openReadyGallery(page, 1)
      await expect(page.locator('#pipeline-next-step')).toHaveClass(/visible/)
      await expect.poll(async () => {
        const response = await request.get('/api/scan/progress')
        expect(response.ok()).toBeTruthy()
        const progress = await response.json() as ScanProgress
        return {
          run_id: progress.run_id,
          source: progress.source,
          status: progress.status,
        }
      }).toEqual({ run_id: 0, source: null, status: 'idle' })

      const pollsBeforeRelease = secondConsumerPolls
      releaseCanonicalIdle = true
      await expect.poll(() => secondConsumerPolls, { timeout: 5_000 }).toBeGreaterThan(pollsBeforeRelease)
      const quietObservationDeadline = Date.now() + 6_500
      await expect.poll(
        () => Date.now() < quietObservationDeadline ? -1 : secondConsumerPolls,
        { timeout: 7_500, intervals: [250] },
      ).toBe(pollsBeforeRelease + 1)

      await expect(secondConsumer.locator('#toast-container .toast.error')).toHaveCount(0)
      await expect(secondConsumer.locator('#pipeline-next-step')).toBeHidden()
      await expect(secondConsumer.locator('#tag-modal')).not.toHaveClass(/visible/)
      await expect(secondConsumer.locator('#scan-progress-container')).toBeHidden()
      await expect(secondConsumer.locator('#btn-start-scan')).toBeEnabled()
      assertNoForbiddenBackgroundWrites(secondEvidence)
      expect(secondEvidence.consoleProblems).toEqual([])
      expect(secondEvidence.failedResponses).toEqual([])
    } finally {
      await secondConsumer.unroute(progressPattern)
      await secondConsumer.close()
    }
  })

  test('an accepted manual start ends quietly when another tab claims before its first progress response', async ({ page, request }) => {
    const fixture = await createAutoRefreshFixture('manual-start-first-idle')
    const initiatingConsumer = await page.context().newPage()
    const initiatingEvidence = collectBrowserEvidence(initiatingConsumer)
    const context = page.context()
    const progressPattern = '**/api/scan/progress'
    const acknowledgementBodies: ScanIdentity[] = []
    let initiatingProgressRequests = 0
    let progressReleased = false
    let resolveHeldProgressRoute!: (route: Route) => void
    const heldProgressRoutePromise = new Promise<Route>((resolve) => {
      resolveHeldProgressRoute = resolve
    })
    const acknowledgementListener = (browserRequest: Request): void => {
      if (
        browserRequest.method() === 'POST'
        && new URL(browserRequest.url()).pathname === '/api/scan/acknowledge'
      ) {
        acknowledgementBodies.push(browserRequest.postDataJSON() as ScanIdentity)
      }
    }

    await openReadyGallery(initiatingConsumer, 0)
    await initiatingConsumer.locator('#btn-scan').click()
    await expect(initiatingConsumer.locator('#scan-modal')).toHaveClass(/visible/)
    await initiatingConsumer.locator('#scan-folder-path').fill(fixture.libraryDir)
    await initiatingConsumer.locator('#scan-auto-tag').uncheck()
    await initiatingConsumer.route(progressPattern, async (route) => {
      initiatingProgressRequests += 1
      if (!progressReleased) {
        if (initiatingProgressRequests !== 1) {
          throw new Error('Initiating tab requested progress twice before release')
        }
        resolveHeldProgressRoute(route)
        return
      }
      await route.continue()
    })
    context.on('request', acknowledgementListener)

    try {
      const scanStartResponsePromise = initiatingConsumer.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/scan'
      ))
      await initiatingConsumer.locator('#btn-start-scan').click()
      const scanStartResponse = await scanStartResponsePromise
      expect(scanStartResponse.ok()).toBeTruthy()
      const scanStart = await scanStartResponse.json() as ScanStart
      expect(scanStart.status).toBe('started')
      expect(scanStart.source).toBe('manual')
      await expect.poll(() => initiatingProgressRequests, { timeout: 10_000 }).toBe(1)
      const heldProgressRoute = await heldProgressRoutePromise

      const terminal = await waitForScanTerminal(request, scanStart, 60_000)
      expect(terminal.status, terminal.message).toBe('done')
      await openReadyGallery(page, 1)
      await expect(page.locator('#pipeline-next-step')).toHaveClass(/visible/)
      await expect.poll(() => acknowledgementBodies.length, { timeout: 10_000 }).toBe(1)
      expect(acknowledgementBodies).toEqual([{
        run_id: scanStart.run_id,
        source: scanStart.source,
      }])
      await expect.poll(async () => {
        const response = await request.get('/api/scan/progress')
        expect(response.ok()).toBeTruthy()
        const progress = await response.json() as ScanProgress
        return {
          run_id: progress.run_id,
          source: progress.source,
          status: progress.status,
        }
      }).toEqual({ run_id: 0, source: null, status: 'idle' })

      progressReleased = true
      await heldProgressRoute.continue()
      const quietObservationDeadline = Date.now() + 6_500
      await expect.poll(
        () => Date.now() < quietObservationDeadline ? -1 : initiatingProgressRequests,
        { timeout: 7_500, intervals: [250] },
      ).toBe(1)

      await expect(initiatingConsumer.locator('#toast-container .toast.error')).toHaveCount(0)
      await expect(initiatingConsumer.locator('#pipeline-next-step')).toBeHidden()
      await expect(initiatingConsumer.locator('#tag-modal')).not.toHaveClass(/visible/)
      await expect(initiatingConsumer.locator('#scan-progress-container')).toBeHidden()
      await expect(initiatingConsumer.locator('#btn-start-scan')).toBeEnabled()
      await expect(initiatingConsumer.locator('#scan-modal')).not.toHaveClass(/visible/)
      assertNoForbiddenBackgroundWrites(initiatingEvidence)
      expect(initiatingEvidence.consoleProblems).toEqual([])
      expect(initiatingEvidence.failedResponses).toEqual([])
      await assertProtectedFilesUnchanged(fixture)
    } finally {
      context.off('request', acknowledgementListener)
      await initiatingConsumer.unroute(progressPattern)
      await initiatingConsumer.close()
    }
  })

  test('a failed manual terminal claim performs no effects and reload claims it once', async ({ page, request }) => {
    const fixture = await createAutoRefreshFixture('manual-claim-reload')
    await startManualScanAndWait(request, fixture.libraryDir)
    const context = page.context()
    const acknowledgementPattern = '**/api/scan/acknowledge'
    let claimWasAborted = false
    const acknowledgementHandler = async (route: Route): Promise<void> => {
      claimWasAborted = true
      await route.abort('failed')
    }
    await context.route(acknowledgementPattern, acknowledgementHandler)
    const consumer = await context.newPage()

    try {
      await openReadyGallery(consumer, 1)
      await expect(consumer.locator('#toast-container .toast.error .toast-message')).toContainText(/completion state|完成状态|刷新/)
      expect(claimWasAborted).toBe(true)
      await expect(consumer.locator('#pipeline-next-step')).toBeHidden()
      await expect(consumer.locator('#tag-modal')).not.toHaveClass(/visible/)

      await context.unroute(acknowledgementPattern, acknowledgementHandler)
      await consumer.reload()
      await consumer.waitForFunction(() => document.documentElement.dataset.appReady === '1')
      await expect(consumer.locator('#pipeline-next-step')).toHaveClass(/visible/)
      await expect(consumer.locator('#tag-modal')).not.toHaveClass(/visible/)
    } finally {
      await context.unroute(acknowledgementPattern, acknowledgementHandler)
      await consumer.close()
    }
  })

  test('manual scan cancellation sends a queued starting run to cancelled UI state', async ({ page }) => {
    await openReadyGallery(page, 0)
    await page.evaluate(() => {
      const probeWindow = window as typeof window & {
        __startingCancelProbe?: {
          calls: Array<{ endpoint: string; data: object | undefined }>
        }
        App?: {
          API: {
            getScanProgress: () => Promise<object>
            post: (endpoint: string, data?: object) => Promise<object>
          }
          showModal: (id: string) => void
        }
      }
      const app = probeWindow.App
      if (!app) throw new Error('App is not available')
      document.getElementById('toast-container')?.replaceChildren()
      probeWindow.__startingCancelProbe = { calls: [] }
      app.API.getScanProgress = async () => ({
        run_id: 301,
        source: 'manual',
        status: 'starting',
        processed: 0,
        current: 0,
        total: 0,
        total_final: false,
      })
      app.API.post = async (endpoint: string, data?: object) => {
        if (endpoint !== '/api/scan/cancel') throw new Error(`Unexpected POST ${endpoint}`)
        probeWindow.__startingCancelProbe?.calls.push({ endpoint, data })
        return { status: 'cancelled', run_id: 301, source: 'manual' }
      }
      app.showModal('scan-modal')
    })

    await page.locator('#btn-cancel-scan').click()
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & { __startingCancelProbe?: { calls: object[] } })
        .__startingCancelProbe?.calls.length ?? 0
    )), { timeout: 5_000 }).toBe(1)
    const cancelCalls = await page.evaluate(() => (
      (window as typeof window & {
        __startingCancelProbe?: {
          calls: Array<{ endpoint: string; data: object | undefined }>
        }
      }).__startingCancelProbe?.calls ?? []
    ))
    expect(cancelCalls).toEqual([{
      endpoint: '/api/scan/cancel',
      data: { run_id: 301, source: 'manual' },
    }])
    await expect(page.locator('#toast-container .toast.info .toast-message')).toContainText(/cancelled|已取消/)
    await expect(page.locator('#scan-modal')).not.toHaveClass(/visible/)
  })

  test('manual scan cancellation keeps controls open when progress cannot be read', async ({ page }) => {
    await openReadyGallery(page, 0)
    await page.evaluate(() => {
      const probeWindow = window as typeof window & {
        __cancelReadFailureProbe?: { cancelCalls: number }
        App?: {
          API: {
            cancelScan: (identity: object) => Promise<object>
            getScanProgress: () => Promise<object>
          }
          showModal: (id: string) => void
        }
      }
      const app = probeWindow.App
      if (!app) throw new Error('App is not available')
      document.getElementById('toast-container')?.replaceChildren()
      probeWindow.__cancelReadFailureProbe = { cancelCalls: 0 }
      app.API.getScanProgress = async () => {
        throw new Error('Synthetic progress transport failure')
      }
      app.API.cancelScan = async () => {
        if (probeWindow.__cancelReadFailureProbe) probeWindow.__cancelReadFailureProbe.cancelCalls += 1
        return { status: 'cancelled', run_id: 302, source: 'manual' }
      }
      app.showModal('scan-modal')
    })

    await page.locator('#btn-cancel-scan').click()
    await expect(page.locator('#scan-modal')).toHaveClass(/visible/)
    await expect(page.locator('#toast-container .toast.error .toast-message')).toContainText(/stop|停止|progress|进度/i)
    expect(await page.evaluate(() => (
      (window as typeof window & { __cancelReadFailureProbe?: { cancelCalls: number } })
        .__cancelReadFailureProbe?.cancelCalls ?? 0
    ))).toBe(0)
  })

  test('manual scan cancellation rejects an unexpected terminal response', async ({ page }) => {
    await openReadyGallery(page, 0)
    await page.evaluate(() => {
      const probeWindow = window as typeof window & {
        App?: {
          API: {
            cancelScan: (identity: object) => Promise<object>
            getScanProgress: () => Promise<object>
          }
          showModal: (id: string) => void
        }
      }
      const app = probeWindow.App
      if (!app) throw new Error('App is not available')
      document.getElementById('toast-container')?.replaceChildren()
      app.API.getScanProgress = async () => ({
        run_id: 303,
        source: 'manual',
        status: 'starting',
        processed: 0,
        current: 0,
        total: 0,
        total_final: false,
      })
      app.API.cancelScan = async () => ({
        status: 'done',
        run_id: 303,
        source: 'manual',
      })
      app.showModal('scan-modal')
    })

    await page.locator('#btn-cancel-scan').click()
    await expect(page.locator('#scan-modal')).toHaveClass(/visible/)
    await expect(page.locator('#toast-container .toast.error .toast-message')).toContainText(/stop|停止|status|状态/i)
    await expect(page.locator('#toast-container .toast.info')).toHaveCount(0)
  })

  test('Library Rescan explains a pending manual completion instead of reporting a running scan', async ({ page }) => {
    await openReadyGallery(page, 0)
    await page.evaluate(async () => {
      const probeWindow = window as typeof window & {
        App?: {
          API: {
            get: (endpoint: string) => Promise<object>
            post: (endpoint: string, data: object) => Promise<object>
          }
        }
        LibraryRootsUI?: { open: () => Promise<void> }
      }
      const app = probeWindow.App
      const libraryRoots = probeWindow.LibraryRootsUI
      if (!app || !libraryRoots) throw new Error('Library Roots UI is not available')
      document.getElementById('toast-container')?.replaceChildren()
      app.API.get = async (endpoint: string) => {
        if (endpoint !== '/api/library-roots') throw new Error(`Unexpected GET ${endpoint}`)
        return {
          roots: [{
            id: 41,
            path: 'L:/synthetic/library',
            exists: true,
            image_count: 1,
            last_scanned_at: null,
          }],
        }
      }
      app.API.post = async (endpoint: string) => {
        if (endpoint !== '/api/library-roots/41/rescan') {
          throw new Error(`Unexpected POST ${endpoint}`)
        }
        throw Object.assign(new Error('Manual completion pending'), {
          apiStatus: 409,
          apiData: {
            code: 'manual_completion_pending',
            message: 'A completed manual scan must be acknowledged first',
            error: 'A completed manual scan must be acknowledged first',
            type: 'HTTPException',
            status_code: 409,
          },
        })
      }
      await libraryRoots.open()
    })

    await page.locator('[data-action="rescan"][data-id="41"]').click()
    const toastMessage = page.locator('#toast-container .toast.error .toast-message')
    await expect(toastMessage).toContainText(/previous import|上一次导入/)
    await expect(toastMessage).toContainText(/reload|重新加载/i)
    await expect(toastMessage).not.toContainText(/already running|已有扫描正在进行/)
  })

  test('scan polling ownership is keyed by strict run identity rather than one global generation', async ({ page }) => {
    await openReadyGallery(page, 0)
    const invalidIdentityError = await page.evaluate(() => {
      const app = (window as typeof window & {
        App?: { beginAutoRefreshScanProgress: (scanStart: object) => unknown }
      }).App
      if (!app) throw new Error('App is not available')
      try {
        app.beginAutoRefreshScanProgress({
          status: 'started',
          run_id: '111',
          source: 'library_auto_refresh',
        })
        return ''
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })

    expect(invalidIdentityError).toContain('invalid scan identity')
    const source = await fs.readFile(
      path.join(REPO_ROOT, 'frontend/js/app/scan-diagnostics.js'),
      'utf8',
    )

    expect(source).not.toContain('_scanPollGeneration')
    expect(source).toContain('_scanPollersByIdentity')
  })

  test('expected no-root idle is quiet and a missing registered root gives recovery guidance', async ({ page, request }) => {
    await openReadyGallery(page, 0)
    const errorToasts = page.locator('#toast-container .toast.error')
    const initialErrorCount = await errorToasts.count()

    await enableAndTriggerAutoRefresh(page)
    expect(await errorToasts.count()).toBe(initialErrorCount)

    const fixture = await createAutoRefreshFixture('missing-root')
    await scanInitialLibrary(request, fixture.libraryDir)
    await fs.rm(fixture.libraryDir, { recursive: true, force: true })
    await enableAndTriggerAutoRefresh(page)

    await expect(page.locator('#toast-container .toast.error .toast-message')).toContainText(/Rescan|重新扫描/)
  })
})
