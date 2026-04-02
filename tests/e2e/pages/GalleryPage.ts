import { Locator, Page, expect } from '@playwright/test'

/**
 * Page Object Model for the Gallery view
 */
export class GalleryPage {
  readonly page: Page
  readonly galleryTab: Locator
  readonly autoSeparateTab: Locator
  readonly manualSortTab: Locator
  readonly censorEditorTab: Locator
  readonly promptLabTab: Locator
  readonly similarityTab: Locator
  readonly artistIdentTab: Locator

  // Filter elements
  readonly generatorFilters: Locator
  readonly ratingFilters: Locator
  readonly tagFilterInput: Locator
  readonly searchInput: Locator
  readonly sortDropdown: Locator

  // Gallery elements
  readonly imageGrid: Locator
  readonly imageCards: Locator
  readonly loadingIndicator: Locator
  readonly noResultsMessage: Locator

  // Image detail modal
  readonly imageModal: Locator
  readonly modalImage: Locator
  readonly modalPrompt: Locator
  readonly modalTags: Locator
  readonly modalCloseButton: Locator

  constructor(page: Page) {
    this.page = page

    // Navigation tabs
    this.galleryTab = page.locator('[data-view="gallery"]')
    this.autoSeparateTab = page.locator('[data-view="auto-separate"]')
    this.manualSortTab = page.locator('[data-view="manual-sort"]')
    this.censorEditorTab = page.locator('[data-view="censor"]')
    this.promptLabTab = page.locator('[data-view="prompt-lab"]')
    this.similarityTab = page.locator('[data-view="similarity"]')
    this.artistIdentTab = page.locator('[data-view="artist-ident"]')

    // Filter elements
    this.generatorFilters = page.locator('.generator-filters')
    this.ratingFilters = page.locator('.rating-filters')
    this.tagFilterInput = page.locator('#tag-filter-input')
    this.searchInput = page.locator('#search-input')
    this.sortDropdown = page.locator('#sort-select')

    // Gallery elements
    this.imageGrid = page.locator('#image-grid')
    this.imageCards = page.locator('.image-card')
    this.loadingIndicator = page.locator('.loading-indicator')
    this.noResultsMessage = page.locator('.no-results')

    // Image detail modal
    this.imageModal = page.locator('#image-modal')
    this.modalImage = page.locator('#modal-image')
    this.modalPrompt = page.locator('#modal-prompt')
    this.modalTags = page.locator('#modal-tags')
    this.modalCloseButton = page.locator('#modal-close')
  }

  /**
   * Navigate to the gallery page
   */
  async goto() {
    await this.page.goto('/')
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Navigate to a specific view/tab
   */
  async navigateToView(view: string) {
    await this.page.locator(`[data-view="${view}"]`).click()
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Wait for images to load
   */
  async waitForImages(timeout = 10000) {
    await this.imageCards.first().waitFor({ state: 'visible', timeout })
  }

  /**
   * Get the count of visible images
   */
  async getImageCount(): Promise<number> {
    return await this.imageCards.count()
  }

  /**
   * Click on an image by index
   */
  async clickImage(index: number) {
    await this.imageCards.nth(index).click()
    await this.imageModal.waitFor({ state: 'visible' })
  }

  /**
   * Close the image modal
   */
  async closeModal() {
    await this.modalCloseButton.click()
    await this.imageModal.waitFor({ state: 'hidden' })
  }

  /**
   * Toggle a generator filter
   */
  async toggleGeneratorFilter(generator: string) {
    const checkbox = this.page.locator(`input[value="${generator}"]`)
    await checkbox.click()
    await this.page.waitForTimeout(500) // Wait for filter to apply
  }

  /**
   * Toggle a rating filter
   */
  async toggleRatingFilter(rating: string) {
    const checkbox = this.page.locator(`input[value="${rating}"]`)
    await checkbox.click()
    await this.page.waitForTimeout(500)
  }

  /**
   * Enter search query
   */
  async search(query: string) {
    await this.searchInput.fill(query)
    await this.page.waitForTimeout(500)
  }

  /**
   * Clear search
   */
  async clearSearch() {
    await this.searchInput.clear()
    await this.page.waitForTimeout(500)
  }

  /**
   * Select sort option
   */
  async selectSort(sortBy: string) {
    await this.sortDropdown.selectOption(sortBy)
    await this.page.waitForTimeout(500)
  }

  /**
   * Verify image modal displays correct data
   */
  async verifyImageModal(expected: { prompt?: string; tags?: string[] }) {
    if (expected.prompt) {
      await expect(this.modalPrompt).toContainText(expected.prompt)
    }

    if (expected.tags) {
      for (const tag of expected.tags) {
        await expect(this.modalTags).toContainText(tag)
      }
    }
  }

  /**
   * Scroll to load more images (infinite scroll)
   */
  async scrollForMoreImages() {
    await this.page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight)
    })
    await this.page.waitForTimeout(1000)
  }

  /**
   * Enable selection mode
   */
  async enableSelectionMode() {
    await this.page.locator('#selection-mode-btn').click()
  }

  /**
   * Select multiple images
   */
  async selectImages(indices: number[]) {
    await this.enableSelectionMode()
    for (const index of indices) {
      await this.imageCards.nth(index).click()
    }
  }
}
