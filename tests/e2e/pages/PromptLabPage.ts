import { Locator, Page, expect } from '@playwright/test'

/**
 * Page Object Model for the Prompt Lab view
 */
export class PromptLabPage {
  readonly page: Page

  // Category selectors
  readonly characterSelect: Locator
  readonly outfitSelect: Locator
  readonly poseSelect: Locator
  readonly expressionSelect: Locator
  readonly angleSelect: Locator
  readonly backgroundSelect: Locator
  readonly styleSelect: Locator
  readonly artistSelect: Locator
  readonly bodySelect: Locator

  // Generation options
  readonly qualityPresetSelect: Locator
  readonly countTagInput: Locator
  readonly nsfwCheckbox: Locator
  readonly negativePromptCheckbox: Locator
  readonly seedInput: Locator

  // Actions
  readonly generateButton: Locator
  readonly regenerateButton: Locator
  readonly copyPromptButton: Locator
  readonly copyNegativeButton: Locator
  readonly savePresetButton: Locator
  readonly loadPresetSelect: Locator

  // Results
  readonly generatedPrompt: Locator
  readonly generatedNegative: Locator
  readonly usedSeed: Locator

  // Tag sets and exclusions
  readonly tagSetsList: Locator
  readonly exclusionRulesList: Locator
  readonly createTagSetButton: Locator
  readonly createExclusionButton: Locator

  constructor(page: Page) {
    this.page = page

    // Category selectors
    this.characterSelect = page.locator('#character-select')
    this.outfitSelect = page.locator('#outfit-select')
    this.poseSelect = page.locator('#pose-select')
    this.expressionSelect = page.locator('#expression-select')
    this.angleSelect = page.locator('#angle-select')
    this.backgroundSelect = page.locator('#background-select')
    this.styleSelect = page.locator('#style-select')
    this.artistSelect = page.locator('#artist-select')
    this.bodySelect = page.locator('#body-select')

    // Generation options
    this.qualityPresetSelect = page.locator('#quality-preset-select')
    this.countTagInput = page.locator('#count-tag-input')
    this.nsfwCheckbox = page.locator('#nsfw-checkbox')
    this.negativePromptCheckbox = page.locator('#negative-prompt-checkbox')
    this.seedInput = page.locator('#seed-input')

    // Actions
    this.generateButton = page.locator('#btn-promptlab-generate')
    this.regenerateButton = page.locator('#btn-promptlab-random')
    this.copyPromptButton = page.locator('#btn-promptlab-copy')
    this.copyNegativeButton = page.locator('#copy-negative-btn')
    this.savePresetButton = page.locator('#btn-promptlab-save-preset')
    this.loadPresetSelect = page.locator('#load-preset-select')

    // Results
    this.generatedPrompt = page.locator('#promptlab-output')
    this.generatedNegative = page.locator('#generated-negative')
    this.usedSeed = page.locator('#used-seed')

    // Tag sets and exclusions
    this.tagSetsList = page.locator('#tag-sets-list')
    this.exclusionRulesList = page.locator('#exclusion-rules-list')
    this.createTagSetButton = page.locator('#create-tag-set-btn')
    this.createExclusionButton = page.locator('#create-exclusion-btn')
  }

  /**
   * Navigate to Prompt Lab tab
   */
  async goto() {
    await this.page.goto('/')
    // v3.3.3: Prompt Lab now lives under the "Tools ▾" dropdown.
    await this.page.locator('#nav-tools-toggle').click()
    await this.page.locator('#nav-tools-menu [data-view="promptlab"]').click()
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Select character option
   */
  async selectCharacter(character: string) {
    await this.characterSelect.selectOption(character)
  }

  /**
   * Select outfit option
   */
  async selectOutfit(outfit: string) {
    await this.outfitSelect.selectOption(outfit)
  }

  /**
   * Select pose option
   */
  async selectPose(pose: string) {
    await this.poseSelect.selectOption(pose)
  }

  /**
   * Select quality preset
   */
  async selectQualityPreset(preset: 'high' | 'medium' | 'low') {
    await this.qualityPresetSelect.selectOption(preset)
  }

  /**
   * Set count tag
   */
  async setCountTag(tag: string) {
    await this.countTagInput.fill(tag)
  }

  /**
   * Set seed for reproducibility
   */
  async setSeed(seed: number) {
    await this.seedInput.fill(String(seed))
  }

  /**
   * Toggle NSFW
   */
  async toggleNsfw(enabled: boolean) {
    if (enabled) {
      await this.nsfwCheckbox.check()
    } else {
      await this.nsfwCheckbox.uncheck()
    }
  }

  /**
   * Toggle negative prompt
   */
  async toggleNegativePrompt(enabled: boolean) {
    if (enabled) {
      await this.negativePromptCheckbox.check()
    } else {
      await this.negativePromptCheckbox.uncheck()
    }
  }

  /**
   * Generate prompt
   */
  async generate() {
    await this.generateButton.click()
    await this.page.waitForTimeout(1000)
  }

  /**
   * Regenerate with new random
   */
  async regenerate() {
    await this.regenerateButton.click()
    await this.page.waitForTimeout(1000)
  }

  /**
   * Get generated prompt text
   */
  async getGeneratedPrompt(): Promise<string> {
    return await this.generatedPrompt.textContent() || ''
  }

  /**
   * Get generated negative prompt text
   */
  async getGeneratedNegative(): Promise<string> {
    return await this.generatedNegative.textContent() || ''
  }

  /**
   * Get used seed
   */
  async getUsedSeed(): Promise<number> {
    const text = await this.usedSeed.textContent() || '0'
    return parseInt(text, 10)
  }

  /**
   * Copy prompt to clipboard
   */
  async copyPrompt() {
    await this.copyPromptButton.click()
  }

  /**
   * Copy negative prompt to clipboard
   */
  async copyNegative() {
    await this.copyNegativeButton.click()
  }

  /**
   * Save current config as preset
   */
  async savePreset(name: string) {
    await this.page.locator('#preset-name-input').fill(name)
    await this.savePresetButton.click()
  }

  /**
   * Load a preset
   */
  async loadPreset(presetId: number) {
    await this.loadPresetSelect.selectOption(String(presetId))
  }

  /**
   * Verify prompt contains expected tags
   */
  async verifyPromptContains(tags: string[]) {
    const prompt = await this.getGeneratedPrompt()
    for (const tag of tags) {
      expect(prompt.toLowerCase()).toContain(tag.toLowerCase())
    }
  }

  /**
   * Verify negative prompt contains expected terms
   */
  async verifyNegativeContains(terms: string[]) {
    const negative = await this.getGeneratedNegative()
    for (const term of terms) {
      expect(negative.toLowerCase()).toContain(term.toLowerCase())
    }
  }
}
