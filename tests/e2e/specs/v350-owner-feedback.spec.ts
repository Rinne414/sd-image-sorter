import { expect, test } from '../fixtures/click-ledger'

/**
 * Owner feedback batch 2026-07-05 (v3.5.0): regression tests for
 * - search-syntax help modal re-rendering after an in-app language switch
 *   (it listened for the wrong event and stayed in the first-open language)
 * - settings toggle rows being whole-row clickable with a visible state
 * - image-to-image navigation keeping the previous image (no black flash:
 *   the skeleton must NOT hide the current image on re-navigation)
 * - WASD slot cards keeping their folder buttons inside the card box
 */

test.use({ viewport: { width: 1600, height: 900 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('aurora-entry-skip', '1')
  })
})

test('search help rows re-render in English after switching language', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  // Open once in Chinese so the row cache is populated…
  await page.locator('#btn-search-help').click()
  await expect(page.locator('#search-help-modal.visible')).toBeVisible()
  const zhDesc = await page.locator('.search-help-row .search-help-desc').first().textContent()
  expect(zhDesc).toContain('文字')
  await page.locator('#btn-close-search-help').click()

  // …switch to English in-app…
  await page.evaluate(() => (window as any).I18n.setLang('en'))

  // …and the next open must be English, not the cached Chinese rows.
  await page.locator('#btn-search-help').click()
  await expect(page.locator('#search-help-modal.visible')).toBeVisible()
  await expect(page.locator('.search-help-row .search-help-desc').first())
    .toContainText('Plain words')
})

test('Gallery folder empty state re-renders after switching language', async ({ page }) => {
  const consoleProblems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`${message.type()}: ${message.text()}`)
    }
  })
  await page.route('**/api/folders', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ folders: [] }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  const emptyState = page.locator('#folder-tree .folder-tree-empty')
  await expect(emptyState).toHaveText('暂无文件夹——扫描一个文件夹后即可在此筛选。')

  await page.evaluate(() => (window as any).I18n.setLang('en'))
  await expect(emptyState).toHaveText('No folders yet — scan a folder to populate the gallery.')

  await page.evaluate(() => (window as any).I18n.setLang('zh-CN'))
  await expect(emptyState).toHaveText('暂无文件夹——扫描一个文件夹后即可在此筛选。')
  expect(consoleProblems).toEqual([])
})

