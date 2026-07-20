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
