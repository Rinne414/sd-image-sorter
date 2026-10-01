/**
 * Backend progress/status messages follow the UI language.
 *
 * The backend keeps an English (or bilingual) `message` for API compatibility
 * and adds `message_key` + counts. In zh-CN the visible status text must be
 * built from those, never the raw backend sentence, and an i18n re-apply must
 * not revert it.
 *
 * Screenshots land in I18N_MSGS_SHOT_DIR (or testInfo.outputPath).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test } from '../fixtures/click-ledger'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const backendRoot = path.join(repoRoot, 'backend')
const fixtureRoot = path.join(repoRoot, '.tmp', 'manual-test', 'progress-messages-zh')
const shotDir = process.env.I18N_MSGS_SHOT_DIR || ''

const backendPythonCandidates = process.platform === 'win32' ? [
  path.join(backendRoot, 'venv', 'Scripts', 'python.exe'),
  'python',
] : [
  path.join(backendRoot, 'venv', 'bin', 'python'),
  'python3',
]
const backendPython = process.env.PW_BACKEND_PYTHON
  || backendPythonCandidates.find((candidate) => fs.existsSync(candidate) || !candidate.includes(path.sep))
  || backendPythonCandidates[0]

function runBackendScript(script: string): string {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: backendRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

/** Two real PNGs plus one file that is not an image, in a fresh folder. */
function seedScanFolder(name: string): string {
  const folder = path.join(fixtureRoot, name)
  runBackendScript(`
from pathlib import Path
from PIL import Image
import shutil
root = Path(${JSON.stringify(folder)})
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True)
for index, color in enumerate(("crimson", "navy")):
    Image.new("RGB", (64, 64), color=color).save(root / f"ok_{index}.png")
(root / "broken.png").write_bytes(b"not really a png")
`)
  return folder
}

function shotPath(testInfo: any, name: string): string {
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true })
    return path.join(shotDir, name)
  }
  return testInfo.outputPath(name)
}

async function openMainPage(page: any) {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect.poll(async () => page.evaluate(() => Boolean(
    (window as any).App
      && typeof (window as any).App.loadImages === 'function'
      && (window as any).App.AppState?.isLoading === false,
  ))).toBe(true)
}

async function reapplyTranslations(page: any) {
  await page.evaluate(() => {
    (window as any).UIRefresh?.applyTranslations?.()
    document.body.appendChild(document.createElement('div'))
  })
  await page.waitForTimeout(600)
}

test('a finished import reads in Chinese and names the problem file', async ({ page, request }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1366, height: 768 })
  await request.delete('/api/clear-gallery')
  const folder = seedScanFolder('scan-done')

  // The UI acknowledges a finished scan, so keep the done payload it saw.
  let progress: any = null
  page.on('response', async (response) => {
    if (!response.url().includes('/api/scan/progress')) return
    const body = await response.json().catch(() => null)
    if (body?.status === 'done') progress = body
  })

  await openMainPage(page)
  await page.locator('#btn-scan').click()
  await expect(page.locator('#scan-modal.visible')).toBeVisible()
  await page.locator('#scan-folder-path').fill(folder)
  const autoTag = page.locator('#scan-auto-tag')
  if (await autoTag.isChecked().catch(() => false)) {
    await page.locator('label:has(#scan-auto-tag) .checkbox-custom').click()
  }
  await page.locator('#btn-start-scan').click()

  // A quick import shows the library-ready toast, then the background-finished one.
  const toast = page.locator('.toast', { hasText: '图片详细信息已经补齐' }).first()
  await expect(toast).toBeVisible({ timeout: 90000 })
  await page.waitForTimeout(450)
  await page.screenshot({ path: shotPath(testInfo, 'scan-done-zh-1366.png') })

  await expect.poll(() => progress?.status, { timeout: 30000 }).toBe('done')
  expect(progress.message_key).toBe('done')

  const text = await page.evaluate((state) => (window as any).scanStatusText(state), progress)
  expect(text).toContain('导入完成，新增图片：2。')
  expect(text).toContain('有问题的图片：1。')
  expect(text).toContain('问题文件：broken.png。')
  expect(text).not.toMatch(/[A-Za-z]{4,} [A-Za-z]{3,}/)
  expect(text).not.toContain(' / ')

  await reapplyTranslations(page)
  await request.delete('/api/clear-gallery')
})

