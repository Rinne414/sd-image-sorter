import { expect, test, type Page } from '../fixtures/click-ledger'

const IMAGE_COUNT = 6221
const IMAGE_ID_BASE = 700000
const STANDARD_GRID_COUNT = 95
const FORWARD_RATIO = 0.82
const REVERSE_RATIO = 0.35
const MAX_RENDERED_CARDS = 160

type GalleryMode = 'grid' | 'large' | 'waterfall'

type DesktopViewport = {
  width: number
  height: number
}

type GalleryWindow = Window & {
  App: {
    AppState: {
      images: Array<Record<string, number | string>>
      isLoading: boolean
      viewMode: string
    }
  }
  Gallery: {
    _getScrollContainer: () => HTMLElement
    _getScrollViewportRect: (scrollContainer: HTMLElement) => DOMRect
    _isViewportScrollContainer: (scrollContainer: HTMLElement) => boolean
    setImages: (images: Array<Record<string, number | string>>) => void
    virtualList: {
      isVirtual: () => boolean
    }
  }
  UiScale: {
    get: () => number
  }
  VirtualList?: unknown
  WaterfallVirtualList?: unknown
}

type ViewportCoverage = {
  bottomBlank: number
  firstIntersectingId: string | null
  firstIntersectingIndex: number | null
  firstIntersectingRatio: number | null
  horizontalOverflow: number
  maxCardHeight: number
  intersectingCount: number
  renderedCount: number
  renderedUniqueCount: number
  scrollRatio: number
  topBlank: number
}

type RuntimeProblems = {
  console: string[]
  page: string[]
  requests: string[]
}

