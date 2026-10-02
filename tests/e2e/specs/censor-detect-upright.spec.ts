import { expect, test, type Page, type Route } from '../fixtures/click-ledger'
import { markModelsReady } from '../fixtures/model-status'

/**
 * AI detection on a JPEG turned by EXIF orientation (V3.5 #13).
 *
 * The browser shows (and the censor canvas draws) the picture upright. The
 * backend used to detect on the raw stored pixels, so on a phone photo turned
 * 90 degrees every box landed in the wrong place with width and height
 * swapped. The editor now asks for the upright frame (`upright: true`) and a
 * box in that frame covers the right spot.
 *
 * The picture: stored 80 x 40 with EXIF orientation 6, grey with a white
 * square at raw x 10-19, y 5-14. Upright it is 40 x 80 and the square sits at
 * x 25-34, y 10-19 — the box the backend answers with `upright: true`.
 */

test.describe.configure({ mode: 'serial' })

const ORIENTATION_6_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAoAFADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAr6P8AgL/wTA+Pv7RHwn0r4xeCvF3g+10zWPP+zQapqF0k6+VPJA25Y7Z1GWiYjDHgjoeB84V+pv8AwTi/aE+AXgf9jLwb4W8a/HDwfo+p2v8AaP2nTtU8S2tvPDu1G5dd0ckgZcqysMjkMD0NAHwj+1b+xV8U/wBj7+wf+Fl6/wCH77/hIvtX2L+wrqeXZ9n8nfv82GPGfOTGM9DnHGfIK+3v+CyfxY+FnxQ/4Vx/wrT4l+H/ABF9h/tj7b/YWswXf2ff9i2b/Kdtm7Y+M4ztOOhr4hoAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/Z',
  'base64',
)
const IMAGE = { id: 9451, filename: 'phone-photo.jpg', path: 'L:/phone-photo.jpg', width: 80, height: 40 }

async function stubBackend(page: Page) {
  // Detection first checks NudeNet is installed; the detector here is stubbed.
  await markModelsReady(page, ['censor-nudenet'])
  const fulfillJpeg = (route: Route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: ORIENTATION_6_JPEG })
  await page.route(`**/api/image-thumbnail/${IMAGE.id}**`, fulfillJpeg)
  await page.route(`**/api/image-file/${IMAGE.id}**`, fulfillJpeg)
  await page.route('**/api/images?**', (route) =>
    route.fulfill({ json: { images: [IMAGE], total: 1, has_more: false, next_cursor: null } }))
  await page.route('**/api/images/export-data', (route) =>
    route.fulfill({ json: { images: [{ ...IMAGE, prompt: '', tags: [] }], missing_ids: [] } }))
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
  const calls: Array<Record<string, unknown>> = []
  await page.route('**/api/censor/detect', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    calls.push(body)
    // What the backend answers: the upright box when asked, else the raw one.
    const box = body.upright === true ? [25, 10, 35, 20] : [10, 5, 20, 15]
    await route.fulfill({
      json: {
        status: 'ok', image_id: IMAGE.id, model_type: 'nudenet', warnings: [],
        detections: [{ box, label: 'exposed_breasts', confidence: 0.9, source: 'nudenet' }],
      },
    })
  })
  return calls
}

function pixel(page: Page, x: number, y: number) {
  return page.evaluate(([px, py]) => {
    const state = (window as any).__CENSOR_STATE__
    const canvas = document.getElementById(state.activeCanvasId || 'censor-canvas') as HTMLCanvasElement
    const d = canvas.getContext('2d')!.getImageData(px, py, 1, 1).data
    return [d[0], d[1], d[2]]
  }, [x, y])
}

test('a box for a JPEG turned by EXIF orientation lands on the upright picture', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await page.setViewportSize({ width: 1366, height: 768 })
  const calls = await stubBackend(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGE.id}"]`).click()
  await page.locator('#btn-send-to-censor').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(IMAGE.id)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.isLoadingImage)).toBe(false)

  // The canvas holds the upright picture: 40 x 80, the white square at x 25-34.
  const size = await page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    const canvas = document.getElementById(state.activeCanvasId || 'censor-canvas') as HTMLCanvasElement
    return [canvas.width, canvas.height]
  })
  expect(size).toEqual([40, 80])
  expect((await pixel(page, 30, 15))[0]).toBeGreaterThan(200)

  await page.selectOption('#censor-style', 'black_bar')
  await page.locator('#btn-auto-detect-current').click()
  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0].upright).toBe(true)

  // The bar covers the white square, and the raw-frame spot stays grey.
  await expect.poll(async () => (await pixel(page, 30, 15))[0]).toBeLessThan(40)
  const rawSpot = await pixel(page, 15, 10)
  expect(rawSpot[0]).toBeGreaterThan(100)
})