test('mid-import and failure states show Chinese, and survive a translation re-apply', async ({ page, request }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1366, height: 768 })
  await request.delete('/api/clear-gallery')
  const folder = seedScanFolder('scan-mock')

  let override: Record<string, unknown> | null = null
  await page.route('**/api/scan/progress', async (route) => {
    const response = await route.fetch()
    const real = await response.json()
    const body = override ? { ...real, ...override } : real
    await route.fulfill({ response, json: body })
  })

  await openMainPage(page)
  override = {
    status: 'running',
    step: 'importing',
    message: '已跳过无法读取的图片 / Skipped unreadable image: broken.png (Unreadable image)',
    message_key: 'skipped_unreadable',
    message_item: 'broken.png',
    current_item: null,
    total_final: true,
    import_complete: false,
    total: 9,
    current: 3,
    processed: 3,
  }
  await page.locator('#btn-scan').click()
  await expect(page.locator('#scan-modal.visible')).toBeVisible()
  await page.locator('#scan-folder-path').fill(folder)
  const autoTag = page.locator('#scan-auto-tag')
  if (await autoTag.isChecked().catch(() => false)) {
    await page.locator('label:has(#scan-auto-tag) .checkbox-custom').click()
  }
  await page.locator('#btn-start-scan').click()

  const progressText = page.locator('#scan-progress-text')
  await expect(progressText).toContainText('已跳过无法读取的图片：broken.png', { timeout: 15000 })
  expect(await progressText.textContent()).not.toContain('Skipped')
  await page.waitForTimeout(450)
  await page.screenshot({ path: shotPath(testInfo, 'scan-running-zh-1366.png') })

  await reapplyTranslations(page)
  await expect(progressText).toContainText('已跳过无法读取的图片：broken.png')

  override = {
    status: 'error',
    step: 'error',
    message: '扫描失败：x / Scan failed: x',
    message_key: 'error',
    message_detail: 'Library Root persistence failed. Check database write access.',
  }
  const toast = page.locator('.toast', { hasText: '导入失败' }).first()
  await expect(toast).toBeVisible({ timeout: 15000 })
  expect(await toast.textContent()).not.toContain('Scan failed')
  expect(await toast.textContent()).toContain('Check database write access')
  await page.screenshot({ path: shotPath(testInfo, 'scan-failed-zh-1366.png') })

  override = null
  await request.delete('/api/clear-gallery')
})

function tagProgress(overrides: Record<string, unknown>) {
  return {
    status: 'running',
    current: 0,
    processed: 0,
    total: 0,
    tagged: 0,
    errors: 0,
    message: '',
    message_key: '',
    message_args: {},
    runtime_backend_target: '',
    runtime_backend_actual: '',
    runtime_backend_reason: '',
    memory_pressure_warning: '',
    run_id: 7,
    pipeline_queue: { total_queued: 0, queued: [], last_start_error: null },
    ...overrides,
  }
}

