import { Locator, Page, expect } from '@playwright/test'

/**
 * Page Object Model for the Similarity Search view
 */
export class SimilarityPage {
  readonly page: Page

  // Embedding
  readonly embedButton: Locator
  readonly embedProgress: Locator
  readonly embedStats: Locator

  // Search
  readonly searchInput: Locator
  readonly searchButton: Locator
  readonly similarityThresholdSlider: Locator
  readonly resultsLimitInput: Locator

  // Results
  readonly searchResults: Locator
  readonly resultCards: Locator
  readonly noResultsMessage: Locator

  // Duplicate detection
  readonly findDuplicatesButton: Locator
  readonly duplicateThresholdSlider: Locator
  readonly duplicateResults: Locator

  // Upload
  readonly uploadInput: Locator
  readonly uploadResults: Locator

  constructor(page: Page) {
    this.page = page

    // Embedding
    this.embedButton = page.locator('#btn-similar-embed')
    this.embedProgress = page.locator('#similar-embed-text')
    this.embedStats = page.locator('#embed-stats')

    // Search
    this.searchInput = page.locator('#similar-search-id')
    this.searchButton = page.locator('#btn-similar-search')
    this.similarityThresholdSlider = page.locator('#similarity-threshold')
    this.resultsLimitInput = page.locator('#results-limit')

    // Results
    this.searchResults = page.locator('#similar-results')
    this.resultCards = page.locator('#similar-results > *')
    this.noResultsMessage = page.locator('#similar-results .empty-state')

    // Duplicate detection
    this.findDuplicatesButton = page.locator('#btn-similar-duplicates')
    this.duplicateThresholdSlider = page.locator('#similar-dup-threshold')
    this.duplicateResults = page.locator('#similar-duplicates')

    // Upload
    this.uploadInput = page.locator('#similar-upload-input')
    this.uploadResults = page.locator('#upload-results')
  }

  /**
   * Navigate to Similarity tab
   */
  async goto() {
    await this.page.goto('/')
    await this.page.locator('[data-view="similar"]').click()
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Start embedding images
   */
  async startEmbedding() {
    await this.embedButton.click()
  }

  /**
   * Wait for embedding to complete
   */
  async waitForEmbeddingComplete(timeout = 300000) {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const text = (await this.embedProgress.textContent().catch(() => '')) ?? ''

      if (text.includes('completed') || text.includes('Done') || text.includes('finished')) {
        return true
      }

      if (text.includes('error') || text.includes('failed')) {
        throw new Error(`Embedding failed: ${text}`)
      }

      await this.page.waitForTimeout(1000)
    }

    throw new Error('Embedding timeout')
  }

  /**
   * Get embedding progress
   */
  async getEmbedProgress(): Promise<string> {
    return await this.embedProgress.textContent() || ''
  }

  /**
   * Search by image ID
   */
  async searchByImageId(imageId: number) {
    await this.searchInput.fill(String(imageId))
    await this.searchButton.click()
    await this.page.waitForTimeout(1000)
  }

  /**
   * Set similarity threshold
   */
  async setThreshold(threshold: number) {
    await this.similarityThresholdSlider.fill(String(threshold))
  }

  /**
   * Set results limit
   */
  async setResultsLimit(limit: number) {
    await this.resultsLimitInput.fill(String(limit))
  }

  /**
   * Get result count
   */
  async getResultCount(): Promise<number> {
    return await this.resultCards.count()
  }

  /**
   * Find duplicates
   */
  async findDuplicates(threshold = 0.95) {
    await this.duplicateThresholdSlider.fill(String(threshold))
    await this.findDuplicatesButton.click()
    await this.page.waitForTimeout(2000)
  }

  /**
   * Get duplicate pairs count
   */
  async getDuplicateCount(): Promise<number> {
    const text = await this.duplicateResults.textContent() || ''
    const match = text.match(/(\d+)\s*pairs?\s*found/i)
    return match ? parseInt(match[1], 10) : 0
  }

  /**
   * Upload image for similarity search
   */
  async uploadImage(filePath: string) {
    await this.uploadInput.setInputFiles(filePath)
    await this.page.waitForTimeout(2000)
  }

  /**
   * Verify results contain similar images
   */
  async verifyHasResults() {
    await expect(this.resultCards.first()).toBeVisible({ timeout: 5000 })
  }

  /**
   * Click on a result to view details
   */
  async clickResult(index: number) {
    await this.resultCards.nth(index).click()
  }
}
