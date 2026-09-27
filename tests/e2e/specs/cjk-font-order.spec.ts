import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Simplified Chinese is drawn with a Simplified Chinese font (V3.5 subtraction 1).
 *
 * `system-ui` sat before "Microsoft YaHei" in --font-body. On a Traditional
 * Chinese Windows, system-ui hands CJK glyphs to Microsoft JhengHei, so the
 * whole zh-CN UI was drawn in a Traditional font and 。、 sat centred in the
 * cell. YaHei now comes before system-ui; Latin text still uses Segoe UI.
 */

const PROBED_ELEMENTS = ['body', '#btn-scan', '.nav-tab', 'select', 'input'] as const

async function openChineseGallery(page: Page) {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
}

function familyList(stack: string): string[] {
  return stack.split(',').map((name) => name.trim().replace(/^["']|["']$/g, ''))
}

/** The fonts Chromium really used for a node's glyphs (not the CSS wish list). */
async function drawnFontFamilies(page: Page, selector: string): Promise<string[]> {
  const client = await page.context().newCDPSession(page)
  await client.send('DOM.enable')
  await client.send('CSS.enable')
  const { root } = await client.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector })
  const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId })
  await client.detach()
  return fonts.map((font) => font.familyName)
}

test('Chinese text lists Microsoft YaHei before system-ui everywhere it is drawn', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openChineseGallery(page)

  const stacks = await page.evaluate((selectors) => selectors.map((selector) => {
    const element = document.querySelector(selector)
    return { selector, stack: element ? getComputedStyle(element).fontFamily : '' }
  }), [...PROBED_ELEMENTS])

  for (const { selector, stack } of stacks) {
    const families = familyList(stack)
    const systemUi = families.indexOf('system-ui')
    expect(systemUi, `${selector} keeps system-ui as a fallback`).toBeGreaterThan(-1)
    expect(families.indexOf('Microsoft YaHei UI'), `${selector}: ${stack}`).toBeGreaterThan(-1)
    expect(families.indexOf('Microsoft YaHei UI'), `${selector}: ${stack}`).toBeLessThan(systemUi)
    expect(families.indexOf('Microsoft YaHei'), `${selector}: ${stack}`).toBeLessThan(systemUi)
    expect(families.indexOf('Segoe UI'), `${selector}: Latin stays Segoe UI`).toBeLessThan(
      families.indexOf('Microsoft YaHei UI'),
    )
  }

  // Where Windows fonts exist, the glyphs of "导入图片" must come from YaHei,
  // never from the Traditional JhengHei. Other systems draw no Microsoft font.
  const drawn = await drawnFontFamilies(page, '#btn-scan [data-i18n="action.scan"]')
  expect(drawn.length).toBeGreaterThan(0)
  for (const family of drawn.filter((name) => name.startsWith('Microsoft'))) {
    expect(family).toMatch(/^Microsoft YaHei/)
  }
})
