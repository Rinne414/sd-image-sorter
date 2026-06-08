import { expect, test, Page } from '@playwright/test'

const LAZY_FIRST_IMAGE = process.env.SD_LAZY_QA_FIRST_IMAGE || ''
const LAZY_COPY_DEST = process.env.SD_LAZY_QA_COPY_DEST || ''

const BENIGN_CONSOLE_PATTERNS = [
  /favicon/i,
  /ResizeObserver loop completed/i,
  /server responded with a status of 503 \(Service Unavailable\)/i,
]

function isBenignConsoleError(text: string): boolean {
  return BENIGN_CONSOLE_PATTERNS.some((pattern) => pattern.test(text))
}

async function openView(page: Page, view: string) {
  // v3.3.3: Prompt Helper + Style Finder live under the "Tools ▾" dropdown.
  const toolItem = page.locator(`#nav-tools-menu [data-view="${view}"]`)
  if (await toolItem.count()) {
    const toggle = page.locator('#nav-tools-toggle')
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click()
      await toolItem.click()
      await expect(page.locator(`#view-${view}`)).toBeVisible({ timeout: 15000 })
      return
    }
  }

  const desktopTab = page.locator(`.nav-tabs [data-view="${view}"]`)
  const mobileOverlay = page.locator('#mobile-nav-overlay')
  const mobileTab = page.locator(`#mobile-nav-overlay .mobile-nav-item[data-view="${view}"]`)
  if (await desktopTab.isVisible().catch(() => false)) {
    await desktopTab.click()
  } else {
    const menuIsOpen = await mobileOverlay.evaluate((el) => el.classList.contains('visible')).catch(() => false)
    if (!menuIsOpen) {
      await page.locator('#mobile-menu-toggle').click()
      await expect(mobileOverlay).toHaveClass(/visible/)
    }
    await page.waitForFunction(() => {
      const menu = document.querySelector('#mobile-nav-overlay .mobile-nav-menu')
      if (!menu) return false
      const rect = menu.getBoundingClientRect()
      return rect.left >= -1 && rect.width > 0
    })
    await mobileTab.scrollIntoViewIfNeeded()
    await mobileTab.click()
  }
  await expect(page.locator(`#view-${view}`)).toBeVisible({ timeout: 15000 })
}

async function dismissStartCards(page: Page) {
  for (const selector of [
    '#similar-start-dismiss',
    '#promptlab-start-dismiss',
    '#artist-start-dismiss',
  ]) {
    const button = page.locator(selector)
    if (await button.isVisible().catch(() => false)) {
      await button.click()
    }
  }
}

async function expectNoHorizontalOverflow(page: Page, allowance = 24) {
  const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth))
  expect(overflow).toBeLessThanOrEqual(allowance)
}