test('Gallery folder relocalization preserves the active tree state', async ({ page }) => {
  const folders = Array.from(
    { length: 48 },
    (_, index) => `C:/library/branch-${String(index).padStart(2, '0')}`,
  )
  let folderRequests = 0
  await page.route('**/api/folders', async (route) => {
    folderRequests += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ folders }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  const branchToggle = page.locator('#folder-tree [data-action="toggle"][data-path="C:/library"]')
  await expect(branchToggle).toHaveCount(1)
  await branchToggle.click()
  await expect(branchToggle).toHaveAttribute('aria-expanded', 'true')
  const targetPath = folders[folders.length - 1]
  const target = page.locator(`#folder-tree [data-action="browse"][data-path="${targetPath}"]`)
  await expect(target).toHaveCount(1)
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await expect(target).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#folder-tree-browsing')).toContainText(`文件夹：${targetPath}`)

  const before = await page.evaluate(() => {
    const tree = document.getElementById('folder-tree')
    const sidebar = tree?.closest('.filter-sidebar-scroll')
    const expanded = [...document.querySelectorAll<HTMLElement>('#folder-tree [aria-expanded="true"]')]
      .map((element) => element.dataset.path)
    return {
      treeScrollTop: tree?.scrollTop ?? -1,
      treeScrollMax: tree ? tree.scrollHeight - tree.clientHeight : -1,
      sidebarScrollTop: sidebar?.scrollTop ?? -1,
      expanded,
      activeFolder: (window as any).FolderTreeUI?._active ?? null,
    }
  })
  expect(before.treeScrollTop).toBeGreaterThan(0)

  await page.evaluate(() => (window as any).I18n.setLang('en'))
  await expect(page.locator('#folder-tree-browsing')).toContainText(`Folder: ${targetPath}`)
  await expect(target).toHaveAttribute('aria-pressed', 'true')
  const after = await page.evaluate(() => {
    const tree = document.getElementById('folder-tree')
    const sidebar = tree?.closest('.filter-sidebar-scroll')
    const expanded = [...document.querySelectorAll<HTMLElement>('#folder-tree [aria-expanded="true"]')]
      .map((element) => element.dataset.path)
    return {
      treeScrollTop: tree?.scrollTop ?? -1,
      treeScrollMax: tree ? tree.scrollHeight - tree.clientHeight : -1,
      sidebarScrollTop: sidebar?.scrollTop ?? -1,
      expanded,
      activeFolder: (window as any).FolderTreeUI?._active ?? null,
      activeVisible: (() => {
        const active = tree?.querySelector<HTMLElement>('[data-action="browse"][aria-pressed="true"]')
        if (!tree || !active) return false
        const treeBox = tree.getBoundingClientRect()
        const activeBox = active.getBoundingClientRect()
        return activeBox.top >= treeBox.top && activeBox.bottom <= treeBox.bottom
      })(),
    }
  })

  expect(after.activeFolder).toBe(before.activeFolder)
  expect(after.expanded).toEqual(before.expanded)
  expect(after.sidebarScrollTop).toBe(before.sidebarScrollTop)
  expect(before.treeScrollTop).toBe(before.treeScrollMax)
  expect(after.treeScrollTop).toBe(after.treeScrollMax)
  expect(after.activeVisible).toBe(true)
  expect(folderRequests).toBe(1)
})

test('CLIP, OppaiOracle, and Favorites use the active language instead of backend text', async ({ page }) => {
  const consoleProblems: string[] = []
  const requestProblems: string[] = []
  let collectionRequests = 0
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/collections') {
      collectionRequests += 1
    }
  })
  page.on('requestfailed', (request) => {
    requestProblems.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`.trim())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) {
      requestProblems.push(`${response.status()} ${response.request().method()} ${response.url()}`)
    }
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  const favoriteName = page.locator('#collections-list .collection-row.is-favorites .collection-row-name')
  await expect(favoriteName).toHaveText('收藏')
  const initialCollectionRequests = collectionRequests
  expect(initialCollectionRequests).toBeGreaterThan(0)

  await page.evaluate(() => (window as any).I18n.setLang('en'))
  await expect(favoriteName).toHaveText('Favorites')
  await page.evaluate(() => (window as any).I18n.setLang('zh-CN'))
  await expect(favoriteName).toHaveText('收藏')
  expect(collectionRequests).toBe(initialCollectionRequests)

  const similarityStatusResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'GET'
      && url.pathname === '/api/similarity/model-status'
      && response.status() === 200
  })
  await page.locator('#nav-tab-similar').click()
  await expect(page.locator('#view-similar.active')).toBeVisible()
  const similarityStatus = await (await similarityStatusResponse).json()
  expect(typeof similarityStatus.message_key).toBe('string')
  expect(similarityStatus.message_key).not.toBe('')
  const expectedChineseClipStatus = await page.evaluate((key) => {
    return (window as any).I18n.t(key)
  }, similarityStatus.message_key)
  expect(expectedChineseClipStatus).not.toBe(similarityStatus.message_key)
  const similarityDetails = page.locator('#similar-model-health .model-health-details')
  await expect(similarityDetails.locator('li').first()).toHaveText(expectedChineseClipStatus)
  if (similarityStatus.message && similarityStatus.message !== expectedChineseClipStatus) {
    await expect(similarityDetails.locator('li').first()).not.toHaveText(similarityStatus.message)
  }
  await similarityDetails.evaluate((details: HTMLDetailsElement) => { details.open = true })

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport)
    await similarityDetails.scrollIntoViewIfNeeded()
    const geometry = await page.locator('#similar-model-health').evaluate((banner) => {
      const box = banner.getBoundingClientRect()
      return {
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        visible: box.width > 0 && box.height > 0,
        insideViewportX: box.left >= 0 && box.right <= window.innerWidth + 1,
      }
    })
    expect(geometry).toEqual({ horizontalOverflow: 0, visible: true, insideViewportX: true })
  }

  const modelStatusResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'GET'
      && url.pathname === '/api/models/status'
      && response.status() === 200
  })
  await page.locator('#btn-open-model-manager').click()
  await expect(page.locator('#model-manager-modal.visible')).toBeVisible()
  await page.locator('[data-settings-tab="models"]').click()
  const modelStatus = await (await modelStatusResponse).json()
  const oppaiModel = modelStatus.models.find((model: { id: string }) => model.id === 'oppai-oracle')
  expect(oppaiModel).toBeTruthy()
  expect(typeof oppaiModel.message_key).toBe('string')
  const expectedChineseOppaiStatus = await page.evaluate((key) => {
    return (window as any).I18n.t(key)
  }, oppaiModel.message_key)
  expect(expectedChineseOppaiStatus).not.toBe(oppaiModel.message_key)
  const oppaiMessage = page.locator('[data-model-id="oppai-oracle"] .model-card-message')
  await expect(oppaiMessage).toHaveText(expectedChineseOppaiStatus)

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport)
    await oppaiMessage.scrollIntoViewIfNeeded()
    const geometry = await page.locator('article.model-card[data-model-id="oppai-oracle"]').evaluate((card) => {
      const cardBox = card.getBoundingClientRect()
      const modal = document.querySelector<HTMLElement>('#model-manager-modal .modal-content')
      if (!modal) throw new Error('Model Manager modal content is unavailable')
      const modalBox = modal.getBoundingClientRect()
      return {
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        insideModalX: cardBox.left >= modalBox.left - 1 && cardBox.right <= modalBox.right + 1,
        messageInsideCard: (() => {
          const message = card.querySelector<HTMLElement>('.model-card-message')
          if (!message) return false
          const messageBox = message.getBoundingClientRect()
          return messageBox.left >= cardBox.left - 1 && messageBox.right <= cardBox.right + 1
        })(),
      }
    })
    expect(geometry).toEqual({ horizontalOverflow: 0, insideModalX: true, messageInsideCard: true })
  }

  await page.locator('#model-manager-close').click()
  await expect(page.locator('#model-manager-modal.visible')).toHaveCount(0)
  expect(consoleProblems).toEqual([])
  expect(requestProblems).toEqual([])
})

test('Guide supplements preserve the main language dimension labels in Filter Images', async ({ page }) => {
  const consoleProblems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`${message.type()}: ${message.text()}`)
    }
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  const fields = [
    { id: 'filter-min-width', zh: '最小宽度', en: 'Min width' },
    { id: 'filter-max-width', zh: '最大宽度', en: 'Max width' },
    { id: 'filter-min-height', zh: '最小高度', en: 'Min height' },
    { id: 'filter-max-height', zh: '最大高度', en: 'Max height' },
  ]
  const viewports = [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.evaluate(() => (window as any).I18n.setLang('zh-CN'))
    await page.locator('#btn-toolbar-filters').click()
    await expect(page.locator('#filter-modal.visible')).toBeVisible()
    await page.locator('#filter-min-width').scrollIntoViewIfNeeded()

    for (const field of fields) {
      const input = page.locator(`#${field.id}`)
      const label = page.locator('.dimension-field').filter({ has: input }).locator('.dimension-label')
      await expect(label).toHaveText(field.zh)
      await expect(input).toHaveAttribute('placeholder', field.zh)
      await expect(input).toBeInViewport()
    }

    await page.evaluate(() => (window as any).I18n.setLang('en'))
    for (const field of fields) {
      const input = page.locator(`#${field.id}`)
      const label = page.locator('.dimension-field').filter({ has: input }).locator('.dimension-label')
      await expect(label).toHaveText(field.en)
      await expect(input).toHaveAttribute('placeholder', field.en)
    }

    const geometry = await page.evaluate((fieldIds) => {
      const shell = document.querySelector<HTMLElement>('#filter-modal .filter-modal-shell')
      if (!shell) throw new Error('Filter modal shell is missing')
      const shellRect = shell.getBoundingClientRect()
      return {
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        clippedFields: fieldIds.filter((fieldId) => {
          const field = document.getElementById(fieldId)?.closest<HTMLElement>('.dimension-field')
          if (!field) throw new Error(`Dimension field ${fieldId} is missing`)
          const rect = field.getBoundingClientRect()
          return rect.left < Math.max(0, shellRect.left) - 1
            || rect.right > Math.min(window.innerWidth, shellRect.right) + 1
            || rect.top < Math.max(0, shellRect.top) - 1
            || rect.bottom > Math.min(window.innerHeight, shellRect.bottom) + 1
        }),
      }
    }, fields.map((field) => field.id))
    expect(geometry).toEqual({ horizontalOverflow: 0, clippedFields: [] })

    await page.locator('#btn-close-filter-modal').click()
    await expect(page.locator('#filter-modal')).toBeHidden()
  }

  expect(consoleProblems).toEqual([])
})

