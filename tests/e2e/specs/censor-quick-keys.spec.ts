import type { Page, Route } from '@playwright/test'
import { expect, test } from '../fixtures/click-ledger'

/**
 * Quick manual censoring keys (owner 2026-09-28, our own layout, not WASD):
 * Enter = done with this picture (Review tab: detect, then approve), right-drag
 * = erase with the current brush size, Delete = take the picture out of the
 * queue (the file stays on disk).
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#d9e2f2"/>
</svg>
`.trim()

const IMAGES = [
  { id: 9501, filename: 'first.png', path: 'L:/quick-keys-first.png', width: 640, height: 640 },
  { id: 9502, filename: 'second.png', path: 'L:/quick-keys-second.png', width: 640, height: 640 },
  { id: 9503, filename: 'third.png', path: 'L:/quick-keys-third.png', width: 640, height: 640 },
]

async function stubCensorBackend(page: Page): Promise<string[]> {
  const deletes: string[] = []
  const fulfillImage = async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  }
  for (const image of IMAGES) {
    await page.route(`**/api/image-thumbnail/${image.id}**`, fulfillImage)
    await page.route(`**/api/image-file/${image.id}**`, fulfillImage)
  }
  await page.route('**/api/images?**', async (route) => {
    await route.fulfill({ json: { images: IMAGES, total: IMAGES.length, has_more: false, next_cursor: null } })
  })
  await page.route('**/api/images/export-data', async (route) => {
    await route.fulfill({ json: { images: IMAGES.map((image) => ({ ...image, prompt: '', tags: [] })), missing_ids: [] } })
  })
  page.on('request', (request) => {
    if (request.method() === 'DELETE' || /delete/i.test(new URL(request.url()).pathname)) deletes.push(request.url())
  })
  return deletes
}

async function openCensor(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('#btn-toggle-select').click()
  for (const image of IMAGES) {
    await page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`).click()
  }
  await page.locator('#btn-send-to-censor').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await waitForActive(page, IMAGES[0].id)
}

async function waitForActive(page: Page, id: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(id)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.isLoadingImage)).toBe(false)
}

function queueIds(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as any).__CENSOR_STATE__.queue.map((item: any) => item.id))
}

let deletes: string[] = []

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
    localStorage.removeItem('censor_queue')
  })
  deletes = await stubCensorBackend(page)
  await openCensor(page)
})

test('Enter moves to the next picture and opens Save on the last one', async ({ page }) => {
  await page.keyboard.press('Enter')
  await waitForActive(page, IMAGES[1].id)
  await page.keyboard.press('Enter')
  await waitForActive(page, IMAGES[2].id)
  await expect(page.locator('#save-options-modal')).not.toHaveClass(/visible/)

  await page.keyboard.press('Enter')

  await expect(page.locator('#save-options-modal')).toHaveClass(/visible/)
  expect(await page.evaluate(() => (window as any).__CENSOR_STATE__.activeId)).toBe(IMAGES[2].id)
})

test('Enter on a button reached with the keyboard only presses that button', async ({ page }) => {
  const zoom = page.locator('#zoom-level')
  const before = await zoom.textContent()
  await page.locator('#btn-zoom-out').focus()
  await page.keyboard.press('Tab')
  await expect(page.locator('#btn-zoom-in')).toBeFocused()

  await page.keyboard.press('Enter')

  await expect(zoom).not.toHaveText(before || '')
  expect(await page.evaluate(() => (window as any).__CENSOR_STATE__.activeId)).toBe(IMAGES[0].id)
})

test('a button left focused by a mouse click does not swallow Enter', async ({ page }) => {
  await page.locator('#btn-zoom-in').click()
  await expect(page.locator('#btn-zoom-in')).toBeFocused()

  await page.keyboard.press('Enter')

  await waitForActive(page, IMAGES[1].id)
})

test('Delete takes the picture out of the queue and keeps the file', async ({ page }) => {
  await page.keyboard.press('Delete')

  await waitForActive(page, IMAGES[1].id)
  expect(await queueIds(page)).toEqual([IMAGES[1].id, IMAGES[2].id])
  await expect(page.locator('.toast').last()).toContainText('file is kept')
  expect(deletes).toEqual([])
})