function observeRuntimeProblems(page: Page): RuntimeProblems {
  const problems: RuntimeProblems = { console: [], page: [], requests: [] }
  const isSameOriginAppRequest = (rawUrl: string): boolean => {
    const requestUrl = new URL(rawUrl)
    return requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost'
  }

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.console.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => problems.page.push(error.message))
  page.on('requestfailed', (request) => {
    if (isSameOriginAppRequest(request.url())) {
      problems.requests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`)
    }
  })
  page.on('response', (response) => {
    if (response.status() >= 400 && isSameOriginAppRequest(response.url())) {
      problems.requests.push(`${response.status()} ${response.url()}`)
    }
  })

  return problems
}

async function openGallery(page: Page, viewport: DesktopViewport): Promise<void> {
  await page.setViewportSize(viewport)
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('gallery-view-mode', 'grid')
  })
  await page.route('**/api/image-thumbnail/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/images?**', async (route) => {
    await route.fulfill({
      json: {
        images: [],
        total: 0,
        has_more: false,
        next_cursor: null,
        next_offset: 0,
      },
    })
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const currentWindow = window as unknown as GalleryWindow
    return typeof currentWindow.Gallery?.setImages === 'function'
      && currentWindow.App.AppState.isLoading === false
      && typeof currentWindow.VirtualList === 'function'
      && typeof currentWindow.WaterfallVirtualList === 'function'
  })
  await expect(page.locator('#view-gallery')).toBeVisible()
  const expectedScale = viewport.width >= 2350 ? 1.3 : 1
  await expect.poll(() => page.evaluate(() => (window as unknown as GalleryWindow).UiScale.get())).toBe(expectedScale)
}

async function seedLargeGallery(page: Page, mode: GalleryMode): Promise<void> {
  if (mode === 'grid') {
    await page.evaluate(({ count, idBase }) => {
      const currentWindow = window as unknown as GalleryWindow
      const images = Array.from({ length: count }, (_unused, index) => ({
        id: idBase + index,
        filename: `standard-grid-${idBase + index}.png`,
        generator: 'webui',
        width: 512,
        height: 512,
        file_size: 1024 + index,
      }))
      currentWindow.App.AppState.images = images
      currentWindow.Gallery.setImages(images)
    }, { count: STANDARD_GRID_COUNT, idBase: IMAGE_ID_BASE })
    await expect.poll(async () => page.locator('#gallery-grid .gallery-item[data-id]').count()).toBe(STANDARD_GRID_COUNT)
    await page.evaluate(() => {
      const mainContent = document.getElementById('main-content')
      if (!mainContent) throw new Error('Expected #main-content before Gallery virtualization')
      const scrollTrap = document.createElement('div')
      scrollTrap.id = 'gallery-scroll-container-trap'
      scrollTrap.style.cssText = 'height: 1px; transform: translateY(2000px); pointer-events: none;'
      mainContent.appendChild(scrollTrap)
    })
  }

  await page.evaluate(({ count, idBase, viewMode }) => {
    const currentWindow = window as unknown as GalleryWindow
    const images = Array.from({ length: count }, (_unused, index) => ({
      id: idBase + index,
      filename: `virtual-scroll-${idBase + index}.png`,
      generator: 'webui',
      width: 512 + (index % 3) * 128,
      height: 512 + (index % 5) * 96,
      file_size: 1024 + index,
    }))
    currentWindow.App.AppState.viewMode = viewMode
    currentWindow.App.AppState.images = images
    currentWindow.Gallery.setImages(images)
    document.getElementById('gallery-scroll-container-trap')?.remove()
  }, { count: IMAGE_COUNT, idBase: IMAGE_ID_BASE, viewMode: mode })

  await expect(page.locator('#gallery-grid')).toHaveClass(/virtual-scroll/)
  await expect.poll(async () => page.locator('#gallery-grid .gallery-item[data-id]').count()).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(() => {
    return (window as unknown as GalleryWindow).Gallery.virtualList.isVirtual()
  })).toBe(true)
}

async function jumpToRatio(page: Page, ratio: number): Promise<void> {
  await page.evaluate(async (targetRatio) => {
    const currentWindow = window as unknown as GalleryWindow
    const scrollContainer = currentWindow.Gallery._getScrollContainer()
    const isViewportScroll = currentWindow.Gallery._isViewportScrollContainer(scrollContainer)
    const maxScrollTop = isViewportScroll
      ? document.documentElement.scrollHeight - window.innerHeight
      : scrollContainer.scrollHeight - scrollContainer.clientHeight
    const targetScrollTop = maxScrollTop * targetRatio
    if (isViewportScroll) {
      window.scrollTo({ top: targetScrollTop, left: 0, behavior: 'instant' })
    } else {
      scrollContainer.scrollTop = targetScrollTop
      scrollContainer.dispatchEvent(new Event('scroll'))
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }, ratio)
}

async function measureCurrentCoverage(page: Page): Promise<ViewportCoverage> {
  return await page.evaluate((itemCount) => {
    const currentWindow = window as unknown as GalleryWindow
    const scrollContainer = currentWindow.Gallery._getScrollContainer()
    const isViewportScroll = currentWindow.Gallery._isViewportScrollContainer(scrollContainer)
    const maxScrollTop = isViewportScroll
      ? document.documentElement.scrollHeight - window.innerHeight
      : scrollContainer.scrollHeight - scrollContainer.clientHeight
    const viewportRect = currentWindow.Gallery._getScrollViewportRect(scrollContainer)
    const renderedCards = Array.from(document.querySelectorAll<HTMLElement>('#gallery-grid .gallery-item[data-id]'))
    const intersectingCards = renderedCards.filter((card) => {
      const rect = card.getBoundingClientRect()
      return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
    })
    const intersectingRects = intersectingCards.map((card) => card.getBoundingClientRect())
    const renderedIndices = renderedCards.map((card) => Number(card.dataset.virtualIndex))
    const firstIntersectingIndex = intersectingCards.length > 0
      ? Math.min(...intersectingCards.map((card) => Number(card.dataset.virtualIndex)))
      : null
    const firstIntersectingCard = firstIntersectingIndex == null
      ? null
      : intersectingCards.find((card) => Number(card.dataset.virtualIndex) === firstIntersectingIndex) || null
    const maxCardHeight = intersectingRects.length > 0
      ? Math.max(...intersectingRects.map((rect) => rect.height))
      : 0

    return {
      bottomBlank: intersectingRects.length > 0
        ? Math.max(0, viewportRect.bottom - Math.max(...intersectingRects.map((rect) => rect.bottom)))
        : viewportRect.height,
      firstIntersectingId: firstIntersectingCard?.dataset.id || null,
      firstIntersectingIndex,
      firstIntersectingRatio: firstIntersectingIndex == null ? null : firstIntersectingIndex / itemCount,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      intersectingCount: intersectingCards.length,
      maxCardHeight,
      renderedCount: renderedCards.length,
      renderedUniqueCount: new Set(renderedIndices).size,
      scrollRatio: maxScrollTop > 0
        ? (isViewportScroll ? window.scrollY : scrollContainer.scrollTop) / maxScrollTop
        : 0,
      topBlank: intersectingRects.length > 0
        ? Math.max(0, Math.min(...intersectingRects.map((rect) => rect.top)) - viewportRect.top)
        : viewportRect.height,
    }
  }, IMAGE_COUNT)
}

async function jumpAndMeasure(page: Page, ratio: number): Promise<ViewportCoverage> {
  await jumpToRatio(page, ratio)
  return await measureCurrentCoverage(page)
}

function assertCoverage(coverage: ViewportCoverage, targetRatio: number): void {
  expect(coverage.scrollRatio).toBeGreaterThan(targetRatio - 0.03)
  expect(coverage.scrollRatio).toBeLessThan(targetRatio + 0.03)
  expect(coverage.renderedCount).toBeGreaterThan(0)
  expect(coverage.renderedCount).toBeLessThan(MAX_RENDERED_CARDS)
  expect(coverage.renderedUniqueCount).toBe(coverage.renderedCount)
  expect(coverage.intersectingCount).toBeGreaterThan(0)
  expect(coverage.firstIntersectingIndex).not.toBeNull()
  expect(coverage.firstIntersectingRatio).not.toBeNull()
  expect(Math.abs((coverage.firstIntersectingRatio as number) - targetRatio)).toBeLessThan(0.08)
  expect(Number(coverage.firstIntersectingId)).toBe(IMAGE_ID_BASE + (coverage.firstIntersectingIndex as number))
  expect(coverage.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(coverage.topBlank).toBeLessThanOrEqual(coverage.maxCardHeight + 32)
  expect(coverage.bottomBlank).toBeLessThanOrEqual(coverage.maxCardHeight + 32)
}

async function verifyLongJumps(page: Page, viewport: DesktopViewport, mode: GalleryMode): Promise<void> {
  const runtimeProblems = observeRuntimeProblems(page)
  await openGallery(page, viewport)
  await seedLargeGallery(page, mode)

  const forward = await jumpAndMeasure(page, FORWARD_RATIO)
  assertCoverage(forward, FORWARD_RATIO)
  if (mode === 'grid' && viewport.width === 1366) {
    expect(forward.renderedCount).toBeLessThan(100)
  }
  await page.waitForTimeout(150)
  assertCoverage(await measureCurrentCoverage(page), FORWARD_RATIO)

  const reverse = await jumpAndMeasure(page, REVERSE_RATIO)
  assertCoverage(reverse, REVERSE_RATIO)
  await page.waitForTimeout(150)
  assertCoverage(await measureCurrentCoverage(page), REVERSE_RATIO)
  await page.waitForTimeout(750)
  assertCoverage(await measureCurrentCoverage(page), REVERSE_RATIO)
  expect((forward.firstIntersectingIndex as number) - (reverse.firstIntersectingIndex as number))
    .toBeGreaterThan(IMAGE_COUNT * 0.35)
  expect(runtimeProblems.console).toEqual([])
  expect(runtimeProblems.page).toEqual([])
  expect(runtimeProblems.requests).toEqual([])
}

const gridViewports: DesktopViewport[] = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]

for (const viewport of gridViewports) {
  test(`6221-item grid stays aligned after long jumps at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await verifyLongJumps(page, viewport, 'grid')
  })
}

for (const mode of ['large', 'waterfall'] as const) {
  test(`6221-item ${mode} view stays aligned after long jumps at 2560x1440`, async ({ page }) => {
    await verifyLongJumps(page, { width: 2560, height: 1440 }, mode)
  })
}