test('tagging progress and finish text read in Chinese and survive a translation re-apply', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1366, height: 768 })

  let payload: Record<string, unknown> = tagProgress({
    current: 3,
    processed: 3,
    total: 9,
    tagged: 2,
    errors: 1,
    message: 'Tagging 4-6/9: a.png ... c.png',
    message_key: 'tagging_batch',
    message_args: { start: 4, end: 6, first: 'a.png', last: 'c.png' },
  })
  await page.route('**/api/tag/progress', (route) => route.fulfill({ json: payload }))

  await openMainPage(page)
  const progressText = page.locator('#tag-progress-text')
  await expect(progressText).toContainText('正在标注第 4-6 张（共 9）：a.png ... c.png', { timeout: 15000 })
  expect(await progressText.textContent()).not.toMatch(/Tagging \d/)
  await page.waitForTimeout(450)
  await page.screenshot({ path: shotPath(testInfo, 'tag-running-zh-1366.png') })

  await reapplyTranslations(page)
  await expect(progressText).toContainText('正在标注第 4-6 张（共 9）：a.png ... c.png')

  payload = tagProgress({
    status: 'running',
    current: 0,
    total: 0,
    message: 'Loading model on GPU...',
    message_key: 'loading_model',
    message_args: { device: 'gpu' },
  })
  await expect(progressText).toContainText('正在用 GPU 载入模型...', { timeout: 15000 })

  payload = tagProgress({
    status: 'running',
    message: 'GPU load failed. Continuing on CPU instead. Reason: The ONNX runtime has no GPU provider on this machine.',
    message_key: 'gpu_load_failed',
    message_args: { reason: 'The ONNX runtime has no GPU provider on this machine.' },
  })
  await expect(progressText).toContainText('GPU 载入失败，改用 CPU 继续。', { timeout: 15000 })
  expect((await progressText.textContent() || '').length).toBeGreaterThan('GPU 载入失败，改用 CPU 继续。'.length + 4)

  payload = tagProgress({
    status: 'running',
    message: 'Auto runtime is using the highest batched throughput.',
    message_key: 'runtime_notice',
    message_args: { notice: 'Auto runtime is using the highest batched throughput.' },
  })
  await expect(progressText).toContainText('正在应用本次运行的运行时设置', { timeout: 15000 })
  await expect(progressText).toHaveAttribute('title', 'Auto runtime is using the highest batched throughput.')

  payload = tagProgress({
    status: 'done',
    current: 9,
    processed: 9,
    total: 9,
    tagged: 8,
    errors: 1,
    message: 'Completed! Processed 9 images: 8 tagged, 1 failed.',
    message_key: 'done',
  })
  const doneToast = page.locator('.toast', { hasText: '标注完成' }).first()
  await expect(doneToast).toBeVisible({ timeout: 15000 })
  expect(await doneToast.textContent()).toContain('已处理 9 张，成功 8 张，1 失败')
  expect(await doneToast.textContent()).not.toContain('Completed')
  await page.waitForTimeout(450)
  await page.screenshot({ path: shotPath(testInfo, 'tag-done-zh-1366.png') })
})

test('a failed tagging run reads in Chinese', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1366, height: 768 })

  let payload: Record<string, unknown> = tagProgress({
    current: 1,
    processed: 1,
    total: 4,
    message_key: 'image_done',
    message_args: { item: 'x.png' },
  })
  await page.route('**/api/tag/progress', (route) => route.fulfill({ json: payload }))
  await openMainPage(page)
  await expect(page.locator('#tag-progress-text')).toContainText('x.png', { timeout: 15000 })

  payload = tagProgress({
    status: 'error',
    message: 'Tagger worker crashed unexpectedly. The app stayed alive, but this tagging run was stopped.',
    message_key: 'worker_crashed',
  })
  const failToast = page.locator('.toast', { hasText: '标注进程意外停止' }).first()
  await expect(failToast).toBeVisible({ timeout: 15000 })
  expect(await failToast.textContent()).not.toContain('crashed')
  await page.screenshot({ path: shotPath(testInfo, 'tag-failed-zh-1366.png') })
})