test('Delete asks first when the picture has unsaved censoring', async ({ page }) => {
  await page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    state.queue.find((item: any) => item.id === state.activeId).isModified = true
  })

  await page.keyboard.press('Delete')
  const dialog = page.locator('#confirm-modal')
  await expect(dialog).toHaveClass(/visible/)
  await page.locator('#btn-confirm-cancel').click()
  expect(await queueIds(page)).toHaveLength(3)

  await page.keyboard.press('Delete')
  await expect(dialog).toHaveClass(/visible/)
  await page.locator('#btn-confirm-ok').click()
  await waitForActive(page, IMAGES[1].id)
  expect(await queueIds(page)).toEqual([IMAGES[1].id, IMAGES[2].id])
})

test('right-drag erases with the brush size and keeps the chosen tool', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any
    w.__strokeTools = []
    const original = w.drawAtPoint
    w.drawAtPoint = (...args: unknown[]) => {
      w.__strokeTools.push(w.__CENSOR_STATE__.currentTool)
      return original(...args)
    }
  })
  await page.keyboard.press('b')
  const box = await page.evaluate(() => {
    const rect = (window as any).getActiveCensorCanvas().getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(x + 20, y + 10, { steps: 4 })
  await page.mouse.up({ button: 'right' })

  const tools: string[] = await page.evaluate(() => (window as any).__strokeTools)
  expect(tools.length).toBeGreaterThan(0)
  expect(new Set(tools)).toEqual(new Set(['eraser']))
  expect(await page.evaluate(() => (window as any).__CENSOR_STATE__.currentTool)).toBe('brush')
  await expect(page.locator('.tool-btn-v2.active[data-tool]')).toHaveAttribute('data-tool', 'brush')
})

test('the shortcut list names the new keys', async ({ page }, testInfo) => {
  await page.locator('.censor-shortcuts-disclosure summary').click()
  const list = page.locator('.censor-shortcuts-popover')
  await expect(list).toContainText('Enter')
  await expect(list).toContainText('Right-drag')
  await expect(list).toContainText('Delete')
  await expect(list).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: testInfo.outputPath('censor-shortcuts-1366.png') })
})

test('on the Review tab Enter detects first, then approves, and passes a picture with nothing found', async ({ page }) => {
  await page.locator('.censor-tab[data-censor-tab="review"]').click()
  await page.evaluate(() => {
    const w = window as any
    w.__reviewCalls = []
    w.censorReviewDetect = () => w.__reviewCalls.push('detect')
    w.censorReviewApprove = () => w.__reviewCalls.push('approve')
  })

  await page.keyboard.press('Enter')
  await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    const review = (0, eval)('CensorReviewState')
    review.detectedForId = (window as any).__CENSOR_STATE__.activeId
    review.regions = [{ box: [0, 0, 10, 10] }]
  })
  await page.keyboard.press('Enter')
  expect(await page.evaluate(() => (window as any).__reviewCalls)).toEqual(['detect', 'approve'])

  await page.evaluate(() => {
    const review = (0, eval)('CensorReviewState')
    review.regions = []
  })
  await page.keyboard.press('Enter')
  await waitForActive(page, IMAGES[1].id)
  expect(await page.evaluate(() => (window as any).__reviewCalls)).toEqual(['detect', 'approve'])
})

test('Delete asks first for an auto-censored picture that is not saved', async ({ page }) => {
  await page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    const item = state.queue.find((entry: any) => entry.id === state.activeId)
    item.isProcessed = true
    item.isModified = false
  })

  await page.keyboard.press('Delete')

  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await page.locator('#btn-confirm-cancel').click()
  expect(await queueIds(page)).toHaveLength(3)
})

test('Enter and Delete leave the editor alone while the Queue Manager is open', async ({ page }) => {
  await page.locator('#btn-open-queue-manager').click()
  await expect(page.locator('#queue-solitaire')).toHaveClass(/active/)

  await page.keyboard.press('Delete')
  await page.keyboard.press('Enter')

  await expect(page.locator('#queue-solitaire')).not.toHaveClass(/active/)
  expect(await queueIds(page)).toEqual(IMAGES.map((image) => image.id))
  expect(await page.evaluate(() => (window as any).__CENSOR_STATE__.activeId)).toBe(IMAGES[0].id)
  await expect(page.locator('#save-options-modal')).not.toHaveClass(/visible/)
})

