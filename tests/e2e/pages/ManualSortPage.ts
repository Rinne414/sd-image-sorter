import { Locator, Page, expect } from '@playwright/test'

/**
 * Page Object Model for the Manual Sort view
 */
export class ManualSortPage {
  readonly page: Page

  // Sort session elements
  readonly startSortButton: Locator
  readonly sortImage: Locator
  readonly sortPrompt: Locator
  readonly sortProgress: Locator
  readonly sortFolders: Locator

  // Action buttons
  readonly moveButtons: Locator
  readonly skipButton: Locator
  readonly undoButton: Locator
  readonly endSessionButton: Locator

  // Folder configuration
  readonly folderConfigModal: Locator
  readonly addFolderButton: Locator
  readonly folderInputs: Locator

  constructor(page: Page) {
    this.page = page

    // Sort session elements
    this.startSortButton = page.locator('#start-sort-button')
    this.sortImage = page.locator('#sort-current-image')
    this.sortPrompt = page.locator('#sort-prompt')
    this.sortProgress = page.locator('#sort-progress')
    this.sortFolders = page.locator('.sort-folders')

    // Action buttons
    this.moveButtons = page.locator('.move-btn')
    this.skipButton = page.locator('#skip-btn')
    this.undoButton = page.locator('#undo-btn')
    this.endSessionButton = page.locator('#end-sort-btn')

    // Folder configuration
    this.folderConfigModal = page.locator('#folder-config-modal')
    this.addFolderButton = page.locator('#add-folder-btn')
    this.folderInputs = page.locator('.folder-input')
  }

  /**
   * Navigate to Manual Sort tab
   */
  async goto() {
    await this.page.goto('/')
    await this.page.locator('[data-view="manual-sort"]').click()
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Configure sort folder
   */
  async configureFolder(key: string, path: string) {
    const input = this.page.locator(`input[data-key="${key}"]`)
    await input.fill(path)
  }

  /**
   * Start sort session
   */
  async startSession() {
    await this.startSortButton.click()
    await this.sortImage.waitFor({ state: 'visible', timeout: 10000 })
  }

  /**
   * Move current image to folder by key
   */
  async moveToFolder(key: string) {
    await this.page.locator(`.move-btn[data-key="${key}"]`).click()
    await this.page.waitForTimeout(300)
  }

  /**
   * Skip current image
   */
  async skipImage() {
    await this.skipButton.click()
    await this.page.waitForTimeout(300)
  }

  /**
   * Undo last action
   */
  async undo() {
    await this.undoButton.click()
    await this.page.waitForTimeout(300)
  }

  /**
   * End sort session
   */
  async endSession() {
    await this.endSessionButton.click()
  }

  /**
   * Get remaining count
   */
  async getRemainingCount(): Promise<number> {
    const text = await this.sortProgress.textContent() || '0'
    const match = text.match(/(\d+)\s*remaining/i)
    return match ? parseInt(match[1], 10) : 0
  }

  /**
   * Verify image is displayed
   */
  async verifyImageVisible() {
    await expect(this.sortImage).toBeVisible()
  }

  /**
   * Verify prompt is displayed
   */
  async verifyPromptContains(text: string) {
    await expect(this.sortPrompt).toContainText(text)
  }

  /**
   * Use keyboard shortcut to sort
   */
  async useKeyboardShortcut(key: string) {
    await this.page.keyboard.press(key)
    await this.page.waitForTimeout(300)
  }
}
