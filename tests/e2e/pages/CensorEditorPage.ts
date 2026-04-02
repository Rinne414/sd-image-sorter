import { Locator, Page, expect } from '@playwright/test'

/**
 * Page Object Model for the Censor Editor view
 */
export class CensorEditorPage {
  readonly page: Page

  // Image selection
  readonly imageSelectInput: Locator
  readonly loadImageButton: Locator
  readonly currentImage: Locator

  // Detection
  readonly detectButton: Locator
  readonly modelSelect: Locator
  readonly exposedOnlyCheckbox: Locator
  readonly detectionResults: Locator

  // Censoring tools
  readonly brushTool: Locator
  readonly penTool: Locator
  readonly eraserTool: Locator
  readonly cloneTool: Locator
  readonly autoDetectButton: Locator

  // Censoring options
  readonly mosaicStyle: Locator
  readonly blurStyle: Locator
  readonly solidStyle: Locator
  readonly stickerStyle: Locator

  // Intensity controls
  readonly intensitySlider: Locator
  readonly brushSizeSlider: Locator

  // Actions
  readonly previewButton: Locator
  readonly saveButton: Locator
  readonly saveDataButton: Locator
  readonly outputFolderInput: Locator

  // Canvas
  readonly censorCanvas: Locator

  constructor(page: Page) {
    this.page = page

    // Image selection
    this.imageSelectInput = page.locator('#censor-image-select')
    this.loadImageButton = page.locator('#load-image-btn')
    this.currentImage = page.locator('#censor-source-image')

    // Detection
    this.detectButton = page.locator('#detect-btn')
    this.modelSelect = page.locator('#detector-model-select')
    this.exposedOnlyCheckbox = page.locator('#exposed-only-checkbox')
    this.detectionResults = page.locator('#detection-results')

    // Censoring tools
    this.brushTool = page.locator('[data-tool="brush"]')
    this.penTool = page.locator('[data-tool="pen"]')
    this.eraserTool = page.locator('[data-tool="eraser"]')
    this.cloneTool = page.locator('[data-tool="clone"]')
    this.autoDetectButton = page.locator('#auto-detect-btn')

    // Censoring options
    this.mosaicStyle = page.locator('[data-style="mosaic"]')
    this.blurStyle = page.locator('[data-style="blur"]')
    this.solidStyle = page.locator('[data-style="solid"]')
    this.stickerStyle = page.locator('[data-style="sticker"]')

    // Intensity controls
    this.intensitySlider = page.locator('#intensity-slider')
    this.brushSizeSlider = page.locator('#brush-size-slider')

    // Actions
    this.previewButton = page.locator('#preview-btn')
    this.saveButton = page.locator('#save-censor-btn')
    this.saveDataButton = page.locator('#save-data-btn')
    this.outputFolderInput = page.locator('#censor-output-folder')

    // Canvas
    this.censorCanvas = page.locator('#censor-canvas')
  }

  /**
   * Navigate to Censor Editor tab
   */
  async goto() {
    await this.page.goto('/')
    await this.page.locator('[data-view="censor"]').click()
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Load image by ID
   */
  async loadImage(imageId: number) {
    await this.imageSelectInput.fill(String(imageId))
    await this.loadImageButton.click()
    await this.currentImage.waitFor({ state: 'visible', timeout: 10000 })
  }

  /**
   * Select detection model
   */
  async selectModel(model: 'legacy' | 'nudenet' | 'both') {
    await this.modelSelect.selectOption(model)
  }

  /**
   * Run detection
   */
  async runDetection() {
    await this.detectButton.click()
    await this.page.waitForTimeout(2000) // Wait for detection
  }

  /**
   * Get detection count
   */
  async getDetectionCount(): Promise<number> {
    const items = await this.detectionResults.locator('.detection-item').count()
    return items
  }

  /**
   * Select censoring style
   */
  async selectStyle(style: 'mosaic' | 'blur' | 'solid' | 'sticker') {
    await this.page.locator(`[data-style="${style}"]`).click()
  }

  /**
   * Select tool
   */
  async selectTool(tool: 'brush' | 'pen' | 'eraser' | 'clone') {
    await this.page.locator(`[data-tool="${tool}"]`).click()
  }

  /**
   * Set intensity
   */
  async setIntensity(value: number) {
    await this.intensitySlider.fill(String(value))
  }

  /**
   * Set brush size
   */
  async setBrushSize(size: number) {
    await this.brushSizeSlider.fill(String(size))
  }

  /**
   * Draw on canvas (simple horizontal line)
   */
  async drawOnCanvas(x: number, y: number, width: number) {
    const canvas = this.censorCanvas
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Canvas not found')

    await this.page.mouse.move(box.x + x, box.y + y)
    await this.page.mouse.down()
    await this.page.mouse.move(box.x + x + width, box.y + y)
    await this.page.mouse.up()
  }

  /**
   * Preview censoring
   */
  async preview() {
    await this.previewButton.click()
    await this.page.waitForTimeout(1000)
  }

  /**
   * Save censored image
   */
  async save(outputFolder: string) {
    await this.outputFolderInput.fill(outputFolder)
    await this.saveButton.click()
    await this.page.waitForTimeout(1000)
  }

  /**
   * Set exposed only filter
   */
  async setExposedOnly(enabled: boolean) {
    if (enabled) {
      await this.exposedOnlyCheckbox.check()
    } else {
      await this.exposedOnlyCheckbox.uncheck()
    }
  }

  /**
   * Click on a detection result to apply censoring
   */
  async clickDetection(index: number) {
    await this.detectionResults.locator('.detection-item').nth(index).click()
  }

  /**
   * Apply auto-detection and censoring
   */
  async autoDetectAndCensor() {
    await this.autoDetectButton.click()
    await this.page.waitForTimeout(2000)
  }
}