test('Smart Tag progress and failure read in Chinese', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1366, height: 768 })

  let snapshot: Record<string, unknown> = {
    job_id: 'job-zh-1',
    status: 'running',
    active: true,
    stage: '',
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    message: 'Loading tagger 1/2: wd-swinv2-tagger-v3...',
    message_key: 'loading_tagger_n',
    message_args: { index: 1, count: 2, model: 'wd-swinv2-tagger-v3' },
    phase_completion: 0,
    settings: {},
    errors: [],
    pipeline_queue: { total_queued: 0, queued: [], last_start_error: null },
  }
  await page.route('**/api/smart-tag/progress**', (route) => route.fulfill({ json: snapshot }))

  await openMainPage(page)
  await page.evaluate(() => (window as any).SmartTag.open())
  const progressText = page.locator('#smart-tag-progress-text')
  await expect(progressText).toContainText('正在载入标注器 1/2：wd-swinv2-tagger-v3...', { timeout: 15000 })
  expect(await progressText.textContent()).not.toContain('Loading')
  await page.waitForTimeout(450)
  await page.screenshot({ path: shotPath(testInfo, 'smart-tag-running-zh-1366.png') })

  await reapplyTranslations(page)
  await expect(progressText).toContainText('正在载入标注器 1/2：wd-swinv2-tagger-v3...')

  snapshot = {
    ...snapshot,
    stage: 'tagging',
    total: 10,
    processed: 4,
    succeeded: 3,
    failed: 1,
    message: 'Tagging (wd-swinv2-tagger-v3) 4/10',
    message_key: 'tagging_model',
    message_args: { model: 'wd-swinv2-tagger-v3', done: 4, total: 10 },
    phase_completion: 0.4,
  }
  await expect(progressText).toContainText('成功 3，失败 1', { timeout: 15000 })
  const counted = await progressText.textContent()
  expect(counted).not.toMatch(/ ok,| failed/)

  snapshot = {
    ...snapshot,
    status: 'failed',
    active: false,
    processed: 2,
    succeeded: 0,
    failed: 2,
    message: 'Smart Tag failed for all 2 image(s). Last error: disk is full',
    message_key: 'failed_all',
    message_args: { detail: 'disk is full', device_note: 'cpu_fallback' },
  }
  const toast = page.locator('.toast', { hasText: 'Smart Tag 对全部 2 张图片都失败了' }).first()
  await expect(toast).toBeVisible({ timeout: 15000 })
  expect(await toast.textContent()).toContain('disk is full')
  expect(await toast.textContent()).toContain('描述模型在 CPU 上运行')
  await page.screenshot({ path: shotPath(testInfo, 'smart-tag-failed-zh-1366.png') })
})

test('Auto-Separate move progress and cancel read in Chinese, not the bilingual backend sentence', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1366, height: 768 })

  const base = {
    status: 'running',
    step: 'moving',
    current: 3,
    total: 10,
    errors: 0,
    moved: 3,
    current_item: null,
    recent_errors: [],
    operation: 'move',
    message: '已处理 / Processed: a.png (3/10)',
    message_key: 'processing',
  }
  let payload: Record<string, unknown> = base
  await page.route('**/api/batch-move/progress', (route) => route.fulfill({ json: payload }))

  await openMainPage(page)
  await page.evaluate(() => {
    ;(window as any).__pollDone = (window as any).pollAutosepMoveProgress(10, 'D:/out')
  })
  const text = page.locator('#autosep-move-text')
  await expect(text).toContainText('3/10', { timeout: 15000 })
  const shown = (await text.textContent()) || ''
  expect(shown).not.toContain('Processed')
  expect(shown).not.toContain('已处理 /')
  expect(shown).toContain('已移动 3 张')

  payload = {
    ...base,
    status: 'cancelled',
    message: '已取消（3/10），已移动 3 张 / Cancelled at 3/10. Moved 3 images so far.',
    message_key: 'cancelled',
  }
  const toast = page.locator('.toast', { hasText: '已取消移动，已经移动了 3 张图片' }).first()
  await expect(toast).toBeVisible({ timeout: 15000 })
  expect(await toast.textContent()).not.toContain('Cancelled')
  await page.screenshot({ path: shotPath(testInfo, 'autosep-cancelled-zh-1366.png') })
})

