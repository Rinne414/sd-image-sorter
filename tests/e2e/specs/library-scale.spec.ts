import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

const DISPLAY_LIMIT = 500
const TOTAL_TAGS = 1001

type LibraryRequest = {
  limit: string | null
  query: string
}

function libraryTags(count: number): Array<{ tag: string; count: number }> {
  return Array.from({ length: count }, (_, index) => ({
    tag: `initial_tag_${String(index).padStart(4, '0')}`,
    count: count - index,
  }))
}

async function gotoGallery(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof (window as any).App?.openTagsLibrary === 'function')
  await expect(page.locator('#view-gallery')).toBeVisible()
}

function requestDetails(route: Route): LibraryRequest {
  const url = new URL(route.request().url())
  return {
    limit: url.searchParams.get('limit'),
    query: url.searchParams.get('q') || '',
  }
}

test('library search stays full-indexed and wins over an older initial response', async ({ page }) => {
  const requests: LibraryRequest[] = []
  const initialItems = libraryTags(DISPLAY_LIMIT + 1)
  let releaseInitialRequest: () => void = () => undefined
  let markInitialFulfilled: () => void = () => undefined
  const initialRequestGate = new Promise<void>((resolve) => {
    releaseInitialRequest = resolve
  })
  const initialFulfilled = new Promise<void>((resolve) => {
    markInitialFulfilled = resolve
  })

  await page.route('**/api/tags/library**', async (route) => {
    const details = requestDetails(route)
    requests.push(details)
    if (details.query === 'deep target') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tags: [{ tag: 'deep_target', count: 1 }], total: 1 }),
      })
      return
    }

    await initialRequestGate
    const returnedItems = details.limit === String(DISPLAY_LIMIT)
      ? initialItems.slice(0, DISPLAY_LIMIT)
      : initialItems
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tags: returnedItems, total: TOTAL_TAGS }),
    })
    markInitialFulfilled()
  })

  await gotoGallery(page)
  await page.locator('#btn-tags-library').click()
  await expect(page.locator('#tags-library-modal.visible')).toBeVisible()
  await page.locator('#library-search').fill('deep target')
  await expect(page.locator('#library-content .library-tag[data-tag="deep_target"]')).toBeVisible()

  releaseInitialRequest()
  await initialFulfilled
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

  await expect(page.locator('#library-content .library-tag[data-tag="deep_target"]')).toBeVisible()
  await expect(page.locator('#library-content .library-tag[data-tag^="initial_tag_"]')).toHaveCount(0)
  expect(requests).toEqual(expect.arrayContaining([
    { limit: String(DISPLAY_LIMIT), query: '' },
    { limit: String(DISPLAY_LIMIT), query: 'deep target' },
  ]))
})

