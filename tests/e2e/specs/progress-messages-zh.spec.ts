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
  }
  const toast = page.locator('.toast', { hasText: '导入失败' }).first()
  await expect(toast).toBeVisible({ timeout: 15000 })
  expect(await toast.textContent()).not.toContain('Scan failed')
  await page.screenshot({ path: shotPath(testInfo, 'scan-failed-zh-1366.png') })

  override = null
  await request.delete('/api/clear-gallery')
})