test('settings toggle rows flip on whole-row click, not just the button', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  const result = await page.evaluate(() => {
    const btn = document.getElementById('btn-settings-entry-toggle')!
    const row = btn.closest('.settings-row') as HTMLElement
    const before = localStorage.getItem('aurora-entry-skip')
    ;(row.querySelector('.settings-row-copy') as HTMLElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return {
      flipped: localStorage.getItem('aurora-entry-skip') !== before,
      rowIsToggle: row.classList.contains('settings-row-toggle'),
      pressed: btn.getAttribute('aria-pressed'),
    }
  })
  expect(result.flipped).toBe(true)
  expect(result.rowIsToggle).toBe(true)
})

test('image navigation keeps the previous image visible (no skeleton over it)', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  // Simulate: modal already open and showing an image, then navigate.
  const probe = await page.evaluate(() => {
    const modal = document.getElementById('image-modal')!
    const img = document.getElementById('modal-image') as HTMLImageElement
    modal.classList.add('visible')
    img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
    img.style.opacity = '1'

    // Re-navigation: keepImage must leave the current image untouched.
    ;(window as any).SkeletonModal.showImageModal('image-modal', { keepImage: true })
    const renav = {
      opacity: img.style.opacity,
      imageSkeleton: !!document.getElementById('skeleton-modal-image'),
    }
    ;(window as any).SkeletonModal.hideImageModal('image-modal')

    // Cold open (no keepImage) still uses the image skeleton.
    ;(window as any).SkeletonModal.showImageModal('image-modal')
    const cold = {
      opacity: img.style.opacity,
      imageSkeleton: !!document.getElementById('skeleton-modal-image'),
    }
    ;(window as any).SkeletonModal.hideImageModal('image-modal')
    modal.classList.remove('visible')
    return { renav, cold }
  })

  expect(probe.renav.opacity).toBe('1')          // old image stays visible
  expect(probe.renav.imageSkeleton).toBe(false)  // no gray block over it
  expect(probe.cold.opacity).toBe('0')           // cold open keeps skeleton UX
  expect(probe.cold.imageSkeleton).toBe(true)
})