test('library modal bounds rendered tags and reports shown vs total in both languages', async ({ page }) => {
  test.setTimeout(45000)
  const consoleProblems: string[] = []
  const requestProblems: string[] = []
  const requests: LibraryRequest[] = []
  const initialItems = libraryTags(DISPLAY_LIMIT + 1)

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      requestProblems.push(`${response.status()} ${response.url()}`)
    }
  })
  await page.route('**/api/tags/library**', async (route) => {
    const details = requestDetails(route)
    requests.push(details)
    const returnedItems = details.limit === String(DISPLAY_LIMIT)
      ? initialItems.slice(0, DISPLAY_LIMIT)
      : initialItems
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tags: returnedItems, total: TOTAL_TAGS }),
    })
  })

  await gotoGallery(page)
  const viewports = [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]
  const expectedStats = {
    en: 'Showing 500 of 1001 unique tags',
    'zh-CN': '显示 500 / 共 1001 个唯一标签',
  }

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    for (const language of ['en', 'zh-CN'] as const) {
      await page.evaluate((lang) => (window as any).I18n.setLang(lang), language)
      await page.locator('#btn-tags-library').click()
      const modal = page.locator('#tags-library-modal.visible')
      const tags = page.locator('#library-content .library-tag')
      const stats = page.locator('#library-stats-text')
      await expect(modal).toBeVisible()
      await expect(tags).toHaveCount(DISPLAY_LIMIT)
      await expect(stats).toHaveText(expectedStats[language])
      await stats.scrollIntoViewIfNeeded()

      const geometry = await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('#tags-library-modal .tags-library-shell')
        const statsNode = document.getElementById('library-stats-text')
        if (!shell || !statsNode) throw new Error('Tags Library geometry nodes are missing')
        const shellRect = shell.getBoundingClientRect()
        const statsRect = statsNode.getBoundingClientRect()
        return {
          horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          shell: { left: shellRect.left, top: shellRect.top, right: shellRect.right, bottom: shellRect.bottom },
          stats: { left: statsRect.left, top: statsRect.top, right: statsRect.right, bottom: statsRect.bottom },
        }
      })
      expect(geometry.horizontalOverflow).toBe(0)
      expect(geometry.shell.left).toBeGreaterThanOrEqual(-1)
      expect(geometry.shell.top).toBeGreaterThanOrEqual(-1)
      expect(geometry.shell.right).toBeLessThanOrEqual(viewport.width + 1)
      expect(geometry.shell.bottom).toBeLessThanOrEqual(viewport.height + 1)
      expect(geometry.stats.left).toBeGreaterThanOrEqual(geometry.shell.left - 1)
      expect(geometry.stats.right).toBeLessThanOrEqual(geometry.shell.right + 1)
      expect(geometry.stats.top).toBeGreaterThanOrEqual(-1)
      expect(geometry.stats.bottom).toBeLessThanOrEqual(viewport.height + 1)

      await page.locator('#btn-close-tags-library').click()
      await expect(page.locator('#tags-library-modal')).toBeHidden()
    }
  }

  expect(requests).toHaveLength(viewports.length * 2)
  expect(requests.every((request) => request.limit === String(DISPLAY_LIMIT))).toBe(true)
  expect(consoleProblems).toEqual([])
  expect(requestProblems).toEqual([])
})

test('all library facet tabs cap responses and keep the complete-result count copy', async ({ page }) => {
  const requests: Array<LibraryRequest & { facet: string }> = []
  const facets = [
    {
      endpoint: '**/api/tags/library**',
      facet: 'tags',
      tab: '#library-tab-tags',
      response: { tags: [{ tag: 'tag_a', count: 2 }, { tag: 'tag_b', count: 1 }], total: 2 },
      stats: '2 unique tags found',
    },
    {
      endpoint: '**/api/prompts/library**',
      facet: 'prompts',
      tab: '#library-tab-prompts',
      response: { prompts: [{ prompt: 'prompt a', count: 2 }, { prompt: 'prompt b', count: 1 }], total: 2 },
      stats: '2 unique prompts found',
    },
    {
      endpoint: '**/api/loras/library**',
      facet: 'loras',
      tab: '#library-tab-loras',
      response: { loras: [{ lora: 'lora_a', count: 2 }, { lora: 'lora_b', count: 1 }], total: 2 },
      stats: '2 unique LoRAs found',
    },
    {
      endpoint: '**/api/checkpoints/library**',
      facet: 'checkpoints',
      tab: '#library-tab-checkpoints',
      response: {
        checkpoints: [
          { checkpoint: 'model_a', checkpoint_normalized: 'model_a', count: 2 },
          { checkpoint: 'model_b', checkpoint_normalized: 'model_b', count: 1 },
        ],
        total: 2,
      },
      stats: '2 unique checkpoints found',
    },
  ]

  for (const facet of facets) {
    await page.route(facet.endpoint, async (route) => {
      requests.push({ facet: facet.facet, ...requestDetails(route) })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(facet.response),
      })
    })
  }

  await gotoGallery(page)
  await page.locator('#btn-tags-library').click()
  await expect(page.locator('#tags-library-modal.visible')).toBeVisible()

  for (const facet of facets) {
    await page.locator(facet.tab).click()
    await expect(page.locator('#library-stats-text')).toHaveText(facet.stats)
  }

  expect(requests).toEqual(expect.arrayContaining(facets.map((facet) => ({
    facet: facet.facet,
    limit: String(DISPLAY_LIMIT),
    query: '',
  }))))
})

