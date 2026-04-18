import { test, expect } from '@playwright/test'

const MIXED_MASK_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAjUlEQVR4nOXYsQ3AMBDDQJrw/it/VkhjOAGvVqFS0JoZyiRO4iRO4iRO4iRuv8icGAqLj5A4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4idt/OjBPkDiJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkzhvF7jtAUZuBIJ86O4rAAAAAElFTkSuQmCC'

async function getGalleryScrollState(page) {
  return page.evaluate(() => {
    const grid = document.getElementById('gallery-grid')
    if (!grid) return { scrollTop: 0, topVisibleId: null }

    const getScrollContainer = () => {
      let node = grid.parentElement
      while (node) {
        const style = window.getComputedStyle(node)
        const canScroll = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4
        if (canScroll) return node
        node = node.parentElement
      }

      return document.scrollingElement || document.documentElement
    }

    const scrollContainer = getScrollContainer()
    if (!grid || !scrollContainer) return { scrollTop: 0, topVisibleId: null }

    const scrollRect = scrollContainer.getBoundingClientRect()
    const items = Array.from(grid.querySelectorAll('.gallery-item'))

    let topVisibleItem = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const item of items) {
      const rect = item.getBoundingClientRect()
      if (rect.bottom <= scrollRect.top || rect.top >= scrollRect.bottom) continue

      const distance = Math.abs(rect.top - scrollRect.top)
      if (distance < bestDistance) {
        bestDistance = distance
        topVisibleItem = item
      }
    }

    return {
      scrollTop: scrollContainer.scrollTop,
      topVisibleId: topVisibleItem?.getAttribute('data-id') ?? null,
    }
  })
}

async function getVisibleGalleryRects(page, count = 4) {
  return page.evaluate((maxCount) => {
    const grid = document.getElementById('gallery-grid')
    if (!grid) return []

    return Array.from(grid.querySelectorAll('.gallery-item'))
      .slice(0, maxCount)
      .map((item) => {
        const rect = item.getBoundingClientRect()
        return {
          id: item.getAttribute('data-id'),
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        }
      })
  }, count)
}

async function getFilterModalLayout(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('#filter-modal .filter-modal-shell')
    const primary = document.querySelector('#filter-modal .filter-column-primary')
    const secondary = document.querySelector('#filter-modal .filter-column-secondary')
    const actions = document.querySelector('#filter-modal .filter-modal-actions')

    if (!modal || !primary || !secondary || !actions) {
      return null
    }

    const rect = (element) => {
      const box = element.getBoundingClientRect()
      return {
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        left: box.left,
        width: box.width,
        height: box.height,
      }
    }

    return {
      modal: rect(modal),
      primary: rect(primary),
      secondary: rect(secondary),
      actions: rect(actions),
    }
  })
}

async function getActiveCensorCanvasSnapshot(page) {
  return page.evaluate(() => {
    const noImage = document.getElementById('censor-no-image')
    const filename = document.getElementById('censor-filename')?.textContent?.trim()
    if (noImage && window.getComputedStyle(noImage).display !== 'none') {
      return null
    }
    if (!filename || filename === '-') {
      return null
    }

    const canvases = ['censor-canvas', 'censor-canvas-buffer']
      .map((id) => document.getElementById(id))
      .filter((canvas): canvas is HTMLCanvasElement => Boolean(canvas && canvas.width > 0))

    if (canvases.length === 0) {
      return null
    }

    const activeCanvas = canvases.find((canvas) => {
      const style = window.getComputedStyle(canvas)
      return style.opacity !== '0' && style.pointerEvents !== 'none'
    }) ?? canvases[0]

    return activeCanvas.toDataURL('image/png')
  })
}

function rectsOverlap(a, b) {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4
}

function normalizeImageSrc(src: string | null) {
  if (!src) return src
  return src.split('?')[0]
}

async function getImageFingerprint(page, src: string) {
  return page.evaluate(async (imageSrc) => {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error(`failed to load image: ${imageSrc}`))
      el.src = imageSrc
    })

    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('missing canvas context')
    }

    ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let checksum = 0
    for (let i = 0; i < data.length; i += 8) {
      checksum = (checksum * 131 + data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3] * 11) % 1000000007
    }

    return {
      width: canvas.width,
      height: canvas.height,
      checksum,
    }
  }, src)
}

const MOCK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#d9e2f2"/>
  <circle cx="32" cy="24" r="10" fill="#7a93b8"/>
  <rect x="14" y="40" width="36" height="10" rx="5" fill="#7a93b8"/>
</svg>
`.trim()

async function mockImageAsset(page, id: number) {
  const fulfillImage = async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: MOCK_IMAGE_SVG,
    })
  }

  await page.route(`**/api/image-thumbnail/${id}**`, fulfillImage)
  await page.route(`**/api/image-file/${id}**`, fulfillImage)
}

async function openView(page, view: string) {
  const desktopTab = page.locator(`.nav-tabs [data-view="${view}"]`).first()
  if (await desktopTab.count()) {
    const box = await desktopTab.boundingBox()
    if (box && box.width > 0 && box.height > 0) {
      await desktopTab.click({ force: true })
      return
    }
  }

  const mobileToggle = page.locator('#mobile-menu-toggle')
  if (await mobileToggle.isVisible().catch(() => false)) {
    await mobileToggle.click({ force: true })
    await expect(page.locator('#mobile-nav-overlay')).toHaveClass(/visible/)
    await page.locator(`#mobile-nav-overlay .mobile-nav-item[data-view="${view}"]`).evaluate((node: HTMLButtonElement) => node.click())
    return
  }

  throw new Error(`Could not find navigation entry for ${view}`)
}

async function openSortingSubView(page, subView: 'autosep' | 'manual') {
  await openView(page, 'sorting')
  await expect(page.locator('#view-sorting.active')).toBeVisible()

  const subTab = page.locator(`.sorting-sub-tab[data-sorting-sub="${subView}"]`)
  await subTab.click({ force: true })

  if (subView === 'autosep') {
    await expect(page.locator('#view-autosep')).toBeVisible()
  } else {
    await expect(page.locator('#view-manual')).toBeVisible()
  }
}

/**
 * Smoke Tests for SD Image Sorter
 *
 * These tests verify basic connectivity and critical paths.
 * Run these first to ensure the application is working.
 */