test('WASD slot folder buttons stay inside their cards', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  await page.evaluate(() => document.getElementById('nav-tab-sorting')?.click())
  // v3.5.0 naming unification made 手动排序 appear on the (hidden) entry tile
  // too — target the sub-tab directly instead of ambiguous display text.
  await page.locator('.sorting-sub-tab[data-sorting-sub="manual"]').click()
  await expect(page.locator('.folder-config.sort-slot-only')).toBeVisible()

  const overflow = await page.evaluate(() => {
    const out: Array<{ key: string | undefined }> = []
    document.querySelectorAll('.folder-slot').forEach((slot) => {
      const s = slot.getBoundingClientRect()
      slot.querySelectorAll('.browse-folder').forEach((b) => {
        const r = b.getBoundingClientRect()
        if (r.right > s.right + 1 || r.left < s.left - 1) {
          out.push({ key: (slot as HTMLElement).dataset.key })
        }
      })
    })
    return out
  })
  expect(overflow).toEqual([])
})

test('Gallery folder tree keeps its last folder clear of the fixed selection control', async ({ page }) => {
  const folders = Array.from(
    { length: 72 },
    (_, index) => `C:/library/folder-${String(index).padStart(2, '0')}`,
  )
  const targetPath = folders[folders.length - 1]
  const consoleProblems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`${message.type()}: ${message.text()}`)
    }
  })
  await page.route('**/api/folders', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ folders }),
    })
  })

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#view-gallery')).toBeVisible()

    const tree = page.locator('#folder-tree')
    const branchToggle = page.locator('#folder-tree [data-action="toggle"][data-path="C:/library"]')
    const lastFolder = page.locator(`#folder-tree [data-action="browse"][data-path="${targetPath}"]`)
    await expect(branchToggle).toHaveCount(1)
    if (await branchToggle.getAttribute('aria-expanded') !== 'true') {
      await branchToggle.click()
    }
    await expect(branchToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(lastFolder).toHaveCount(1)
    const clearScope = page.locator('#folder-tree-clear')
    if (await clearScope.count() === 1) {
      await clearScope.click()
      await expect(lastFolder).toHaveAttribute('aria-pressed', 'false')
    }
    await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('.filter-sidebar-scroll')
      const treeElement = document.getElementById('folder-tree')
      if (!scroll || !treeElement) throw new Error('Gallery sidebar folder controls are missing')
      scroll.scrollTop = Math.min(
        scroll.scrollHeight - scroll.clientHeight,
        treeElement.offsetTop + treeElement.offsetHeight - scroll.clientHeight,
      )
      treeElement.scrollTop = treeElement.scrollHeight
    })
    await expect(lastFolder).toBeInViewport()

    const geometry = await page.evaluate((path) => {
      const scroll = document.querySelector<HTMLElement>('.filter-sidebar-scroll')
      const footer = document.querySelector<HTMLElement>('.filter-sidebar-footer')
      const treeElement = document.getElementById('folder-tree')
      const last = document.querySelector<HTMLElement>(`#folder-tree [data-action="browse"][data-path="${path}"]`)
      if (!scroll || !footer || !treeElement || !last) {
        throw new Error('Gallery sidebar geometry controls are missing')
      }
      const scrollBox = scroll.getBoundingClientRect()
      const footerBox = footer.getBoundingClientRect()
      const treeBox = treeElement.getBoundingClientRect()
      const lastBox = last.getBoundingClientRect()
      const hitTargets = document.elementsFromPoint(
        lastBox.left + (lastBox.width / 2),
        lastBox.top + (lastBox.height / 2),
      )
      return {
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        lastFolderInsideTree: lastBox.top >= treeBox.top - 1 && lastBox.bottom <= treeBox.bottom + 1,
        lastFolderInsideScroll: lastBox.top >= scrollBox.top - 1 && lastBox.bottom <= scrollBox.bottom + 1,
        scrollClearOfFooter: scrollBox.bottom <= footerBox.top + 1,
        footerDoesNotCoverLastFolder: !hitTargets.some((element) => footer.contains(element)),
      }
    }, targetPath)
    expect(geometry).toEqual({
      horizontalOverflow: 0,
      lastFolderInsideTree: true,
      lastFolderInsideScroll: true,
      scrollClearOfFooter: true,
      footerDoesNotCoverLastFolder: true,
    })

    const filteredImageRequest = page.waitForRequest((request) => {
      const requestUrl = new URL(request.url())
      return request.method() === 'GET'
        && requestUrl.pathname === '/api/images'
        && requestUrl.searchParams.get('folder') === targetPath
    })
    const filteredImageResponse = page.waitForResponse((response) => {
      const responseUrl = new URL(response.url())
      return response.request().method() === 'GET'
        && responseUrl.pathname === '/api/images'
        && responseUrl.searchParams.get('folder') === targetPath
        && response.status() === 200
    })
    await lastFolder.click()
    await Promise.all([filteredImageRequest, filteredImageResponse])
    await expect.poll(() => page.evaluate(() => (window as any).App?.AppState?.filters?.folder))
      .toBe(targetPath)
    await expect(lastFolder).toHaveAttribute('aria-pressed', 'true')
    await expect(tree).toBeVisible()
  }

  expect(consoleProblems).toEqual([])
})
