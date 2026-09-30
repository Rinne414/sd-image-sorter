import { Locator, Page } from '@playwright/test'

/** Page Object Model for the Style Map view (画风地图). */
export class StyleMapPage {
  readonly page: Page
  readonly tab: Locator
  readonly mirror: Locator
  readonly view: Locator
  readonly spaceSelect: Locator
  readonly layoutStatus: Locator
  readonly layoutText: Locator
  readonly installButton: Locator
  readonly retryButton: Locator
  readonly buildButton: Locator
  readonly progressRow: Locator
  readonly progressText: Locator
  readonly scope: Locator
  readonly canvas: Locator
  readonly emptyCard: Locator
  readonly emptyBuildButton: Locator
  readonly previewImage: Locator
  readonly previewHint: Locator
  readonly resetViewButton: Locator

  constructor(page: Page) {
    this.page = page
    this.tab = page.locator('#nav-tab-stylemap')
    this.mirror = page.locator('#nav-tools-stylemap')
    this.view = page.locator('#view-stylemap')
    this.spaceSelect = page.locator('#stylemap-space')
    this.layoutStatus = page.locator('#stylemap-layout')
    this.layoutText = page.locator('#stylemap-layout-text')
    this.installButton = page.locator('#stylemap-install-umap')
    this.retryButton = page.locator('#stylemap-retry-layout')
    this.buildButton = page.locator('#stylemap-build-btn')
    this.progressRow = page.locator('#stylemap-index-progress')
    this.progressText = page.locator('#stylemap-index-text')
    this.scope = page.locator('#stylemap-scope')
    this.canvas = page.locator('#stylemap-canvas')
    this.emptyCard = page.locator('#stylemap-empty')
    this.emptyBuildButton = page.locator('#stylemap-empty-build')
    this.previewImage = page.locator('#stylemap-preview-img')
    this.previewHint = page.locator('#stylemap-preview-hint')
    this.resetViewButton = page.locator('#stylemap-reset-view')
  }

  /** Open the view through whichever entrance the bar shows at this width. */
  async open(): Promise<void> {
    if (await this.tab.isVisible()) {
      await this.tab.click()
    } else {
      await this.page.click('#nav-tools-toggle')
      await this.mirror.click()
    }
    await this.view.waitFor({ state: 'visible' })
  }

  /** Number of dots the scene currently holds (bypasses WebGL readback). */
  async pointCount(): Promise<number> {
    return this.page.evaluate(() => (window as any).StyleMap?._state?.scene?.count ?? -1)
  }
}