test('pending tag search does not issue a duplicate request after switching library tabs', async ({ page }) => {
  let promptRequests = 0
  let releasePromptRequest: () => void = () => undefined
  const promptRequestGate = new Promise<void>((resolve) => {
    releasePromptRequest = resolve
  })

  await page.route('**/api/tags/library**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tags: [{ tag: 'tag_result', count: 1 }], total: 1 }),
    })
  })
  await page.route('**/api/prompts/library**', async (route) => {
    promptRequests += 1
    if (promptRequests > 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'unexpected duplicate prompt request' }),
      })
      return
    }
    await promptRequestGate
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prompts: [{ prompt: 'prompt result', count: 1 }], total: 1 }),
    })
  })

  await gotoGallery(page)
  await page.locator('#btn-tags-library').click()
  await expect(page.locator('#library-content .library-tag[data-tag="tag_result"]')).toBeVisible()

  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#library-search')
    const promptsTab = document.querySelector<HTMLButtonElement>('#library-tab-prompts')
    if (!input || !promptsTab) throw new Error('Library search controls are missing')
    input.value = 'stale tag query'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    promptsTab.click()
  })
  await expect.poll(() => promptRequests).toBe(1)
  await page.waitForTimeout(250)
  expect(promptRequests).toBe(1)

  releasePromptRequest()
  await expect(page.locator('#library-content .library-tag[data-prompt="prompt result"]')).toBeVisible()
  await expect(page.locator('#library-content .library-status')).toHaveCount(0)
})

test('new library input immediately invalidates an in-flight older search', async ({ page }) => {
  let firstSearchRequests = 0
  let secondSearchRequests = 0
  let releaseFirstSearch: () => void = () => undefined
  let markFirstSearchFulfilled: () => void = () => undefined
  let releaseSecondSearch: () => void = () => undefined
  const firstSearchGate = new Promise<void>((resolve) => {
    releaseFirstSearch = resolve
  })
  const firstSearchFulfilled = new Promise<void>((resolve) => {
    markFirstSearchFulfilled = resolve
  })
  const secondSearchGate = new Promise<void>((resolve) => {
    releaseSecondSearch = resolve
  })

  await page.route('**/api/tags/library**', async (route) => {
    const details = requestDetails(route)
    if (details.query === 'first search') {
      firstSearchRequests += 1
      await firstSearchGate
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tags: [{ tag: 'stale_first_result', count: 1 }], total: 1 }),
      })
      markFirstSearchFulfilled()
      return
    }
    if (details.query === 'second search') {
      secondSearchRequests += 1
      await secondSearchGate
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tags: [{ tag: 'current_second_result', count: 1 }], total: 1 }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tags: [{ tag: 'initial_result', count: 1 }], total: 1 }),
    })
  })

  await gotoGallery(page)
  await page.locator('#btn-tags-library').click()
  await expect(page.locator('#library-content .library-tag[data-tag="initial_result"]')).toBeVisible()

  await page.locator('#library-search').fill('first search')
  await expect.poll(() => firstSearchRequests).toBe(1)
  await page.locator('#library-search').fill('second search')
  releaseFirstSearch()
  await firstSearchFulfilled
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

  await expect(page.locator('#library-content .library-tag[data-tag="stale_first_result"]')).toHaveCount(0)
  await expect(page.locator('#library-content .library-tag[data-tag="initial_result"]')).toBeVisible()
  await expect.poll(() => secondSearchRequests).toBe(1)

  releaseSecondSearch()
  await expect(page.locator('#library-content .library-tag[data-tag="current_second_result"]')).toBeVisible()
  await expect(page.locator('#library-content .library-tag[data-tag="stale_first_result"]')).toHaveCount(0)
})

test('library search failure replaces results with an actionable error state', async ({ page }) => {
  await page.route('**/api/tags/library**', async (route) => {
    const details = requestDetails(route)
    if (details.query === 'broken search') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'search index unavailable' }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tags: [{ tag: 'tag_result', count: 1 }], total: 1 }),
    })
  })

  await gotoGallery(page)
  await page.locator('#btn-tags-library').click()
  await expect(page.locator('#library-content .library-tag[data-tag="tag_result"]')).toBeVisible()

  await page.locator('#library-search').fill('broken search')
  const errorState = page.locator('#library-content .library-status-error')
  await expect(errorState).toBeVisible()
  await expect(errorState).toContainText('Failed to load tag library')
  await expect(errorState).toContainText('search index unavailable')
  await expect(page.locator('#library-stats-text')).toContainText('search index unavailable')
  await expect(page.locator('#library-content .library-tag')).toHaveCount(0)
})