test('artist identification progress and failure read in Chinese', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1366, height: 768 })

  const base = {
    running: true,
    total: 0,
    processed: 0,
    errors: 0,
    results: [],
    step: 'starting',
    message: 'Preparing artist identification...',
    message_key: 'preparing',
    message_detail: '',
    current_item: null,
  }
  let payload: Record<string, unknown> = base
  await page.route('**/api/artists/batch-progress', (route) => route.fulfill({ json: payload }))

  await openMainPage(page)
  await page.evaluate(() => { void (window as any).ArtistIdent.resumeBatchProgress() })
  const text = page.locator('#artist-progress-text')
  await expect(text).toHaveText('正在准备画师识别...', { timeout: 15000 })

  payload = {
    ...base,
    total: 5,
    processed: 2,
    step: 'identifying',
    message: 'Identifying x.png',
    message_key: 'identifying_item',
    current_item: 'x.png',
  }
  await expect(text).toContainText('2/5', { timeout: 15000 })
  const running = (await text.textContent()) || ''
  expect(running).toContain('2/5')
  expect(running).toContain('x.png')
  expect(running).not.toMatch(/Identifying|identified|Artist ID/)
  await page.waitForTimeout(450)
  await page.screenshot({ path: shotPath(testInfo, 'artist-running-zh-1366.png') })

  payload = {
    ...base,
    running: false,
    total: 5,
    step: 'error',
    message: 'Artist identification failed: model missing',
    message_key: 'error',
    message_detail: 'model missing',
  }
  const toast = page.locator('.toast', { hasText: '画师识别失败' }).first()
  await expect(toast).toBeVisible({ timeout: 15000 })
  expect(await toast.textContent()).not.toContain('Artist identification failed')
  await page.screenshot({ path: shotPath(testInfo, 'artist-failed-zh-1366.png') })
})

test('character-purity progress and failure read in Chinese', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1366, height: 768 })

  const base = {
    status: 'running',
    job_id: 'purity-1',
    step: 'extracting',
    current: 3,
    total: 9,
    extracted: 0,
    failed: 0,
    result: null,
    message: 'Embedding image 3/9...',
    message_key: 'embedding',
    message_args: { done: 3, total: 9 },
  }
  let payload: Record<string, unknown> = base
  await page.route('**/api/dataset/character-purity/progress**', (route) => route.fulfill({ json: payload }))

  await openMainPage(page)
  await page.evaluate(() => {
    const purity = (window as any).CharacterPurity
    purity._jobId = 'purity-1'
    purity._schedulePoll()
  })
  const status = page.locator('#ccip-status')
  await expect(status).toHaveText('正在提取第 3/9 张图片的特征...', { timeout: 15000 })
  await page.screenshot({ path: shotPath(testInfo, 'purity-running-zh-1366.png') })

  payload = {
    ...base,
    status: 'failed',
    step: 'failed',
    message: 'Fewer than 2 images could be embedded — nothing to compare. / 可分析的图片不足 2 张，无法比较。',
    message_key: 'too_few',
    message_args: {},
  }
  await expect(status).toHaveText('可分析的图片不足 2 张，无法比较。', { timeout: 15000 })
  expect(await status.textContent()).not.toContain('Fewer than')
  await page.screenshot({ path: shotPath(testInfo, 'purity-failed-zh-1366.png') })
})

test('a second moved-files search is refused in Chinese', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1366, height: 768 })

  await page.route('**/api/images/reconnect-missing/start', (route) => route.fulfill({
    status: 400,
    json: { detail: 'Missing-file reconnect already in progress' },
  }))

  await openMainPage(page)
  await page.evaluate(() => (window as any).App.showModal('reconnect-modal'))
  await expect(page.locator('#reconnect-modal.visible')).toBeVisible()
  await page.locator('#reconnect-folder-path').fill(fixtureRoot)
  await page.locator('#btn-start-reconnect').click()

  const toast = page.locator('.toast', { hasText: '已经有一个查找移动文件的任务在运行' }).first()
  await expect(toast).toBeVisible({ timeout: 15000 })
  expect(await toast.textContent()).not.toContain('already in progress')
  await page.screenshot({ path: shotPath(testInfo, 'reconnect-busy-zh-1366.png') })
})
