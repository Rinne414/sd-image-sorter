import { Locator, Page, expect } from '@playwright/test'

/**
 * Page Object Model for the Auto-Separate view
 */
export class AutoSeparatePage {
  readonly page: Page

  // Scan elements
  readonly scanPathInput: Locator
  readonly scanButton: Locator
  readonly scanProgress: Locator
  readonly scanResetButton: Locator

  // Tagging elements
  readonly tagButton: Locator
  readonly tagProgress: Locator
  readonly tagModelSelect: Locator
  readonly tagResetButton: Locator

  // Batch move elements
  readonly moveTargetInput: Locator
  readonly batchMoveButton: Locator
  readonly batchMoveProgress: Locator

  // Filters for batch operations
  readonly batchGeneratorFilters: Locator
  readonly batchRatingFilters: Locator
  readonly batchTagInput: Locator

  constructor(page: Page) {
    this.page = page

    // Scan elements
    this.scanPathInput = page.locator('#scan-path-input')
    this.scanButton = page.locator('#scan-button')
    this.scanProgress = page.locator('#scan-progress')
    this.scanResetButton = page.locator('#scan-reset-button')

    // Tagging elements
    this.tagButton = page.locator('#tag-button')
    this.tagProgress = page.locator('#tag-progress')
    this.tagModelSelect = page.locator('#tagger-model-select')
    this.tagResetButton = page.locator('#tag-reset-button')

    // Batch move elements
    this.moveTargetInput = page.locator('#move-target-input')
    this.batchMoveButton = page.locator('#batch-move-button')
    this.batchMoveProgress = page.locator('#batch-move-progress')

    // Batch filters
    this.batchGeneratorFilters = page.locator('.batch-generator-filters')
    this.batchRatingFilters = page.locator('.batch-rating-filters')
    this.batchTagInput = page.locator('#batch-tag-input')
  }

  /**
   * Navigate to Auto-Separate tab
   */
  async goto() {
    await this.page.goto('/')
    await this.page.locator('[data-view="auto-separate"]').click()
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Enter scan path
   */
  async enterScanPath(path: string) {
    await this.scanPathInput.fill(path)
  }

  /**
   * Start scan
   */
  async startScan() {
    await this.scanButton.click()
  }

  /**
   * Wait for scan to complete
   */
  async waitForScanComplete(timeout = 60000) {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const text = await this.scanProgress.textContent().catch(() => '')

      if (text.includes('completed') || text.includes('Done') || text.includes('finished')) {
        return true
      }

      if (text.includes('error') || text.includes('failed')) {
        throw new Error(`Scan failed: ${text}`)
      }

      await this.page.waitForTimeout(500)
    }

    throw new Error('Scan timeout')
  }

  /**
   * Get scan progress
   */
  async getScanProgress(): Promise<string> {
    return await this.scanProgress.textContent() || ''
  }

  /**
   * Reset scan
   */
  async resetScan() {
    await this.scanResetButton.click()
  }

  /**
   * Select tagger model
   */
  async selectTaggerModel(model: string) {
    await this.tagModelSelect.selectOption(model)
  }

  /**
   * Start tagging
   */
  async startTagging() {
    await this.tagButton.click()
  }

  /**
   * Wait for tagging to complete
   */
  async waitForTaggingComplete(timeout = 120000) {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const text = await this.tagProgress.textContent().catch(() => '')

      if (text.includes('completed') || text.includes('Done') || text.includes('finished')) {
        return true
      }

      if (text.includes('error') || text.includes('failed')) {
        throw new Error(`Tagging failed: ${text}`)
      }

      await this.page.waitForTimeout(500)
    }

    throw new Error('Tagging timeout')
  }

  /**
   * Get tagging progress
   */
  async getTagProgress(): Promise<string> {
    return await this.tagProgress.textContent() || ''
  }

  /**
   * Reset tagging
   */
  async resetTagging() {
    await this.tagResetButton.click()
  }

  /**
   * Enter batch move target path
   */
  async enterMoveTarget(path: string) {
    await this.moveTargetInput.fill(path)
  }

  /**
   * Start batch move
   */
  async startBatchMove() {
    await this.batchMoveButton.click()
  }

  /**
   * Select generators for batch move
   */
  async selectGeneratorsForBatch(generators: string[]) {
    for (const gen of generators) {
      const checkbox = this.page.locator(`.batch-generator-filters input[value="${gen}"]`)
      await checkbox.check()
    }
  }

  /**
   * Select ratings for batch move
   */
  async selectRatingsForBatch(ratings: string[]) {
    for (const rating of ratings) {
      const checkbox = this.page.locator(`.batch-rating-filters input[value="${rating}"]`)
      await checkbox.check()
    }
  }
}