test.describe('lazy human frontend QA', () => {
  test.skip(process.env.SD_LAZY_QA_FRONTEND !== '1', 'Run through scripts/lazy_release_qa.py --frontend with seeded QA data')
  test.setTimeout(180_000)

  test('clicks through real UI workflows without mocks', async ({ page, request, context, baseURL }) => {
    const consoleErrors: string[] = []
    const pageErrors: string[] = []

    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const text = message.text()
      if (!isBenignConsoleError(text)) {
        consoleErrors.push(text)
      }
    })
    page.on('pageerror', (error) => {
      pageErrors.push(error.message)
    })

    if (baseURL) {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
    }

    const imagesResponse = await request.get('/api/images?limit=3&sort_by=newest')
    expect(imagesResponse.ok()).toBeTruthy()
    const imagePayload = await imagesResponse.json()
    expect(Array.isArray(imagePayload.images)).toBeTruthy()
    expect(imagePayload.images.length).toBeGreaterThan(0)
    const firstImage = imagePayload.images[0]
    const firstImagePath = LAZY_FIRST_IMAGE || firstImage.path
    expect(firstImagePath).toBeTruthy()

    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#view-gallery')).toBeVisible()
    await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible({ timeout: 20_000 })
    await expectNoHorizontalOverflow(page)

    // Gallery: real card, detail modal, zoom controls, metadata copy buttons, close cleanup path.
    await page.locator('#gallery-grid .gallery-item').first().click()
    await expect(page.locator('#image-modal.visible')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#modal-image')).toBeVisible()
    await page.locator('#btn-copy-prompt').click()
    await page.locator('#modal-next-image').click()
    await page.locator('#modal-prev-image').click()
    await page.locator('#modal-close').click()
    await expect(page.locator('#image-modal.visible')).toHaveCount(0)

    // Gallery filters: open modal, type a real search term, apply, then clear.
    await page.locator('#btn-open-filters').click()
    await expect(page.locator('#filter-modal.visible')).toBeVisible()
    await page.locator('#modal-free-text-search').fill('qa_prompt')
    await page.locator('#btn-apply-modal-filters').click()
    await expect(page.locator('#filter-modal.visible')).toHaveCount(0)
    await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible({ timeout: 15_000 })
    await page.locator('#btn-clear-filters').click()
    await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible({ timeout: 15_000 })

    // Selection: select a real item, export modal opens, then send selection to Censor.
    await page.locator('#btn-toggle-select').click()
    await page.locator('#gallery-grid .gallery-item').first().click()
    await expect(page.locator('#selection-actions')).toBeVisible()
    await expect(page.locator('#selection-count')).not.toContainText(/^0\b/)
    await page.locator('#btn-export-selected').click()
    await expect(page.locator('#export-modal.visible')).toBeVisible({ timeout: 10_000 })
    await page.locator('#btn-close-export').click()
    await expect(page.locator('#export-modal.visible')).toHaveCount(0)
    await expect(page.locator('#btn-send-to-censor')).toBeEnabled()
    await page.locator('#btn-send-to-censor').click()

    // Censor: queue receives the selected image, core tool buttons and safe controls respond.
    await expect(page.locator('#view-censor')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#censor-queue-list .queue-thumb-v2').first()).toBeVisible({ timeout: 20_000 })
    for (const tool of ['brush', 'pen', 'eraser', 'clone']) {
      await page.locator(`.tool-btn-v2[data-tool="${tool}"]`).click()
      await expect(page.locator(`.tool-btn-v2[data-tool="${tool}"]`)).toHaveClass(/active/)
    }
    await page.locator('#btn-zoom-in').click()
    await page.locator('#btn-zoom-fit').click()
    await page.locator('#btn-open-detect-modal').click()
    await expect(page.locator('#detect-modal.visible')).toBeVisible()
    await page.locator('#btn-close-detect-modal').click()
    await expect(page.locator('#detect-modal.visible')).toHaveCount(0)
    await page.locator('#btn-open-queue-manager').click()
    await expect(page.locator('#queue-solitaire')).toBeVisible()
    const qsFilterBar = page.locator('#qs-filter-bar')
    if (!(await qsFilterBar.isVisible().catch(() => false))) {
      await page.locator('#qs-btn-filter').click()
    }
    await expect(qsFilterBar).toBeVisible()
    await page.locator('#qs-filter-tag').fill('qa_prompt')
    await page.locator('#qs-filter-apply').click()
    await expect(page.locator('#qs-filter-match-count')).toContainText(/matching/i)
    await page.locator('#qs-btn-done').click()

    // Reader: upload a real scanned image through the UI and exercise copy/toggle buttons.
    await openView(page, 'reader')
    await page.locator('#reader-file-input').setInputFiles(firstImagePath)
    await expect(page.locator('#reader-result-panel')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#reader-prompt-text')).toBeVisible()
    await page.locator('#reader-toggle-format').click()
    await page.locator('#reader-copy-prompt').click()
    await page.locator('#reader-copy-all').click()

    // Obfuscation: real image file, button click, queue transitions to done, then clear.
    await page.locator('#reader-tool-tab-obfuscation').click()
    await expect(page.locator('#reader-tool-panel-obfuscation')).toBeVisible()
    await page.locator('#obfuscate-file-input').setInputFiles(firstImagePath)
    const obfuscateItem = page.locator('.obfuscate-item').first()
    await expect(obfuscateItem).toBeVisible({ timeout: 10_000 })
    await page.locator('#obfuscate-password').fill('lazy-human')
    await page.locator('#obfuscate-btn-encode').click()
    await expect(obfuscateItem).toHaveClass(/done/, { timeout: 20_000 })
    await page.locator('#obfuscate-settings-toggle').click()
    await expect(page.locator('#obfuscate-advanced-settings')).toBeVisible()
    await page.locator('#obfuscate-btn-clear').click()
    await expect(page.locator('.obfuscate-item')).toHaveCount(0)

    // Sorting / Auto-Separate: verify promoted action controls and preview a real destination.
    await openView(page, 'sorting')
    await expect(page.locator('#view-autosep')).toBeVisible()
    await page.locator('input[name="autosep-operation-mode-main"][value="copy"]').check({ force: true })
    if (LAZY_COPY_DEST) {
      await page.locator('#autosep-destination').fill(LAZY_COPY_DEST)
    }
    await page.locator('#btn-preview-autosep').click()
    await expect(page.locator('#autosep-preview')).toBeVisible()
    await page.locator('#btn-autosep-settings').click()
    await expect(page.locator('#autosep-settings-modal.visible')).toBeVisible()
    await expect(page.locator('#autosep-settings-modal input[data-autosep-setting="autoPreview"]')).toHaveCount(1)
    await expect(page.locator('#autosep-settings-modal input[data-autosep-setting="rememberDestination"]')).toHaveCount(0)
    await expect(page.locator('#autosep-settings-modal input[data-autosep-setting="confirmBeforeMove"]')).toHaveCount(0)
    await expect(page.locator('#autosep-settings-modal input[data-autosep-operation-mode]')).toHaveCount(0)
    await page.locator('#btn-cancel-autosep-settings').click()
    await expect(page.locator('#autosep-settings-modal.visible')).toHaveCount(0)

    // Manual sort: open controls without committing destructive moves.
    await page.locator('[data-sorting-sub="manual"]').click()
    await expect(page.locator('#view-manual')).toBeVisible()
    await page.locator('input[name="manual-sort-operation"][value="copy"]').check({ force: true })
    await page.locator('#btn-manual-sort-filters').click()
    await expect(page.locator('#filter-modal.visible')).toBeVisible()
    await page.locator('#btn-apply-modal-filters').click()

    // Similarity: status/search controls should be visible and safe even when optional models are missing.
    await openView(page, 'similar')
    await dismissStartCards(page)
    await expect(page.locator('#similar-model-health')).toBeVisible()
    const similarSearchId = page.locator('#similar-search-id')
    if (await similarSearchId.isVisible().catch(() => false)) {
      await expect(similarSearchId).toBeEnabled()
      await similarSearchId.fill(String(firstImage.id))
      await page.locator('#btn-similar-search').click()
      await expect(page.locator('#similar-results')).toBeVisible()
    } else {
      await expect(page.locator('#similar-workflow-status')).toBeVisible()
      await page.locator('#btn-similar-status-embed').click()
      await expect(page.locator('#similar-workflow-status')).toBeVisible()
    }

    // Prompt Lab: tab switching and generate/validate buttons should work without layout breakage.
    await openView(page, 'promptlab')
    await dismissStartCards(page)
    for (const mode of ['stats', 'compare', 'build', 'random']) {
      await page.locator(`.promptlab-tab[data-mode="${mode}"]`).click()
      await expect(page.locator(`#promptlab-mode-${mode}`)).toHaveClass(/active/)
    }
    await page.locator('#btn-promptlab-random').click()
    await page.locator('#btn-promptlab-generate').click()
    await expect(page.locator('#promptlab-output')).toBeVisible()
    await page.locator('#btn-promptlab-validate').click()

    // Artist: diagnostics/stats view controls and grid/list toggle.
    await openView(page, 'artist')
    await dismissStartCards(page)
    await expect(page.locator('#artist-model-health')).toBeVisible()
    await page.locator('#btn-refresh-artist-stats').click()
    await page.locator('#view-artist .toggle-btn[data-view="list"]').click()
    await expect(page.locator('#view-artist .toggle-btn[data-view="list"]')).toHaveClass(/active/)
    await page.locator('#view-artist .toggle-btn[data-view="grid"]').click()

    // Model manager and language toggle are global UI affordances users actually click.
    await openView(page, 'gallery')
    await page.locator('#btn-open-model-manager').click()
    await expect(page.locator('#model-manager-modal.visible')).toBeVisible({ timeout: 15_000 })
    await page.locator('#model-manager-close').click()
    await expect(page.locator('#model-manager-modal.visible')).toHaveCount(0)
    await page.locator('#btn-language-toggle').click()
    await expect(page.locator('#view-gallery')).toBeVisible()

    // Mobile nav sanity: act like a phone user and switch views from the mobile bar.
    await page.setViewportSize({ width: 390, height: 844 })
    await expectNoHorizontalOverflow(page, 48)
    await openView(page, 'reader')
    await openView(page, 'gallery')

    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  })
})
