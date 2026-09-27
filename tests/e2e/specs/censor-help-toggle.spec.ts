import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Censor side panel: the three long helper paragraphs open on demand
 * (V3.5 subtraction 4).
 *
 * The detector, mask-shape and SAM3-refine explanations filled most of the
 * Auto Detect card on every visit. Each now sits behind a small "?" button
 * next to its control: folded by default, reachable with Tab, announced with
 * aria-expanded, and it opens and closes its own paragraph only.
 */

test.describe.configure({ mode: 'serial' })

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const

const HELPS = [
  { control: '#censor-model-type', help: '#censor-model-type-help', label: '检测器说明', text: '两者一起' },
  { control: '#censor-mask-shape', help: '#censor-mask-shape-help', label: '遮罩形状说明', text: '精准' },
  { control: '#btn-sam3-refine-all-sidebar', help: '#censor-sam3-refine-help', label: 'SAM3 精修说明', text: '重新分割' },
] as const

async function openCensor(page: Page) {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).App.switchView('censor'))
  await expect(page.locator('#view-censor.active')).toBeVisible()
}

const toggleFor = (page: Page, helpSelector: string) =>
  page.locator(`#view-censor button[aria-controls="${helpSelector.slice(1)}"]`)

test('the three helper paragraphs are folded behind a keyboard-reachable "?"', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openCensor(page)

  for (const { control, help, label, text } of HELPS) {
    const toggle = toggleFor(page, help)
    await expect(page.locator(help)).toBeHidden()
    await expect(toggle).toHaveCount(1)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toHaveAttribute('aria-label', label)
    await expect(toggle).toHaveAttribute('title', label)

    // Tab from the control lands on its "?".
    await page.locator(control).focus()
    await page.keyboard.press('Tab')
    await expect(toggle).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(page.locator(help)).toBeVisible()
    await expect(page.locator(help)).toContainText(text)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    for (const other of HELPS.filter((entry) => entry.help !== help)) {
      await expect(page.locator(other.help)).toBeHidden()
    }

    // Enter again folds it. (Space stays the editor's hold-to-pan key, as it
    // is for every censor button.)
    await page.keyboard.press('Enter')
    await expect(page.locator(help)).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  }
})

test('the folded panel keeps its controls in view without overflow at desktop sizes', async ({ page }) => {
  const shotPhase = process.env.SUBTRACT_SHOT_PHASE
  await page.setViewportSize({ width: 1366, height: 768 })
  await openCensor(page)

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    for (const { control, help } of HELPS) {
      await page.locator(control).scrollIntoViewIfNeeded()
      await expect(page.locator(control)).toBeInViewport()
      await expect(toggleFor(page, help)).toBeInViewport()
      const sameRow = await page.evaluate(([controlSelector, helpSelector]) => {
        const a = document.querySelector(controlSelector)!.getBoundingClientRect()
        const b = document.querySelector(`button[aria-controls="${helpSelector.slice(1)}"]`)!.getBoundingClientRect()
        return b.left >= a.right && b.top < a.bottom && b.bottom > a.top
      }, [control, help] as const)
      expect(sameRow, `${help} "?" sits right of its control`).toBe(true)
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    if (shotPhase) {
      await page.screenshot({ path: `../../.tmp/v35-subtract/censor-${shotPhase}-spec-${viewport.width}.png` })
    }
  }
})
