import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'
import { markModelsReady } from '../fixtures/model-status'

/**
 * A large EXIF-rotated JPEG is censored where the detection box was (review of af94bb0).
 *
 * Large images open in proxy edit mode: the canvas is the raw stored frame
 * (its size comes from the database, the preview is a raw-frame thumbnail) and
 * the save replays the operations on the raw file. Asking the detector for
 * the upright frame there put the box on the wrong spot of the saved file
 * while the save reported success. In proxy mode the editor asks for the raw
 * frame; a normal load still asks for the upright one.
 *
 * The picture: stored 80 x 40 with EXIF orientation 6, grey with a white
 * square at raw x 10-19, y 5-14 (upright: 40 x 80, square at x 25-34, y 10-19).
 * The detector stub answers like the backend: the upright box when asked for
 * it, else the raw box. A low-memory threshold test flag puts it in proxy mode.
 */

test.describe.configure({ mode: 'serial' })

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const fixtureRoot = path.join(repoRoot, '.tmp', 'manual-test', 'censor-proxy-upright')
const pythonCandidates = [
  process.env.PW_BACKEND_PYTHON || '',
  path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
  path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
].filter(Boolean)
const backendPython = pythonCandidates.find((candidate) => fs.existsSync(candidate)) || 'python'

function runPython<T>(script: string): T {
  const out = execFileSync(backendPython, ['-X', 'utf8', '-c', script], { cwd: repoRoot, stdio: 'pipe' })
  return JSON.parse(out.toString('utf8').trim()) as T
}

function seedRotatedJpeg(): { id: number, outputDir: string } {
  return runPython(`
import json, sys
from pathlib import Path
from PIL import Image
sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, 'backend'))})
import database as db

root = Path(${JSON.stringify(fixtureRoot)})
source_dir = root / "source"
output_dir = root / "out"
source_dir.mkdir(parents=True, exist_ok=True)
output_dir.mkdir(parents=True, exist_ok=True)
source = source_dir / "proxy-rotated.jpg"
image = Image.new("RGB", (80, 40), (128, 128, 128))
image.paste((255, 255, 255), (10, 5, 20, 15))
exif = image.getexif()
exif[0x0112] = 6
image.save(source, format="JPEG", quality=95, exif=exif.tobytes())
image_id = db.add_image(path=str(source.resolve()), filename=source.name, width=80, height=40, metadata_json="{}")
print(json.dumps({"id": int(image_id), "outputDir": str(output_dir.resolve())}))
`)
}

function savedPixel(file: string, x: number, y: number): number[] {
  return runPython(`
import json
from PIL import Image
with Image.open(${JSON.stringify(file)}) as image:
    print(json.dumps(list(image.convert("RGB").getpixel((${x}, ${y})))))
`)
}

async function stubDetector(page: Page): Promise<Array<Record<string, unknown>>> {
  // Detection first checks NudeNet is installed; the detector here is stubbed.
  await markModelsReady(page, ['censor-nudenet'])
  const calls: Array<Record<string, unknown>> = []
  await page.route('**/api/censor/models', (route) => route.fulfill({
    json: {
      status: 'ok',
      recommended_backend: 'nudenet',
      models: [
        { id: 'legacy', name: 'Local YOLO', available: false, files: [], general_model_count: 0, default_model_path: null, capabilities: {} },
        { id: 'nudenet', name: 'NudeNet', available: true, model_downloaded: true, recommended: true, capabilities: {} },
        { id: 'sam3', name: 'SAM3', available: false, message: 'not installed in e2e', capabilities: {} },
      ],
    },
  }))
  await page.route('**/api/censor/detect', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    calls.push(body)
    const box = body.upright === true ? [25, 10, 35, 20] : [10, 5, 20, 15]
    await route.fulfill({
      json: {
        status: 'ok', image_id: body.image_id, model_type: 'nudenet', warnings: [],
        detections: [{ box, label: 'exposed_breasts', confidence: 0.9, source: 'nudenet' }],
      },
    })
  })
  return calls
}

test('a large rotated JPEG in proxy mode is censored where the box was when saved', async ({ page }) => {
  const seeded = seedRotatedJpeg()
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    ;(window as any).__SD_SORTER_TEST_FLAGS__ = { censorLowMemoryPixelThreshold: 100 }
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  const detectCalls = await stubDetector(page)
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as any).App?.addToCensorQueue === 'function')
  await page.evaluate((id) => (window as any).App.addToCensorQueue([id]), seeded.id)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(seeded.id)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.isLoadingImage)).toBe(false)
  expect(await page.evaluate(() => (window as any).__CENSOR_STATE__?.proxyEditMode)).toBe(true)

  await page.selectOption('#censor-style', 'black_bar')
  await page.locator('#btn-auto-detect-current').click()
  await expect.poll(() => detectCalls.length).toBe(1)
  expect(detectCalls[0].upright).toBe(false)

  const output = path.join(seeded.outputDir, 'proxy_rotated_out.png')
  fs.rmSync(output, { force: true })
  const result = await page.evaluate(async ({ id, folder }) => {
    const state = (window as any).__CENSOR_STATE__
    const item = state.queue.find((entry: any) => entry.id === id)
    return (window as any).saveCensorQueueItem(item, 'png', 'strip', 'overwrite', { folder, baseName: 'proxy_rotated_out' })
  }, { id: seeded.id, folder: seeded.outputDir })
  expect(result?.success ?? true).toBe(true)
  expect(fs.existsSync(output)).toBe(true)

  // The saved file is the raw frame: the white square is covered, the spot the
  // upright box would map to in raw coordinates is untouched.
  expect(savedPixel(output, 15, 10)[0]).toBeLessThan(40)
  expect(savedPixel(output, 30, 15)[0]).toBeGreaterThan(100)
})