test('holding Delete takes out only one picture', async ({ page }) => {
  await page.keyboard.down('Delete')
  await page.keyboard.down('Delete')
  await page.keyboard.down('Delete')
  await page.keyboard.up('Delete')

  await waitForActive(page, IMAGES[1].id)
  expect(await queueIds(page)).toEqual([IMAGES[1].id, IMAGES[2].id])
})

test('with no picture open, Enter opens the first one instead of Save', async ({ page }) => {
  await page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    state.activeId = null
    state.pendingActiveId = null
  })
  await page.evaluate(() => {
    const w = window as any
    w.__loaded = []
    const original = w.loadCanvasImage
    w.loadCanvasImage = (id: number) => { w.__loaded.push(id); return original(id) }
  })

  await page.keyboard.press('Enter')

  expect(await page.evaluate(() => (window as any).__loaded)).toEqual([IMAGES[0].id])
  await expect(page.locator('#save-options-modal')).not.toHaveClass(/visible/)
})

test('at the end of the loaded part Enter loads more before offering Save', async ({ page }) => {
  await page.keyboard.press('Enter')
  await waitForActive(page, IMAGES[1].id)
  await page.keyboard.press('Enter')
  await waitForActive(page, IMAGES[2].id)
  await page.evaluate((firstId) => {
    const w = window as any
    w.__CENSOR_STATE__.tokenQueueSource = { selectionToken: 't', hasMore: true, nextOffset: 3 }
    w.loadNextTokenQueueWindow = async () => ({ images: [], items: [{ id: firstId }] })
  }, IMAGES[0].id)

  await page.keyboard.press('Enter')

  await waitForActive(page, IMAGES[0].id)
  await expect(page.locator('#save-options-modal')).not.toHaveClass(/visible/)
  await page.evaluate(() => { (window as any).__CENSOR_STATE__.tokenQueueSource = null })
})

test('on the Review tab the last approved picture leads to Save, not another detect', async ({ page }) => {
  await page.keyboard.press('Enter')
  await waitForActive(page, IMAGES[1].id)
  await page.keyboard.press('Enter')
  await waitForActive(page, IMAGES[2].id)
  await page.locator('.censor-tab[data-censor-tab="review"]').click()
  await page.evaluate(() => {
    const w = window as any
    w.__reviewCalls = []
    w.censorReviewDetect = () => w.__reviewCalls.push('detect')
    w.censorReviewApprove = () => w.__reviewCalls.push('approve')
    const review = (0, eval)('CensorReviewState')
    review.detectedForId = null
    review.regions = []
    review.approvedId = w.__CENSOR_STATE__.activeId
  })

  await page.keyboard.press('Enter')

  await expect(page.locator('#save-options-modal')).toHaveClass(/visible/)
  expect(await page.evaluate(() => (window as any).__reviewCalls)).toEqual([])
})

for (const outcome of ['still loading', 'failing'] as const) {
  test(`at the end of the loaded part, a load that is ${outcome} says so and does not offer Save`, async ({ page }) => {
    await page.keyboard.press('Enter')
    await waitForActive(page, IMAGES[1].id)
    await page.keyboard.press('Enter')
    await waitForActive(page, IMAGES[2].id)
    await page.evaluate((mode) => {
      const w = window as any
      w.__CENSOR_STATE__.tokenQueueSource = { selectionToken: 't', hasMore: true, nextOffset: 3, loading: mode === 'still loading' }
      w.loadNextTokenQueueWindow = async () => { throw new Error('network down') }
    }, outcome)

    await page.keyboard.press('Enter')

    const toast = page.locator('.toast').last()
    await expect(toast).toContainText(outcome === 'still loading' ? 'Still loading more pictures' : 'network down')
    await expect(page.locator('#save-options-modal')).not.toHaveClass(/visible/)
    expect(await page.evaluate(() => (window as any).__CENSOR_STATE__.activeId)).toBe(IMAGES[2].id)
    await page.evaluate(() => { (window as any).__CENSOR_STATE__.tokenQueueSource = null })
  })
}
