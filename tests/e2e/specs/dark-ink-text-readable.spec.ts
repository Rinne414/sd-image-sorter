import { expect, test, type Page } from '@playwright/test'

/**
 * --accent-contrast was light text when these rules were written; the Graphite
 * tokens made it the dark ink that goes on a solid amber fill. Two places kept
 * using it as text on a dark surface and went dark on dark: the Queue Manager
 * title and the selected LoRA preset chip. Both must read at WCAG AA (4.5:1)
 * against what is actually behind them.
 */

test.use({ viewport: { width: 1366, height: 768 } })

/** Contrast of an element's text against its painted background (translucent layers composited). */
async function textContrast(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => {
    const parse = (value: string) => {
      const parts = (value.match(/rgba?\(([^)]+)\)/)?.[1] || '0,0,0,0').split(',').map((part) => parseFloat(part))
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
    }
    const layers = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      const background = parse(getComputedStyle(node).backgroundColor)
      if (background.a > 0) layers.push(background)
      if (background.a >= 1) break
    }
    let base = { r: 0, g: 0, b: 0 }
    for (const layer of layers.reverse()) {
      base = {
        r: layer.r * layer.a + base.r * (1 - layer.a),
        g: layer.g * layer.a + base.g * (1 - layer.a),
        b: layer.b * layer.a + base.b * (1 - layer.a),
      }
    }
    const text = parse(getComputedStyle(element).color)
    const luminance = ({ r, g, b }: { r: number, g: number, b: number }) => {
      const channel = (value: number) => {
        const v = value / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const [lighter, darker] = [luminance(text), luminance(base)].sort((a, b) => b - a)
    return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100
  })
}

async function openApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => Boolean((window as any).QueueSolitaire && (window as any).V321Integration))
}

/** Colours are read once the element's transitions (hover, active) have finished. */
async function settled(page: Page, selector: string) {
  await expect.poll(() => page.locator(selector).first().evaluate((element) => element.getAnimations().length)).toBe(0)
}

test('the Queue Manager title reads against its toolbar', async ({ page }) => {
  await openApp(page)
  // The Queue Manager lives in the Censor editor.
  await page.evaluate(() => (window as any).App.switchView('censor'))
  await page.evaluate(() => (window as any).QueueSolitaire.open())
  await expect(page.locator('.qs-toolbar-title').first()).toBeVisible()
  await settled(page, '.qs-toolbar-title')
  expect(await textContrast(page, '.qs-toolbar-title')).toBeGreaterThanOrEqual(4.5)
})

test('the selected LoRA preset chip reads against its tint', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const show = (window as any).App?.showModal || (window as any).showModal
    show('batch-export-modal')
    const mode = document.getElementById('batch-export-content-mode') as HTMLSelectElement
    mode.value = 'template'
    mode.dispatchEvent(new Event('change', { bubbles: true }))
  })
  // A preset is selected from the start; choosing another one moves the selection.
  const active = '#lora-preset-grid .lora-preset-chip.active'
  await expect(page.locator(active)).toHaveCount(1)
  await settled(page, active)
  expect(await textContrast(page, active)).toBeGreaterThanOrEqual(4.5)
  await page.locator('#lora-preset-grid .lora-preset-chip:not(.active)').first().click()
  await page.mouse.move(0, 0)
  await settled(page, active)
  expect(await textContrast(page, active)).toBeGreaterThanOrEqual(4.5)
})