test.describe('Smoke Tests', () => {
  test('should load the main page', async ({ page }) => {
    await page.goto('/')

    // Verify the page title
    await expect(page).toHaveTitle(/SD Image Sorter/i)

    const hasPrimaryNavigation = (
      await page.locator('.nav-tabs').isVisible().catch(() => false)
    ) || (
      await page.locator('#mobile-menu-toggle').isVisible().catch(() => false)
    )
    expect(hasPrimaryNavigation).toBeTruthy()

    // Verify gallery view is loaded by default
    await expect(page.locator('#gallery-grid')).toBeVisible()
  })

  test('should have all navigation tabs', async ({ page }) => {
    await page.goto('/')

    const tabs = [
      'gallery',
      'reader',
      'censor',
      'similar',
      'promptlab',
      'artist',
      'sorting',
    ]

    const availableViews = new Set<string>()
    const desktopViews = await page.locator('.nav-tabs .nav-tab').evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          const box = node.getBoundingClientRect()
          return box.width > 0 && box.height > 0
        })
        .map((node) => node.getAttribute('data-view') || '')
        .filter(Boolean)
    )
    desktopViews.forEach((view) => availableViews.add(view))

    const mobileToggle = page.locator('#mobile-menu-toggle')
    if (await mobileToggle.isVisible().catch(() => false)) {
      await mobileToggle.click({ force: true })
      await expect(page.locator('#mobile-nav-overlay')).toHaveClass(/visible/)
      const mobileViews = await page.locator('#mobile-nav-overlay .mobile-nav-item').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-view') || '').filter(Boolean)
      )
      mobileViews.forEach((view) => availableViews.add(view))
      await page.keyboard.press('Escape')
    }

    for (const tab of tabs) {
      expect(availableViews.has(tab)).toBeTruthy()
    }
  })

  test('should navigate between views', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await openView(page, 'reader')
    await expect(page.locator('#reader-drop-zone')).toBeVisible()

    await openSortingSubView(page, 'autosep')
    await expect(page.locator('#autosep-destination')).toBeVisible()

    await openSortingSubView(page, 'manual')
    await expect(page.locator('#btn-start-sorting')).toBeVisible()

    await openView(page, 'censor')
    await expect(page.locator('#canvas-wrapper')).toBeVisible()

    await openView(page, 'promptlab')
    await expect(page.locator('.promptlab-tabs')).toBeVisible()

    await openView(page, 'similar')
    await expect(page.locator('#btn-similar-embed')).toBeVisible()

    await openView(page, 'artist')
    await expect(page.locator('#btn-identify-all')).toBeVisible()

    await openView(page, 'gallery')
    await expect(page.locator('#gallery-grid')).toBeVisible()
  })

  test('reader workspace should switch between metadata reader and obfuscation tool', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await openView(page, 'reader')
    await expect(page.locator('#view-reader.active')).toBeVisible()
    await expect(page.locator('#reader-tool-panel-reader')).toBeVisible()
    await expect(page.locator('#reader-tool-panel-obfuscation')).toBeHidden()

    await page.locator('#reader-tool-tab-obfuscation').click()
    await expect(page.locator('#reader-tool-panel-obfuscation')).toBeVisible()
    await expect(page.locator('#obfuscate-btn-encode')).toBeVisible()
    await expect(page.locator('#obfuscate-drop-zone')).toBeVisible()

    await page.locator('#reader-tool-tab-reader').click()
    await expect(page.locator('#reader-tool-panel-reader')).toBeVisible()
  })

  test('obfuscation workspace should round-trip and expose copy flow', async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as any).__clipboardWrites = 0
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          write: async (items: unknown[]) => {
            ;(window as any).__clipboardWrites += items.length
          },
        },
      })
      ;(window as any).ClipboardItem = class ClipboardItem {
        constructor(public items: Record<string, Blob>) {}
      }
    })

    const samplePngBuffer = Buffer.from(MIXED_MASK_DATA_URL.split(',')[1], 'base64')

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await openView(page, 'reader')
    await page.locator('#reader-tool-tab-obfuscation').click()
    await expect(page.locator('#reader-tool-panel-obfuscation')).toBeVisible()

    await page.locator('#obfuscate-file-input').setInputFiles({
      name: 'obfuscate-sample.png',
      mimeType: 'image/png',
      buffer: samplePngBuffer,
    })

    const queueItem = page.locator('.obfuscate-item').first()
    await expect(queueItem).toBeVisible()

    const originalFingerprint = await getImageFingerprint(page, MIXED_MASK_DATA_URL)

    await page.locator('#obfuscate-btn-encode').click()
    await expect(queueItem).toHaveClass(/done/)

    const encodedSrc = await queueItem.locator('.obfuscate-thumb.result-thumb').getAttribute('src')
    expect(encodedSrc).toBeTruthy()
    const encodedFingerprint = await getImageFingerprint(page, String(encodedSrc))
    expect(encodedFingerprint.checksum).not.toBe(originalFingerprint.checksum)

    const copyButton = queueItem.locator('.obfuscate-copy')
    const downloadButton = queueItem.locator('.obfuscate-download')
    await expect(copyButton).toBeEnabled()
    await expect(downloadButton).toBeEnabled()

    await copyButton.click()
    await expect.poll(async () => {
      return await page.evaluate(() => (window as any).__clipboardWrites || 0)
    }).toBeGreaterThan(0)

    await page.locator('#obfuscate-btn-decode').click()
    await expect(queueItem).toHaveClass(/done/)

    const decodedSrc = await queueItem.locator('.obfuscate-thumb.result-thumb').getAttribute('src')
    expect(decodedSrc).toBeTruthy()
    const decodedFingerprint = await getImageFingerprint(page, String(decodedSrc))
    expect(decodedFingerprint).toEqual(originalFingerprint)

    await page.locator('#obfuscate-compat-mode').selectOption('small_tomato')
    await expect(page.locator('#obfuscate-password')).toBeHidden()
  })

  test('gallery sort reverse should support aesthetic score', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#gallery-sort').selectOption('aesthetic')
    await expect(page.locator('#gallery-sort')).toHaveValue('aesthetic')

    await expect.poll(async () => {
      return await page.evaluate(() => (window as any).App?.AppState?.filters?.sortBy ?? null)
    }).toBe('aesthetic')

    await page.locator('#sort-reverse-btn').click()
    await expect.poll(async () => {
      return await page.evaluate(() => (window as any).App?.AppState?.filters?.sortBy ?? null)
    }).toBe('aesthetic_asc')
    await expect(page.locator('#sort-reverse-btn')).toHaveClass(/active/)
  })

  test('should switch gallery views and open filter/library flows', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    const waitForLibraryResults = async () => {
      await expect.poll(
        async () => {
          const libraryContent = page.locator('#library-content')

          if (await libraryContent.locator('.library-status-error, .library-feedback.error').count()) {
            return 'error'
          }

          if (await libraryContent.locator('.library-tag').count()) {
            return 'items'
          }

          if (await libraryContent.locator('.empty-state-text').count()) {
            return 'empty'
          }

          return 'loading'
        },
        { timeout: 15000, message: 'Expected library content or an empty-state after opening a library tab' }
      ).toMatch(/^(items|empty)$/)
    }

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const galleryGrid = page.locator('#gallery-grid')
    await expect(galleryGrid).toBeVisible()

    await page.evaluate(() => {
      const grid = document.getElementById('gallery-grid')
      if (!grid) return

      let node = grid.parentElement
      while (node) {
        const style = window.getComputedStyle(node)
        const canScroll = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4
        if (canScroll) {
          node.scrollTop = 900
          return
        }
        node = node.parentElement
      }

      const scrollContainer = document.scrollingElement || document.documentElement
      if (scrollContainer) {
        scrollContainer.scrollTop = 900
      }
    })

    const initialScrollState = await getGalleryScrollState(page)

    const viewModes = [
      { mode: 'large', className: /large/ },
      { mode: 'waterfall', className: /waterfall/ },
      { mode: 'grid', className: /gallery-grid/ },
    ]

    for (const { mode, className } of viewModes) {
      await page.locator(`.view-btn[data-size="${mode}"]`).click()
      await expect(galleryGrid).toHaveClass(className)

      const firstItem = page.locator('#gallery-grid .gallery-item').first()
      if (await firstItem.count()) {
        await expect(firstItem).toBeVisible()
        const box = await firstItem.boundingBox()
        const viewport = page.viewportSize()

        expect(box).not.toBeNull()
        expect(viewport).not.toBeNull()

        if (box && viewport) {
          expect(box.width).toBeGreaterThan(0)
          expect(box.width).toBeLessThan(viewport.width)
          expect(box.height).toBeGreaterThan(0)
          expect(box.height).toBeLessThan(viewport.height)
        }
      }

      const scrollState = await getGalleryScrollState(page)
      if (initialScrollState.scrollTop > 0) {
        expect(scrollState.scrollTop).toBeGreaterThan(120)
        expect(scrollState.topVisibleId).toBe(initialScrollState.topVisibleId)
      }
    }

    await page.locator('#btn-open-filters').click()
    await expect(page.locator('#filter-modal.visible')).toBeVisible()
    await expect(page.locator('#filter-modal-selection-summary')).toBeVisible()
    await expect(page.locator('#modal-generator-filters')).toBeVisible()
    await expect(page.locator('#modal-rating-filters')).toBeVisible()
    await expect(page.locator('#btn-open-library-from-filter')).toBeVisible()

    await page.locator('#btn-open-library-from-filter').click()
    await expect(page.locator('#tags-library-modal.visible')).toBeVisible()

    const libraryError = page.locator('#library-content .library-status-error, #library-content .library-feedback.error')

    await page.locator('#library-tab-prompts').click()
    await waitForLibraryResults()
    await expect(libraryError).toHaveCount(0)

    await page.locator('#library-tab-tags').click()
    await waitForLibraryResults()
    await expect(libraryError).toHaveCount(0)

    expect(pageErrors).toEqual([])
  })

  test('should keep large view selection stable without overlapping cards', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('.view-btn[data-size="large"]').click()
    await expect(page.locator('#gallery-grid')).toHaveClass(/large/)

    const beforeRects = await getVisibleGalleryRects(page, 3)
    expect(beforeRects.length).toBeGreaterThanOrEqual(2)

    await page.locator('#btn-toggle-select').click()
    await page.locator('#gallery-grid .gallery-item').nth(0).click()
    await page.locator('#gallery-grid .gallery-item').nth(1).click()

    const afterRects = await getVisibleGalleryRects(page, 3)
    expect(afterRects.length).toBeGreaterThanOrEqual(2)

    for (let i = 0; i < afterRects.length; i++) {
      expect(afterRects[i].width).toBeGreaterThan(0)
      expect(afterRects[i].height).toBeGreaterThan(0)

      if (beforeRects[i]) {
        expect(Math.abs(afterRects[i].width - beforeRects[i].width)).toBeLessThan(2)
        expect(Math.abs(afterRects[i].height - beforeRects[i].height)).toBeLessThan(2)
      }

      for (let j = i + 1; j < afterRects.length; j++) {
        expect(rectsOverlap(afterRects[i], afterRects[j])).toBeFalsy()
      }
    }
  })

  test('should list camie, pixai, and ToriiGate in the tagger modal', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#btn-tag').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()

    const camieOption = page.locator('#tag-model-select option[value="camie-tagger-v2"]')
    const pixaiOption = page.locator('#tag-model-select option[value="pixai-tagger-v0.9"]')
    const toriiGateOption = page.locator('#tag-model-select option[value="toriigate-0.5"]')

    await expect(camieOption).toHaveCount(1)
    await expect(pixaiOption).toHaveCount(1)
    await expect(toriiGateOption).toHaveCount(1)
    await expect(pixaiOption).toBeEnabled()
    await expect(toriiGateOption).toBeEnabled()

    await page.locator('#tag-model-select').selectOption('camie-tagger-v2')
    await expect(page.locator('#tag-model-help')).toContainText(/newer danbooru-era tag space|modern tag coverage|tagger\.desc|Q\d\/5/i)
    await expect(page.locator('#tag-threshold')).toHaveValue('0.62')
    await expect(page.locator('#tag-character-threshold')).toHaveValue('0.78')

    await page.locator('#tag-model-select').selectOption('pixai-tagger-v0.9')
    await expect(page.locator('#tag-model-help')).toContainText(/pixai v0.9 onnx export|newer tag space|rating fallback|tagger\.desc|Q\d\/5/i)
    await expect(page.locator('#tag-threshold')).toHaveValue('0.3')
    await expect(page.locator('#tag-character-threshold')).toHaveValue('0.85')

    await page.locator('#tag-model-select').selectOption('toriigate-0.5')
    await expect(page.locator('#tag-model-help')).toContainText(/multimodal caption tagger|VLM|tagger\.desc/i)
    await expect(page.locator('#tag-threshold-section')).toBeHidden()
    await expect(page.locator('#tag-threshold-note')).toBeVisible()
    await expect(page.locator('#tag-threshold-note')).toContainText(/does not use WD14 thresholds|generates tags directly/i)
    await expect(page.locator('#tag-runtime-provider-chip')).toContainText(/PyTorch|Provider unknown|providerUnknown/i)
  })

  test('should keep canonical WD model names in the tagger modal', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#btn-tag').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()

    const optionTexts = await page.locator('#tag-model-select option').allTextContents()

    expect(optionTexts.some((text) => text.includes('wd-eva02-large-tagger-v3'))).toBeTruthy()
    expect(optionTexts.some((text) => /Best Quality/i.test(text))).toBeFalsy()
    await expect(page.locator('#tag-model-select')).toHaveValue('wd-swinv2-tagger-v3')
    await expect(page.locator('#system-info-panel')).toBeVisible()
    await expect(page.locator('#system-info-content')).toBeVisible()
    await expect(page.locator('#tagger-model-panel')).toBeVisible()
    await expect(page.locator('#tag-model-badges')).toBeVisible()
    await expect(page.locator('#tag-runtime-mode-chip')).toBeVisible()
    await expect(page.locator('#tag-runtime-provider-chip')).toBeVisible()
    await expect(page.locator('#tag-runtime-chunk-chip')).toBeVisible()
    await expect(page.locator('#tag-batch-recommendation')).toContainText(/Recommended (chunk|batch) size|chunkHelp/i)
    await expect(page.locator('#tag-runtime-summary')).toContainText(/Recommended (chunk|batch)|CPU Safe Mode|adaptive GPU mode|fast path|tagger\.runtime|tagger\.chunkHelp/i)
  })

  test('should keep risky tagger models in adaptive runtime mode by default', async ({ page }) => {
    await page.route('**/api/system-info', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          system_info: {
            total_ram_gb: 64,
            available_ram_gb: 48,
            gpu_name: 'NVIDIA GeForce RTX 4090',
            gpu_vram_total_mb: 24576,
            gpu_vram_available_mb: 22000,
            onnx_providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'],
          },
          recommendation: {
            recommended_batch_size: 12,
            recommended_cpu_chunk_size: 32,
            recommended_use_gpu: true,
            recommended_session_refresh_interval: 180,
            risk_level: 'low',
            message: 'Sufficient VRAM for aggressive batched GPU inference.',
          },
        }),
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#btn-tag').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()

    await expect(page.locator('#tag-runtime-summary')).toContainText(/Recommended chunk|Adaptive GPU mode|recommended fast path|tagger\.runtime|tagger\.chunkHelp/i)

    await page.locator('#tag-model-select').selectOption('wd-eva02-large-tagger-v3')

    await expect(page.locator('#tag-use-gpu')).toBeChecked()
    await expect(page.locator('#tag-use-gpu')).toBeEnabled()
    await expect(page.locator('#tag-provider-chip')).toContainText(/CUDA|Provider unknown|providerUnknown/i)
    await expect(page.locator('#tag-runtime-provider-chip')).toContainText(/CUDA|TensorRT|Provider unknown|providerUnknown/i)
    await expect(page.locator('#tag-runtime-summary')).toContainText(/Adaptive GPU mode|recommended fast path|Recommended chunk|tagger\.runtime|tagger\.chunkHelp/i)
    await expect(page.locator('#tag-model-help')).toContainText(/adaptive runtime limits|tagger\.|Q\d\/5/i)
    await expect(page.locator('#tag-gpu-help')).toContainText(/Adaptive runtime is active|gpuHelp/i)

    await page.locator('#tag-model-select').selectOption('custom')
    await expect(page.locator('#custom-model-group')).toBeVisible()
    await expect(page.locator('#custom-tags-group')).toBeVisible()
    await expect(page.locator('#tag-runtime-summary')).toContainText(/CPU Safe Mode|tagger\.runtime|Custom model/i)
    await expect(page.locator('#tag-use-gpu')).not.toBeChecked()
    await expect(page.locator('#tag-use-gpu')).toBeEnabled()
  })

  test('should require confirmation before starting Max Quality on risky GPU runtime', async ({ page }) => {
    let capturedPayload: Record<string, unknown> | null = null

    await page.route('**/api/system-info', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          system_info: {
            total_ram_gb: 64,
            available_ram_gb: 48,
            gpu_name: 'NVIDIA GeForce RTX 4090',
            gpu_vram_total_mb: 24576,
            gpu_vram_available_mb: 22000,
            onnx_providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'],
          },
          recommendation: {
            recommended_batch_size: 12,
            recommended_cpu_chunk_size: 32,
            recommended_use_gpu: true,
            recommended_session_refresh_interval: 180,
            risk_level: 'low',
            message: 'Sufficient VRAM for aggressive batched GPU inference.',
          },
        }),
      })
    })

    await page.route('**/api/tag/start', async (route) => {
      capturedPayload = route.request().postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'started' }),
      })
    })

    await page.route('**/api/tag/progress', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'done',
          processed: 0,
          total: 0,
          tagged: 0,
          errors: 0,
          message: 'Tagging complete',
        }),
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#btn-tag').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()

    await page.locator('#tag-model-select').selectOption('wd-eva02-large-tagger-v3')
    await page.locator('#btn-start-tag').click()
    await expect(page.locator('#confirm-modal.visible')).toBeVisible()
    await page.locator('#btn-confirm-ok').click()

    await expect.poll(() => capturedPayload, {
      message: 'Expected the Max Quality tag start payload',
    }).not.toBeNull()

    expect(capturedPayload).toMatchObject({
      model_name: 'wd-eva02-large-tagger-v3',
      use_gpu: true,
      allow_unsafe_acceleration: true,
    })
  })

  test('should require explicit confirmation before a risky custom GPU tagger run', async ({ page }) => {
    let capturedPayload: Record<string, unknown> | null = null

    await page.route('**/api/system-info', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          system_info: {
            total_ram_gb: 64,
            available_ram_gb: 48,
            gpu_name: 'NVIDIA GeForce RTX 4090',
            gpu_vram_total_mb: 24576,
            gpu_vram_available_mb: 22000,
            torch_cuda_available: true,
            onnx_providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'],
          },
          recommendation: {
            recommended_batch_size: 12,
            recommended_cpu_chunk_size: 32,
            recommended_use_gpu: true,
            recommended_session_refresh_interval: 180,
            risk_level: 'low',
            message: 'Sufficient VRAM for aggressive batched GPU inference.',
          },
        }),
      })
    })

    await page.route('**/api/tag/start', async (route) => {
      capturedPayload = route.request().postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'started' }),
      })
    })

    await page.route('**/api/tag/progress', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'done',
          processed: 0,
          total: 0,
          tagged: 0,
          errors: 0,
          message: 'Tagging complete',
        }),
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#btn-tag').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()

    await page.locator('#tag-model-select').selectOption('custom')
    await page.locator('#tag-model-path').fill('C:/models/custom-model.onnx')
    await page.locator('#tag-tags-path').fill('C:/models/selected_tags.csv')
    await page.locator('#tag-runtime-advanced summary').click()
    await expect(page.locator('#tag-runtime-advanced')).toHaveAttribute('open', '')
    await page.locator('label:has(#tag-use-gpu) .checkbox-custom').click()
    await expect(page.locator('#tag-use-gpu')).toBeChecked()
    await expect(page.locator('#tag-gpu-help')).toContainText(/High-risk GPU|gpuHelpRiskyOverride|CPU Safe Mode|gpuHelpCustomCpu/i)

    await page.locator('#btn-start-tag').click()
    await expect(page.locator('#confirm-modal.visible')).toBeVisible()
    await page.locator('#btn-confirm-ok').click()

    await expect.poll(() => capturedPayload, {
      message: 'Expected the tag start payload after confirming risky custom GPU mode',
    }).not.toBeNull()

    expect(capturedPayload).toMatchObject({
      model_path: 'C:/models/custom-model.onnx',
      tags_path: 'C:/models/selected_tags.csv',
      use_gpu: true,
      allow_unsafe_acceleration: true,
    })
  })

  test('should keep tagger progress available in the background with stop and details', async ({ page }) => {
    let started = false
    let cancelRequested = 0
    let cancelProgressPolls = 0

    await page.route('**/api/tag/start', async (route) => {
      started = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'started' }),
      })
    })

    await page.route('**/api/tag/cancel', async (route) => {
      cancelRequested += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'cancelling', message: 'Cancellation requested' }),
      })
    })

    await page.route('**/api/tag/progress', async (route) => {
      if (!started) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'idle',
            processed: 0,
            total: 0,
            tagged: 0,
            errors: 0,
            message: '',
          }),
        })
        return
      }

      if (cancelRequested > 0) {
        cancelProgressPolls += 1
        if (cancelProgressPolls >= 2) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              status: 'cancelled',
              processed: 3,
              total: 10,
              tagged: 3,
              errors: 0,
              message: 'Tagging cancelled',
            }),
          })
          return
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'cancelling',
            processed: 3,
            total: 10,
            tagged: 3,
            errors: 0,
            message: 'Cancelling... (3/10)',
          }),
        })
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'running',
          processed: 3,
          total: 10,
          tagged: 3,
          errors: 0,
          message: '3/10 (3 tagged)',
        }),
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#btn-tag').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()
    await page.locator('#btn-start-tag').click()

    await expect(page.locator('#tag-progress-container')).toBeVisible()
    await page.locator('#btn-cancel-tag').click()

    await expect(page.locator('#tag-modal.visible')).toHaveCount(0)
    await expect(page.locator('#bg-tag-progress')).toBeVisible()
    await expect(page.locator('#bg-tag-progress-text')).toContainText(/3\/10|Preparing/i)

    await page.locator('#bg-tag-open').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()

    await page.locator('#btn-close-tag-modal').click()
    await expect(page.locator('#tag-modal.visible')).toHaveCount(0)
    await expect(page.locator('#bg-tag-progress')).toBeVisible()

    await page.locator('#bg-tag-cancel').click()
    await expect.poll(() => cancelRequested).toBe(1)
    await expect(page.locator('#bg-tag-progress-text')).toContainText(/Cancelling|取消/i)
    await expect(page.locator('#bg-tag-progress')).toBeHidden({ timeout: 10000 })
  })

  test('should downgrade a risky custom GPU tagger run to CPU Safe Mode when the user declines', async ({ page }) => {
    let capturedPayload: Record<string, unknown> | null = null

    await page.route('**/api/system-info', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          system_info: {
            total_ram_gb: 64,
            available_ram_gb: 48,
            gpu_name: 'NVIDIA GeForce RTX 4090',
            gpu_vram_total_mb: 24576,
            gpu_vram_available_mb: 22000,
            torch_cuda_available: true,
            onnx_providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'],
          },
          recommendation: {
            recommended_batch_size: 12,
            recommended_cpu_chunk_size: 32,
            recommended_use_gpu: true,
            recommended_session_refresh_interval: 180,
            risk_level: 'low',
            message: 'Sufficient VRAM for aggressive batched GPU inference.',
          },
        }),
      })
    })

    await page.route('**/api/tag/start', async (route) => {
      capturedPayload = route.request().postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'started' }),
      })
    })

    await page.route('**/api/tag/progress', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'done',
          processed: 0,
          total: 0,
          tagged: 0,
          errors: 0,
          message: 'Tagging complete',
        }),
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#btn-tag').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()

    await page.locator('#tag-model-select').selectOption('custom')
    await page.locator('#tag-model-path').fill('C:/models/custom-model.onnx')
    await page.locator('#tag-tags-path').fill('C:/models/selected_tags.csv')
    await page.locator('#tag-runtime-advanced summary').click()
    await expect(page.locator('#tag-runtime-advanced')).toHaveAttribute('open', '')
    await page.locator('label:has(#tag-use-gpu) .checkbox-custom').click()
    await expect(page.locator('#tag-use-gpu')).toBeChecked()
    await expect(page.locator('#tag-gpu-help')).toContainText(/High-risk GPU|gpuHelpRiskyOverride|CPU Safe Mode|gpuHelpCustomCpu/i)

    await page.locator('#btn-start-tag').click()
    await expect(page.locator('#confirm-modal.visible')).toBeVisible()
    await page.locator('#btn-confirm-cancel').click()

    await expect.poll(() => capturedPayload, {
      message: 'Expected the tag start payload after declining risky custom GPU mode',
    }).not.toBeNull()

    expect(capturedPayload).toMatchObject({
      model_path: 'C:/models/custom-model.onnx',
      tags_path: 'C:/models/selected_tags.csv',
      use_gpu: false,
      allow_unsafe_acceleration: false,
    })
    await expect(page.locator('#tag-use-gpu')).not.toBeChecked()
  })

  test('should only enable selection actions after at least one image is selected', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const selectionFab = page.locator('#selection-actions')
    await expect(selectionFab).toBeHidden()

    await page.locator('#btn-toggle-select').click()
    await expect(selectionFab).toBeVisible()
    await expect(page.locator('#btn-export-selected')).toBeDisabled()
    await expect(page.locator('#btn-send-to-censor')).toBeDisabled()

    const firstGalleryItem = page.locator('#gallery-grid .gallery-item').first()
    await expect(firstGalleryItem).toBeVisible()
    await firstGalleryItem.click()

    await expect(selectionFab).toBeVisible()
    await expect(page.locator('#btn-export-selected')).toBeEnabled()
    await expect(page.locator('#btn-send-to-censor')).toBeEnabled()

    await page.locator('#btn-toggle-select').click()
    await expect(selectionFab).toBeHidden()
  })

  test('should preview auto-separate matches for an active gallery filter', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const nonEmptyGenerator = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.gen-tab'))
        .map((tab) => ({
          gen: tab.getAttribute('data-gen'),
          count: Number(tab.querySelector('.gen-count')?.textContent || '0')
        }))

      return tabs.find((tab) => tab.gen && tab.gen !== 'all' && tab.count > 0)?.gen || null
    })

    expect(nonEmptyGenerator).not.toBeNull()
    await page.locator(`.gen-tab[data-gen="${nonEmptyGenerator}"]`).click()

    await openSortingSubView(page, 'autosep')

    await page.locator('#btn-preview-autosep').click()

    await expect.poll(async () => {
      const value = await page.locator('#autosep-preview .stat-number').textContent()
      return Number(value || '0')
    }, { timeout: 10000 }).toBeGreaterThan(0)

    await expect(page.locator('#autosep-preview-list .autosep-preview-item').first()).toBeVisible()
  })

  test('auto-separate should report partial move failures without lying about moved count', async ({ page }) => {
    await mockImageAsset(page, 1)

    await page.route('**/api/images?**', async (route) => {
      await route.fulfill({
        json: {
          images: [
            { id: 1, filename: 'partial-match.png', path: 'L:/Antigravitiy code/sd-image-sorter/test-data/partial-match.png' },
          ],
          total: 2,
          has_more: false,
        },
      })
    })

    await page.route('**/api/batch-move', async (route) => {
      await route.fulfill({
        json: {
          status: 'started',
          total: 2,
          count: 2,
        },
      })
    })

    await page.route('**/api/batch-move/progress', async (route) => {
      await route.fulfill({
        json: {
          status: 'done',
          current: 2,
          total: 2,
          moved: 1,
          errors: 1,
          message: 'Completed! Moved 1 images. 1 errors.',
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.evaluate(() => {
      window.App.AppState.filters.tags = ['partial_match']
      window.App.updateFilterSummary()
      window.invalidateAutoSepPreview?.()
    })

    await openSortingSubView(page, 'autosep')

    await page.locator('#btn-preview-autosep').click()
    await expect(page.locator('#autosep-preview .stat-number')).toHaveText('2')

    await page.locator('#autosep-destination').fill('L:\\Antigravitiy code\\sd-image-sorter\\.tmp_move_target')
    await page.locator('#btn-execute-autosep').click()
    await expect(page.locator('#confirm-modal.visible')).toBeVisible()
    await page.locator('#btn-confirm-ok').click()

    const warningToast = page.locator('.toast.warning').last()
    await expect(warningToast).toContainText('Moved 1 images')
    await expect(warningToast).toContainText('1 failed')
    await expect(page.locator('#autosep-preview .stat-number')).toHaveText('0')
  })

  test('auto-separate should surface start errors instead of polling a non-existent batch job', async ({ page }) => {
    await mockImageAsset(page, 1)

    await page.route('**/api/images?**', async (route) => {
      await route.fulfill({
        json: {
          images: [
            { id: 1, filename: 'too-many.png', path: 'L:/Antigravitiy code/sd-image-sorter/test-data/too-many.png' },
          ],
          total: 6000,
          has_more: false,
        },
      })
    })

    await page.route('**/api/batch-move', async (route) => {
      await route.fulfill({
        status: 400,
        json: {
          detail: 'Found 6000 images matching filters. Maximum allowed is 5000.',
        },
      })
    })

    let progressCalls = 0
    await page.route('**/api/batch-move/progress', async (route) => {
      progressCalls += 1
      await route.fulfill({
        json: {
          status: 'idle',
          current: 0,
          total: 0,
          moved: 0,
          errors: 0,
          message: '',
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.evaluate(() => {
      window.App.AppState.filters.tags = ['too_many']
      window.App.updateFilterSummary()
      window.invalidateAutoSepPreview?.()
    })

    await openSortingSubView(page, 'autosep')

    await page.locator('#btn-preview-autosep').click()
    await expect(page.locator('#autosep-preview .stat-number')).toHaveText('6000')

    await page.locator('#autosep-destination').fill('L:\\Antigravitiy code\\sd-image-sorter\\.tmp_move_target')
    await page.locator('#btn-execute-autosep').click()
    await expect(page.locator('#confirm-modal.visible')).toBeVisible()
    await page.locator('#btn-confirm-ok').click()

    const errorToast = page.locator('.toast.error').last()
    await expect(errorToast).toContainText('Maximum allowed is 5000')
    expect(progressCalls).toBeLessThanOrEqual(1)
    await expect(page.locator('#autosep-preview .stat-number')).toHaveText('6000')
  })

  test('should populate prompt lab tag set selector from API data', async ({ page }) => {
    await page.route('**/api/prompts/categories', async (route) => {
      await route.fulfill({
        json: {
          categories: {
            character: ['1girl'],
            outfit: ['dress'],
          },
        },
      })
    })

    await page.route('**/api/prompts/sets', async (route) => {
      await route.fulfill({
        json: {
          sets: [
            {
              id: 101,
              name: 'School Uniform Set',
              category: 'outfit',
              description: 'Mocked preset',
              members: [{ tag: 'school_uniform', category: 'outfit', weight: 1, required: true }],
              tags: [{ tag: 'school_uniform', weight: 1, required: true }],
            },
          ],
        },
      })
    })

    await page.route('**/api/prompts/exclusions', async (route) => {
      await route.fulfill({ json: { rules: [] } })
    })

    await page.route('**/api/prompts/presets', async (route) => {
      await route.fulfill({ json: { presets: [] } })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openView(page, 'promptlab')
    await expect(page.locator('#view-promptlab.active')).toBeVisible()

    await expect.poll(
      async () => {
        const optionTexts = await page.locator('#promptlab-set-select option').allTextContents()
        return optionTexts.some((text) => text.includes('School Uniform Set'))
      },
      { timeout: 10000 }
    ).toBeTruthy()
  })

  test('prompt lab should preserve runtime empty states instead of reverting to loading placeholders', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('promptlab-guide-seen', 'true')
    })

    await page.route('**/api/prompts/categories', async (route) => {
      await route.fulfill({ json: { categories: {} } })
    })

    await page.route('**/api/prompts/sets', async (route) => {
      await route.fulfill({ json: { sets: [] } })
    })

    await page.route('**/api/prompts/exclusions', async (route) => {
      await route.fulfill({ json: { rules: [] } })
    })

    await page.route('**/api/prompts/presets', async (route) => {
      await route.fulfill({ json: { presets: [] } })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openView(page, 'promptlab')
    await expect(page.locator('#view-promptlab.active')).toBeVisible()

    const categoriesEmpty = page.locator('#promptlab-categories .empty-state')
    const slotsEmpty = page.locator('#promptlab-slots .empty-state')
    const presetsEmpty = page.locator('#promptlab-presets .preset-empty')

    await expect(categoriesEmpty).toContainText('No categories loaded')
    await expect(slotsEmpty).toContainText('Load categories first')
    await expect(presetsEmpty).toContainText('Save your current configuration as a preset')

    await page.waitForTimeout(700)

    await expect(categoriesEmpty).toContainText('No categories loaded')
    await expect(categoriesEmpty).not.toContainText('Loading categories')
    await expect(slotsEmpty).toContainText('Load categories first')
    await expect(slotsEmpty).not.toContainText('Loading slots')
    await expect(presetsEmpty).toContainText('Save your current configuration as a preset')
  })

  test('prompt lab should send selected slots to generation API and render the returned prompt', async ({ page }) => {
    let receivedConfig: any = null

    await page.addInitScript(() => {
      localStorage.setItem('promptlab-guide-seen', 'true')
    })

    await page.route('**/api/prompts/categories', async (route) => {
      await route.fulfill({
        json: {
          categories: {
            style: ['cinematic_lighting'],
            pose: ['standing'],
          },
        },
      })
    })

    await page.route('**/api/prompts/sets', async (route) => {
      await route.fulfill({ json: { sets: [] } })
    })

    await page.route('**/api/prompts/exclusions', async (route) => {
      await route.fulfill({ json: { rules: [] } })
    })

    await page.route('**/api/prompts/presets', async (route) => {
      await route.fulfill({ json: { presets: [] } })
    })

    await page.route('**/api/prompts/generate', async (route) => {
      receivedConfig = route.request().postDataJSON()
      const selectedTags = Object.values(receivedConfig?.categories || {})
        .flatMap((category: any) => category.tags || [])

      await route.fulfill({
        json: {
          positive_prompt: selectedTags.join(', '),
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openView(page, 'promptlab')
    await expect(page.locator('#view-promptlab.active')).toBeVisible()
    // Switch to Random mode tab (default is Stats in the redesigned Prompt Lab)
    await page.locator('.promptlab-tab[data-mode="random"]').click()

    await page.locator('#promptlab-categories .cat-header').filter({ hasText: /style/i }).click()
    await page.locator('#promptlab-categories .cat-tag').filter({ hasText: 'cinematic_lighting' }).click()
    await page.locator('#promptlab-categories .cat-header').filter({ hasText: /pose/i }).click()
    await page.locator('#promptlab-categories .cat-tag').filter({ hasText: 'standing' }).click()
    await page.locator('#btn-promptlab-generate').click()

    await expect.poll(
      () => receivedConfig?.categories?.style?.tags?.[0] ?? null,
      { timeout: 10000 }
    ).toBe('cinematic_lighting')
    expect(receivedConfig?.categories?.pose?.tags).toEqual(['standing'])
    expect(receivedConfig?.quality_preset).toBe('none')
    expect(receivedConfig?.count_tag).toBe('')
    expect(receivedConfig?.include_negative).toBe(false)
    await expect(page.locator('#promptlab-output')).toHaveValue('cinematic_lighting, standing')
  })

  test('prompt lab should clear stale generated prompt when loading a preset', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('promptlab-guide-seen', 'true')
    })

    await page.route('**/api/prompts/categories', async (route) => {
      await route.fulfill({
        json: {
          categories: {
            style: ['cinematic_lighting'],
            pose: ['standing'],
            background: ['city_night'],
          },
        },
      })
    })

    await page.route('**/api/prompts/sets', async (route) => {
      await route.fulfill({ json: { sets: [] } })
    })

    await page.route('**/api/prompts/exclusions', async (route) => {
      await route.fulfill({ json: { rules: [] } })
    })

    await page.route('**/api/prompts/presets', async (route) => {
      await route.fulfill({
        json: {
          presets: [
            {
              id: 1,
              name: 'Night Preset',
              config: {
                slots: {
                  background: ['city_night'],
                },
                weights: {},
                locked: {},
              },
            },
          ],
        },
      })
    })

    await page.route('**/api/prompts/generate', async (route) => {
      const payload = route.request().postDataJSON()
      const selectedTags = Object.values(payload?.categories || {})
        .flatMap((category: any) => category.tags || [])

      await route.fulfill({
        json: {
          positive_prompt: selectedTags.join(', '),
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openView(page, 'promptlab')
    await expect(page.locator('#view-promptlab.active')).toBeVisible()
    // Switch to Random mode tab (default is Stats in the redesigned Prompt Lab)
    await page.locator('.promptlab-tab[data-mode="random"]').click()

    await page.locator('#promptlab-categories .cat-header').filter({ hasText: /style/i }).click()
    await page.locator('#promptlab-categories .cat-tag').filter({ hasText: 'cinematic_lighting' }).click()
    await page.locator('#promptlab-categories .cat-header').filter({ hasText: /pose/i }).click()
    await page.locator('#promptlab-categories .cat-tag').filter({ hasText: 'standing' }).click()
    await page.locator('#btn-promptlab-generate').click()

    await expect(page.locator('#promptlab-output')).toHaveValue('cinematic_lighting, standing')
    await expect(page.locator('#btn-promptlab-use-gallery')).toBeEnabled()
    await page.locator('#btn-promptlab-use-gallery').click()
    await expect(page.locator('#view-gallery.active')).toBeVisible()
    await expect(page.locator('#summary-prompt')).toContainText('cinematic_lighting, standing')

    await openView(page, 'promptlab')
    await expect(page.locator('#view-promptlab.active')).toBeVisible()
    await page.locator('.promptlab-tab[data-mode="random"]').click()

    await page.locator('.btn-preset-load[data-id="1"]').click()
    await expect(page.locator('#promptlab-output')).toHaveValue('')
    await expect(page.locator('#btn-promptlab-use-gallery')).toBeDisabled()

    await page.locator('#btn-promptlab-generate').click()
    await expect(page.locator('#promptlab-output')).toHaveValue('city_night')

    await page.locator('#btn-promptlab-use-gallery').click()
    await expect(page.locator('#view-gallery.active')).toBeVisible()
    await expect(page.locator('#summary-prompt')).toContainText('city_night')
  })

  test('prompt lab validate should respect violations returned by the backend contract', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('promptlab-guide-seen', 'true')
    })

    await page.route('**/api/prompts/categories', async (route) => {
      await route.fulfill({
        json: {
          categories: {
            outfit: ['school_uniform'],
          },
        },
      })
    })

    await page.route('**/api/prompts/sets', async (route) => {
      await route.fulfill({ json: { sets: [] } })
    })

    await page.route('**/api/prompts/exclusions', async (route) => {
      await route.fulfill({ json: { rules: [] } })
    })

    await page.route('**/api/prompts/presets', async (route) => {
      await route.fulfill({ json: { presets: [] } })
    })

    await page.route('**/api/prompts/validate', async (route) => {
      await route.fulfill({
        json: {
          valid: false,
          violations: [
            {
              rule: 'No Uniform Clash',
              conflicting_tags: ['school_uniform'],
            },
          ],
          suggestions: [],
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openView(page, 'promptlab')
    await expect(page.locator('#view-promptlab.active')).toBeVisible()
    await page.locator('.promptlab-tab[data-mode="random"]').click()

    await page.locator('#promptlab-categories .cat-header').filter({ hasText: /outfit/i }).click()
    await page.locator('#promptlab-categories .cat-tag').filter({ hasText: 'school_uniform' }).click()
    await page.locator('#btn-promptlab-validate').click()

    await expect(page.locator('#toast-container .toast.error .toast-message').last()).toContainText('Found 1 conflict(s)')
  })

  test('artist filter should sync into gallery summary and clear cleanly', async ({ page }) => {
    await page.route('**/api/artists/stats', async (route) => {
      await route.fulfill({
        json: {
          total_images: 10,
          identified_images: 4,
          undefined_count: 1,
          artist_counts: {
            mock_artist: 3,
          },
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openView(page, 'artist')
    await expect(page.locator('#view-artist.active')).toBeVisible()

    const artistGuideClose = page.locator('#artist-first-use-guide [data-guide-close]')
    if (await artistGuideClose.count()) {
      await artistGuideClose.click()
    }

    const artistCard = page.locator('#artist-results-grid .artist-card').first()
    await expect(artistCard).toBeVisible()
    await artistCard.click()

    await page.locator('#btn-filter-by-artist').click()
    await expect(page.locator('#view-gallery.active')).toBeVisible()
    await expect(page.locator('#artist-filter-row')).toBeVisible()
    await expect(page.locator('#summary-artist')).toContainText('Mock Artist')

    await page.locator('#btn-clear-artist').click()
    await expect(page.locator('#artist-filter-row')).toBeHidden()
  })

  test('artist identification should send the selected model source and local path', async ({ page }) => {
    let identifyPayload: any = null

    await page.addInitScript(() => {
      localStorage.setItem('artist-guide-seen', 'true')
    })

    await page.route('**/api/artists/stats', async (route) => {
      await route.fulfill({
        json: {
          total_images: 10,
          identified_images: 0,
          undefined_count: 0,
          artist_counts: {},
        },
      })
    })

    await page.route('**/api/artists/identify-batch', async (route) => {
      identifyPayload = route.request().postDataJSON()
      await route.fulfill({
        json: {
          message: 'Batch identification started',
          total: identifyPayload?.image_ids?.length || 0,
        },
      })
    })

    await page.route('**/api/artists/batch-progress', async (route) => {
      await route.fulfill({
        json: {
          running: false,
          total: 1,
          processed: 1,
          errors: 0,
          results: [],
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#btn-toggle-select').click()
    await page.locator('#gallery-grid .gallery-item').first().click()

    await openView(page, 'artist')
    await expect(page.locator('#view-artist.active')).toBeVisible()

    await page.selectOption('#artist-model-source', 'local')
    await page.locator('#artist-model-path').fill('C:/models/artist.onnx')
    await page.locator('#btn-identify-selected').click()

    await expect.poll(
      () => identifyPayload?.model_source ?? null,
      { timeout: 10000 }
    ).toBe('local')
    expect(identifyPayload?.model_path).toBe('C:/models/artist.onnx')
    expect(Array.isArray(identifyPayload?.image_ids)).toBeTruthy()
    expect(identifyPayload?.image_ids?.length).toBe(1)
  })

  test('artist identify selected should stay disabled until there is a gallery selection', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('artist-guide-seen', 'true')
    })

    await page.route('**/api/artists/stats', async (route) => {
      await route.fulfill({
        json: {
          total_images: 10,
          identified_images: 0,
          undefined_count: 0,
          artist_counts: {},
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await openView(page, 'artist')
    await expect(page.locator('#view-artist.active')).toBeVisible()
    await expect(page.locator('#btn-identify-selected')).toBeDisabled()

    await openView(page, 'gallery')
    await page.locator('#btn-toggle-select').click()
    await page.locator('#gallery-grid .gallery-item').first().click()

    await openView(page, 'artist')
    await expect(page.locator('#btn-identify-selected')).toBeEnabled()
  })

  test('artist guide overlay should close on backdrop click and Escape', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('artist-guide-seen')
    })

    await page.route('**/api/artists/stats', async (route) => {
      await route.fulfill({
        json: {
          total_images: 10,
          identified_images: 0,
          undefined_count: 0,
          artist_counts: {},
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openView(page, 'artist')
    await expect(page.locator('#artist-first-use-guide')).toBeVisible()

    await page.locator('#artist-first-use-guide .guide-backdrop').evaluate((node) => {
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await expect(page.locator('#artist-first-use-guide')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('artist-guide-seen'))).toBe('true')

    await page.evaluate(() => {
      localStorage.removeItem('artist-guide-seen')
      window.ArtistIdent?.showFirstUseGuide?.()
    })

    await expect(page.locator('#artist-first-use-guide')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#artist-first-use-guide')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('artist-guide-seen'))).toBe('true')
  })

  test('manual sort discard should require confirmation before deleting the saved session', async ({ page }) => {
    let deleteSessionCalls = 0

    await mockImageAsset(page, 1)

    await page.route('**/api/sort/current', async (route) => {
      await route.fulfill({
        json: {
          image: { id: 1, filename: 'resume.png' },
          remaining: 4,
          done: false,
        },
      })
    })

    await page.route('**/api/sort/session', async (route) => {
      if (route.request().method() === 'DELETE') {
        deleteSessionCalls += 1
        await route.fulfill({ json: { status: 'ok' } })
        return
      }

      await route.fulfill({ json: { status: 'ok' } })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openSortingSubView(page, 'manual')
    await expect(page.locator('#sort-resume-banner')).toBeVisible()

    await page.locator('#btn-discard-session').click()
    await expect(page.locator('#confirm-modal.visible')).toBeVisible()
    expect(deleteSessionCalls).toBe(0)

    await page.locator('#btn-confirm-cancel').click()
    await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)
    expect(deleteSessionCalls).toBe(0)
    await expect(page.locator('#sort-resume-banner')).toBeVisible()

    await page.locator('#btn-discard-session').click()
    await page.locator('#btn-confirm-ok').click()
    await expect.poll(() => deleteSessionCalls).toBe(1)
    await expect(page.locator('#sort-resume-banner')).toBeHidden()
  })

  test('manual sort resume should restore counts and support redo after undoing a saved action', async ({ page }) => {
    let currentCall = 0

    await mockImageAsset(page, 1)
    await mockImageAsset(page, 2)
    await mockImageAsset(page, 3)

    await page.route('**/api/sort/current', async (route) => {
      currentCall += 1

      if (currentCall === 1) {
        await route.fulfill({
          json: {
            image: { id: 1, filename: 'resume.png' },
            remaining: 2,
            done: false,
          },
        })
        return
      }

      if (currentCall === 2) {
        await route.fulfill({
          json: {
            image: { id: 1, filename: 'resume.png' },
            tags: [],
            index: 1,
            total: 3,
            remaining: 2,
            sorted_count: 0,
            skipped_count: 1,
            undo_available: true,
            redo_available: false,
            image_ids: [1, 2, 3],
            folders: {
              a: 'C:/sorted/keep',
            },
          },
        })
        return
      }

      await route.fulfill({ json: { done: true } })
    })

    await page.route('**/api/sort/action?action=undo', async (route) => {
      await route.fulfill({
        json: {
          status: 'undone',
          undone_action: 'skip',
          folder_key: null,
          image: { id: 1, filename: 'resume.png' },
          tags: [],
          index: 1,
          total: 3,
          remaining: 2,
          sorted_count: 0,
          skipped_count: 0,
        },
      })
    })

    await page.route('**/api/sort/action?action=redo', async (route) => {
      await route.fulfill({
        json: {
          status: 'redone',
          redone_action: 'skip',
          image: { id: 2, filename: 'after-redo.png' },
          tags: [],
          index: 2,
          total: 3,
          remaining: 1,
          sorted_count: 0,
          skipped_count: 1,
          undo_available: true,
          redo_available: false,
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openSortingSubView(page, 'manual')
    await expect(page.locator('#sort-resume-banner')).toBeVisible()

    await page.locator('#btn-resume-sorting').click()
    await expect(page.locator('#sort-interface')).toBeVisible()
    await expect(page.locator('#sort-skipped-count')).toHaveText('1')
    await expect(page.locator('#folder-name-a')).toContainText('keep')
    await expect(page.locator('#preview-scroll .preview-thumb')).toHaveCount(3)

    await page.keyboard.press('Control+Z')
    await expect(page.locator('#sort-skipped-count')).toHaveText('0')

    await page.keyboard.press('y')
    await expect(page.locator('#sort-skipped-count')).toHaveText('1')
  })

  test('manual sort resume should stay on setup if the saved session cannot be loaded', async ({ page }) => {
    let currentCall = 0

    await mockImageAsset(page, 1)

    await page.route('**/api/sort/current', async (route) => {
      currentCall += 1

      if (currentCall === 1) {
        await route.fulfill({
          json: {
            image: { id: 1, filename: 'resume.png' },
            remaining: 4,
            done: false,
          },
        })
        return
      }

      await route.fulfill({
        status: 500,
        json: {
          detail: 'Session could not be restored',
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openSortingSubView(page, 'manual')
    await expect(page.locator('#sort-resume-banner')).toBeVisible()

    await page.locator('#btn-resume-sorting').click()

    await expect(page.locator('#sort-setup')).toBeVisible()
    await expect(page.locator('#sort-interface')).not.toBeVisible()
    await expect(page.locator('#sort-resume-banner')).toBeVisible()
  })

  test('should support manual sort skip, undo, and redo without desyncing the current image', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await openSortingSubView(page, 'manual')

    await page.locator('.folder-path-input[data-key="a"]').fill('L:\\Antigravitiy code\\sd-image-sorter\\.tmp_move_target')
    await page.locator('#btn-start-sorting').click()
    await expect(page.locator('#sort-interface')).toBeVisible()

    const currentImage = page.locator('#current-image')
    await expect(currentImage).toBeVisible()
    await expect.poll(() => currentImage.getAttribute('src'), { timeout: 10000 }).not.toBe('')
    const initialSrc = normalizeImageSrc(await currentImage.getAttribute('src'))
    expect(initialSrc).not.toBeNull()

    await page.keyboard.press('Space')
    await expect.poll(async () => normalizeImageSrc(await currentImage.getAttribute('src')), { timeout: 10000 }).not.toBe(initialSrc)
    const skippedSrc = normalizeImageSrc(await currentImage.getAttribute('src'))
    expect(skippedSrc).not.toBeNull()

    await page.keyboard.press('Control+Z')
    await expect.poll(async () => normalizeImageSrc(await currentImage.getAttribute('src')), { timeout: 10000 }).toBe(initialSrc)

    await page.keyboard.press('y')
    await expect.poll(async () => normalizeImageSrc(await currentImage.getAttribute('src')), { timeout: 10000 }).toBe(skippedSrc)

    await page.locator('#btn-exit-sorting').click()
  })

  test('similar search should support drag and drop uploads', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('similar-guide-seen', 'true')
    })

    await mockImageAsset(page, 7)

    await page.route('**/api/similarity/search-upload**', async (route) => {
      await route.fulfill({
        json: {
          results: [
            { id: 7, filename: 'drop-match.png', similarity: 0.987 },
          ],
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openView(page, 'similar')
    await expect(page.locator('#view-similar.active')).toBeVisible()

    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer()
      const file = new File([new Uint8Array([1, 2, 3, 4])], 'query.png', { type: 'image/png' })
      transfer.items.add(file)
      return transfer
    })

    await page.locator('#similar-upload-dropzone').dispatchEvent('drop', { dataTransfer })

    await expect(page.locator('#similar-results .similar-result').first()).toBeVisible()
    await expect(page.locator('#similar-results .similar-name').first()).toContainText('drop-match.png')
  })

  test('similar embedding should resume running progress and report processed plus errors correctly', async ({ page }) => {
    let progressCalls = 0

    await page.addInitScript(() => {
      localStorage.setItem('similar-guide-seen', 'true')
    })

    await page.route('**/api/similarity/stats', async (route) => {
      await route.fulfill({
        json: {
          total_images: 10,
          embedded_images: 4,
          embedded_count: 4,
          pending: 6,
          pending_count: 6,
        },
      })
    })

    await page.route('**/api/similarity/progress', async (route) => {
      progressCalls += 1

      if (progressCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        await route.fulfill({
          json: {
            running: true,
            total: 5,
            processed: 3,
            errors: 1,
          },
        })
        return
      }

      await route.fulfill({
        json: {
          running: false,
          total: 5,
          processed: 4,
          errors: 1,
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openView(page, 'similar')
    await expect(page.locator('#view-similar.active')).toBeVisible()

    await expect(page.locator('#btn-similar-embed')).toBeDisabled()
    await expect(page.locator('#btn-similar-search')).toBeDisabled()
    await expect(page.locator('#btn-similar-upload')).toBeDisabled()
    await expect(page.locator('#btn-similar-duplicates')).toBeDisabled()
    await expect.poll(() => progressCalls, { timeout: 10000 }).toBeGreaterThanOrEqual(2)
    await expect(page.locator('#btn-similar-embed')).toBeEnabled()
    await expect(page.locator('#btn-similar-search')).toBeEnabled()
    await expect(page.locator('#btn-similar-upload')).toBeEnabled()
    await expect(page.locator('#btn-similar-duplicates')).toBeEnabled()
    await expect(page.locator('#similar-embed-text')).toContainText('5/5')
    await expect(page.locator('#similar-embed-text')).toContainText('4 embedded')
  })

  test('similar duplicate search should explain when there are not enough embedded images', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('similar-guide-seen', 'true')
    })

    await page.route('**/api/similarity/stats', async (route) => {
      await route.fulfill({
        json: {
          total_images: 1,
          embedded_images: 1,
          embedded_count: 1,
          pending: 0,
          pending_count: 0,
        },
      })
    })

    await page.route('**/api/similarity/progress', async (route) => {
      await route.fulfill({
        json: {
          running: false,
          total: 0,
          processed: 0,
          errors: 0,
        },
      })
    })

    await page.route('**/api/similarity/duplicates**', async (route) => {
      await route.fulfill({
        json: {
          duplicates: [],
          count: 0,
          threshold: 0.95,
          reason: 'insufficient_embeddings',
          embedded_count: 1,
          minimum_required: 2,
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openView(page, 'similar')
    await expect(page.locator('#view-similar.active')).toBeVisible()

    await page.locator('.similar-tab[data-target="panel-similar-duplicates"]').click()
    await expect(page.locator('#btn-similar-duplicates')).toBeEnabled()
    await page.locator('#btn-similar-duplicates').click()
    await expect(page.locator('#similar-duplicates .empty-state')).toContainText('Need at least 2 embedded images')
  })

  test('should undo a censor brush stroke back to the previous canvas state', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const firstGalleryItem = page.locator('#gallery-grid .gallery-item').first()
    await expect(firstGalleryItem).toBeVisible()

    await page.locator('#btn-toggle-select').click()
    await firstGalleryItem.click()
    await expect(page.locator('#selection-actions')).toBeVisible()
    await page.locator('#btn-send-to-censor').click()

    await expect(page.locator('#view-censor.active')).toBeVisible()
    await expect(page.locator('#canvas-wrapper')).toBeVisible()

    const penTool = page.locator('[data-tool="pen"]').first()
    if (await penTool.count()) {
      await penTool.click()
    }
    const brushSize = page.locator('#tool-size')
    if (await brushSize.count()) {
      await brushSize.fill('90')
    }

    await expect.poll(() => getActiveCensorCanvasSnapshot(page), { timeout: 10000 }).not.toBeNull()
    const initialSnapshot = await getActiveCensorCanvasSnapshot(page)
    expect(initialSnapshot).not.toBeNull()

    const canvasBox = await page.locator('#canvas-wrapper').boundingBox()
    expect(canvasBox).not.toBeNull()
    if (!canvasBox) return

    const startX = canvasBox.x + canvasBox.width * 0.45
    const startY = canvasBox.y + canvasBox.height * 0.45
    const endX = canvasBox.x + canvasBox.width * 0.62
    const endY = canvasBox.y + canvasBox.height * 0.62

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 8 })
    await page.mouse.up()

    await expect.poll(() => getActiveCensorCanvasSnapshot(page), { timeout: 5000 }).not.toBe(initialSnapshot)
    const editedSnapshot = await getActiveCensorCanvasSnapshot(page)
    expect(editedSnapshot).not.toBeNull()

    await page.keyboard.press('Control+Z')
    await expect.poll(async () => {
      const snapshot = await getActiveCensorCanvasSnapshot(page)
      return snapshot === initialSnapshot || snapshot !== editedSnapshot
    }, { timeout: 10000 }).toBeTruthy()
  })

  test('censor detect modal should explain simple and pro model capabilities', async ({ page }) => {
    await page.route('**/api/censor/models', async (route) => {
      await route.fulfill({
        json: {
          status: 'ok',
          recommended_backend: 'both',
          models: [
            {
              id: 'legacy',
              name: 'Legacy YOLO',
              available: true,
              recommended: true,
              default_model_path: 'C:/models/wenaka_yolov8s-seg.onnx',
              simple_user_advice: 'Keep mode on Both and leave the model path blank.',
              files: [
                {
                  name: 'wenaka_yolov8s-seg.onnx',
                  path: 'C:/models/wenaka_yolov8s-seg.onnx',
                  size_mb: 45.7,
                  profile: 'privacy-censor',
                  profile_label: 'Privacy-part detector',
                  recommended_for_censor: true,
                  message: 'Specialized for privacy-part detection and censor workflows.',
                  capabilities: {
                    input_mode_label: 'Fixed privacy-part labels',
                    output_mode_label: 'Fast box-first censoring',
                    class_scope_label: '5 built-in privacy classes',
                    supports_text_prompt: false,
                    plain_english: 'Best for normal users who want quick privacy-part auto-detection.',
                  },
                },
                {
                  name: 'yolo26s-seg.onnx',
                  path: 'C:/models/yolo26s-seg.onnx',
                  size_mb: 40.0,
                  profile: 'general-object',
                  profile_label: 'General object segmentation',
                  recommended_for_censor: false,
                  message: 'General segmentation test model.',
                  capabilities: {
                    input_mode_label: 'Fixed built-in object classes',
                    output_mode_label: 'General object segmentation tests',
                    class_scope_label: '80 built-in object classes',
                    supports_text_prompt: false,
                    plain_english: 'Useful for advanced compatibility checks, not free-text prompting.',
                  },
                },
              ],
              privacy_model_count: 1,
              general_model_count: 1,
            },
            {
              id: 'nudenet',
              name: 'NudeNet v3',
              available: true,
              recommended: true,
              message: 'NudeNet model ready.',
              capabilities: {
                input_mode_label: 'No manual prompt input',
                output_mode_label: 'Detection boxes',
                class_scope_label: 'Built-in NSFW body-part classes',
                supports_text_prompt: false,
                plain_english: 'Good default for NSFW region detection.',
              },
            },
            {
              id: 'sam3',
              name: 'SAM 3',
              available: true,
              recommended: true,
              message: 'SAM3 checkpoint and runtime dependencies are ready.',
              capabilities: {
                input_mode_label: 'Text prompt or box prompt',
                output_mode_label: 'Pixel-accurate masks',
                class_scope_label: 'Prompt-guided segmentation',
                supports_text_prompt: true,
                plain_english: 'This is the precise tool for pro users.',
              },
            },
          ],
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openView(page, 'censor')
    await expect(page.locator('#view-censor.active')).toBeVisible()

    // censor-simple-guide is hidden in the redesigned UI (info moved to settings popup)
    await page.locator('#btn-open-detect-modal').click()
    await expect(page.locator('#detect-modal.visible')).toBeVisible()

    // Model details and advanced picker are in collapsed <details> sections
    // Open them to test their content
    const modelDetailsSection = page.locator('#detect-modal details').first()
    await modelDetailsSection.click()
    await expect(page.locator('#censor-capability-panel')).toContainText('Built-in NSFW body-part classes')
    await expect(page.locator('#censor-capability-panel')).toContainText('Prompt-guided segmentation')

    // SAM3 text prompt is in the pro segmentation details section
    const proSection = page.locator('#censor-pro-segmentation-group')
    await proSection.click()
    await expect(page.locator('#censor-text-prompt')).toBeEnabled()

    await page.selectOption('#censor-model-type', 'legacy')
    // Advanced model picker is in a collapsed details section — open it first
    const advancedPickerSection = page.locator('#detect-modal details').nth(1)
    await advancedPickerSection.click()
    const advancedModelsToggle = page.locator('label.checkbox-label', {
      has: page.locator('#censor-show-advanced-models'),
    })
    await advancedModelsToggle.scrollIntoViewIfNeeded()
    await advancedModelsToggle.click()
    await expect(page.locator('#censor-show-advanced-models')).toBeChecked()
    let advancedLegacyModelPath = ''
    await expect.poll(async () => {
      const optionValues = await page.locator('#censor-model-file option').evaluateAll((options) =>
        options
          .map((option) => ({
            text: option.textContent || '',
            value: (option as HTMLOptionElement).value || '',
          }))
          .filter((option) => /yolo26s-seg\.onnx/i.test(option.text) || /yolo26s-seg\.onnx/i.test(option.value))
          .map((option) => option.value)
      )
      advancedLegacyModelPath = optionValues[0] || ''
      return advancedLegacyModelPath
    }, { timeout: 10000 }).not.toBe('')
    await page.selectOption('#censor-model-file', advancedLegacyModelPath)
    await expect(page.locator('#censor-simple-guide')).toContainText('general fixed-class segmentation model')
    await expect(page.locator('.target-region-check').first()).toBeEnabled()
    await expect(page.locator('#censor-target-region-help')).toContainText(/switch back to the recommended privacy detector|Wenaka \/ NudeNet families|自动切回推荐的隐私检测路线/i)
  })

  test('quick auto censor should auto-restore the privacy detector when a general legacy model is selected', async ({ page }) => {
    let detectPayload: any = null

    await page.route('**/api/censor/models', async (route) => {
      await route.fulfill({
        json: {
          status: 'ok',
          recommended_backend: 'both',
          models: [
            {
              id: 'legacy',
              name: 'Legacy YOLO',
              available: true,
              recommended: true,
              default_model_path: 'C:/models/wenaka_yolov8s-seg.onnx',
              simple_user_advice: 'Keep mode on Both and leave the model path blank.',
              files: [
                {
                  name: 'wenaka_yolov8s-seg.onnx',
                  path: 'C:/models/wenaka_yolov8s-seg.onnx',
                  size_mb: 45.7,
                  profile: 'privacy-censor',
                  profile_label: 'Privacy-part detector',
                  recommended_for_censor: true,
                  message: 'Specialized for privacy-part detection and censor workflows.',
                  capabilities: {
                    input_mode_label: 'Fixed privacy-part labels',
                    output_mode_label: 'Fast box-first censoring',
                    class_scope_label: '5 built-in privacy classes',
                    supports_text_prompt: false,
                    plain_english: 'Best for normal users who want quick privacy-part auto-detection.',
                  },
                },
                {
                  name: 'yolo26s-seg.onnx',
                  path: 'C:/models/yolo26s-seg.onnx',
                  size_mb: 40.0,
                  profile: 'general-object',
                  profile_label: 'General object segmentation',
                  recommended_for_censor: false,
                  message: 'General segmentation test model.',
                  capabilities: {
                    input_mode_label: 'Fixed built-in object classes',
                    output_mode_label: 'General object segmentation tests',
                    class_scope_label: '80 built-in object classes',
                    supports_text_prompt: false,
                    plain_english: 'Useful for advanced compatibility checks, not free-text prompting.',
                  },
                },
              ],
              privacy_model_count: 1,
              general_model_count: 1,
            },
            {
              id: 'nudenet',
              name: 'NudeNet v3',
              available: true,
              recommended: true,
              message: 'NudeNet model ready.',
              capabilities: {
                input_mode_label: 'No manual prompt input',
                output_mode_label: 'Detection boxes',
                class_scope_label: 'Built-in NSFW body-part classes',
                supports_text_prompt: false,
                plain_english: 'Good default for NSFW region detection.',
              },
            },
            {
              id: 'sam3',
              name: 'SAM 3',
              available: true,
              recommended: true,
              message: 'SAM3 checkpoint and runtime dependencies are ready.',
              capabilities: {
                input_mode_label: 'Text prompt or box prompt',
                output_mode_label: 'Pixel-accurate masks',
                class_scope_label: 'Prompt-guided segmentation',
                supports_text_prompt: true,
                plain_english: 'This is the precise tool for pro users.',
              },
            },
          ],
        },
      })
    })

    await page.route('**/api/censor/detect', async (route) => {
      detectPayload = JSON.parse(route.request().postData() || '{}')
      await route.fulfill({
        json: {
          status: 'ok',
          image_id: detectPayload.image_id,
          model_type: detectPayload.model_type,
          detections: [
            {
              box: [8, 8, 28, 28],
              class: 'breasts',
              confidence: 0.92,
            },
          ],
          combined_mask: null,
          geometry_mode: 'box',
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#btn-toggle-select').click()
    await page.locator('#gallery-grid .gallery-item').first().click()
    await expect(page.locator('#btn-send-to-censor')).toBeEnabled()
    await page.locator('#btn-send-to-censor').click()

    await expect(page.locator('#view-censor.active')).toBeVisible()
    await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(1, { timeout: 15000 })

    await page.locator('#btn-open-detect-modal').click()
    await expect(page.locator('#detect-modal.visible')).toBeVisible()

    await page.selectOption('#censor-model-type', 'legacy')
    // Open the advanced model picker details section first
    const advPickerDetails = page.locator('#detect-modal details').nth(1)
    await advPickerDetails.click()
    const advancedModelsToggle = page.locator('label.checkbox-label', {
      has: page.locator('#censor-show-advanced-models'),
    })
    await advancedModelsToggle.scrollIntoViewIfNeeded()
    await advancedModelsToggle.click()
    await expect(page.locator('#censor-show-advanced-models')).toBeChecked()

    let advancedLegacyModelPath = ''
    await expect.poll(async () => {
      const optionValues = await page.locator('#censor-model-file option').evaluateAll((options) =>
        options
          .map((option) => ({
            text: option.textContent || '',
            value: (option as HTMLOptionElement).value || '',
          }))
          .filter((option) => /yolo26s-seg\.onnx/i.test(option.text) || /yolo26s-seg\.onnx/i.test(option.value))
          .map((option) => option.value)
      )
      advancedLegacyModelPath = optionValues[0] || ''
      return advancedLegacyModelPath
    }, { timeout: 10000 }).not.toBe('')

    await page.selectOption('#censor-model-file', advancedLegacyModelPath)
    await expect(page.locator('.target-region-check').first()).toBeEnabled()

    await page.locator('#btn-auto-detect-current-modal').click()

    await expect.poll(() => detectPayload, { timeout: 10000 }).not.toBeNull()
    expect(detectPayload.model_type).toBe('both')
    expect(detectPayload.model_path).toBe('C:/models/wenaka_yolov8s-seg.onnx')
    expect(detectPayload.target_classes).toEqual(['breasts', 'pussy', 'dick', 'penis', 'anus', 'buttocks'])
    await expect(page.locator('#toast-container')).toContainText(/switch(ed)? back to both mode|自动切回.*两者一起/i)
  })

  test('quick auto censor mixed geometry should affect only matched regions instead of the whole image', async ({ page }) => {
    let detectPayload: any = null
    const fulfillImage = async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: MOCK_IMAGE_SVG,
      })
    }

    await page.route('**/api/image-thumbnail/*', fulfillImage)
    await page.route('**/api/image-file/*', fulfillImage)

    await page.route('**/api/censor/models', async (route) => {
      await route.fulfill({
        json: {
          status: 'ok',
          recommended_backend: 'both',
          models: [
            {
              id: 'legacy',
              name: 'Legacy YOLO',
              available: true,
              recommended: true,
              default_model_path: 'C:/models/wenaka_yolov8s-seg.onnx',
              files: [
                {
                  name: 'wenaka_yolov8s-seg.onnx',
                  path: 'C:/models/wenaka_yolov8s-seg.onnx',
                  profile: 'privacy-censor',
                  profile_label: 'Privacy-part detector',
                  recommended_for_censor: true,
                  capabilities: {
                    supports_text_prompt: false,
                  },
                },
              ],
              privacy_model_count: 1,
              general_model_count: 0,
            },
            {
              id: 'nudenet',
              name: 'NudeNet v3',
              available: true,
              recommended: true,
              capabilities: {
                supports_text_prompt: false,
              },
            },
            {
              id: 'sam3',
              name: 'SAM 3',
              available: false,
              recommended: false,
              capabilities: {
                supports_text_prompt: true,
              },
            },
          ],
        },
      })
    })

    await page.route('**/api/censor/detect', async (route) => {
      detectPayload = JSON.parse(route.request().postData() || '{}')
      await route.fulfill({
        json: {
          status: 'ok',
          image_id: detectPayload.image_id,
          model_type: detectPayload.model_type,
          detections: [
            {
              box: [8, 8, 28, 28],
              polygon: [[8, 8], [28, 8], [28, 28], [8, 28]],
              class: 'breasts',
              confidence: 0.95,
            },
            {
              box: [40, 40, 56, 56],
              class: 'anus',
              confidence: 0.88,
            },
          ],
          combined_mask: MIXED_MASK_DATA_URL,
          geometry_mode: 'mixed',
        },
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#btn-toggle-select').click()
    await page.locator('#gallery-grid .gallery-item').first().click()
    await expect(page.locator('#btn-send-to-censor')).toBeEnabled()
    await page.locator('#btn-send-to-censor').click()

    await expect(page.locator('#view-censor.active')).toBeVisible()
    await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(1, { timeout: 15000 })
    await page.selectOption('#censor-style', 'black_bar')

    const readCensorPixels = async () => page.evaluate(async () => {
      const activeItem = (window as any).__CENSOR_STATE__?.queue?.[0]
      const src = activeItem?.currentDataUrl || activeItem?.originalUrl
      if (!src) return null

      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('Failed to load censor preview image'))
        image.src = src
      })

      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth || img.width
      canvas.height = img.naturalHeight || img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(img, 0, 0)
      const sample = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)
      return {
        unaffected: sample(2, 2),
        maskRegion: sample(12, 12),
        boxRegion: sample(48, 48),
      }
    })

    const before = await readCensorPixels()

    await page.locator('#btn-open-detect-modal').click()
    await expect(page.locator('#detect-modal.visible')).toBeVisible()
    await page.locator('#btn-auto-detect-current-modal').click()
    await expect.poll(() => detectPayload, { timeout: 10000 }).not.toBeNull()
    await expect(page.locator('#toast-container')).toContainText(/mixed auto-censor|混合自动打码|auto-censor mask|基于框的自动打码/i)

    await expect.poll(async () => {
      const queuePayload = await page.evaluate(() => {
        const queue = (window as any).__CENSOR_STATE__?.queue || null
        return queue && queue[0] ? Boolean(queue[0].currentDataUrl) : null
      })
      return queuePayload
    }, { timeout: 10000 }).toBeTruthy()

    const after = await readCensorPixels()

    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    expect(after!.unaffected).toEqual(before!.unaffected)
    expect(after!.maskRegion).not.toEqual(before!.maskRegion)
    expect(after!.boxRegion).not.toEqual(before!.boxRegion)
  })

  test('should keep the filter modal readable across responsive widths', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.locator('#btn-open-filters').click()
    await expect(page.locator('#filter-modal.visible')).toBeVisible()

    const widths = [
      { width: 1440, height: 1100, stacked: false },
      { width: 960, height: 1000, stacked: true },
      { width: 768, height: 920, stacked: true },
    ]

    for (const viewport of widths) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

      const layout = await getFilterModalLayout(page)
      const gridMetrics = await page.evaluate(() => {
        const grid = document.querySelector('#filter-modal .filter-modal-grid')
        if (!grid) return null

        return {
          clientHeight: grid.clientHeight,
          scrollHeight: grid.scrollHeight,
        }
      })
      expect(layout).not.toBeNull()
      if (!layout) continue

      expect(gridMetrics).not.toBeNull()
      if (gridMetrics) {
        expect(gridMetrics.clientHeight).toBeGreaterThan(0)
        expect(gridMetrics.scrollHeight).toBeGreaterThanOrEqual(gridMetrics.clientHeight)
      }

      if (viewport.stacked) {
        expect(Math.abs(layout.primary.left - layout.secondary.left)).toBeLessThanOrEqual(4)
        expect(Math.abs(layout.primary.width - layout.secondary.width)).toBeLessThanOrEqual(4)
      } else {
        expect(layout.primary.right).toBeLessThanOrEqual(layout.secondary.left + 8)
      }
    }

    await expect(page.locator('#btn-apply-modal-filters')).toBeVisible()
    await expect(page.locator('#btn-reset-filters')).toBeVisible()
  })

  test('API health check - images endpoint', async ({ request }) => {
    const response = await request.get('/api/images?limit=1')
    expect(response.ok()).toBeTruthy()

    const data = await response.json()
    expect(data).toHaveProperty('images')
    expect(Array.isArray(data.images)).toBeTruthy()
  })

  test('API health check - stats endpoint', async ({ request }) => {
    const response = await request.get('/api/stats')
    expect(response.ok()).toBeTruthy()

    const data = await response.json()
    expect(data).toHaveProperty('total_images')
  })

  test('API health check - generators endpoint', async ({ request }) => {
    const response = await request.get('/api/generators')
    expect(response.ok()).toBeTruthy()

    const data = await response.json()
    expect(data).toHaveProperty('generators')
    expect(Array.isArray(data.generators)).toBeTruthy()
  })

  test('API health check - tags endpoint', async ({ request }) => {
    const response = await request.get('/api/tags?limit=10')
    expect(response.ok()).toBeTruthy()

    const data = await response.json()
    expect(data).toHaveProperty('tags')
    expect(Array.isArray(data.tags)).toBeTruthy()
  })

  test('should handle invalid API routes gracefully', async ({ request }) => {
    const response = await request.get('/api/nonexistent-endpoint')
    expect(response.status()).toBe(404)
  })

  test('should have OpenAPI documentation available', async ({ request }) => {
    const response = await request.get('/docs')
    expect(response.ok()).toBeTruthy()
  })
})

test.describe('Error Handling', () => {
  test('should return validation error for an empty scan path', async ({ request }) => {
    const response = await request.post('/api/scan', {
      data: { folder_path: '', recursive: true },
    })

    expect(response.status()).toBe(400)

    const data = await response.json()
    expect(data).toMatchObject({
      error: 'Path cannot be empty',
      type: 'HTTPException',
    })
  })

  test('should handle 404 for missing image', async ({ request }) => {
    const response = await request.get('/api/images/999999999')
    expect(response.status()).toBe(404)
  })

  test('should handle rate limiting gracefully', async ({ request }) => {
    // Make many rapid requests
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(request.get('/api/images?limit=1'))
    }

    const responses = await Promise.all(promises)

    // All should succeed (within rate limit)
    const successCount = responses.filter((r) => r.ok()).length
    expect(successCount).toBe(10)
  })
})
