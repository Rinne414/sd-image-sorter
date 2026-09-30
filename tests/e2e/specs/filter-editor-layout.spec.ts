import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Filter editor layout (owner review 2026-09-30, DESIGN.md rules 18-21):
 * - the model / LoRA lists were capped in a short scroll box while the right
 *   column ended above empty space; they now grow to the left column's height;
 * - cyan / blue / purple / pink colour dots all read as amber;
 * - the aspect-ratio label repeated the panel title (尺寸与比例);
 * - empty tag / prompt trays left a blank band with a divider.
 */

test.use({ viewport: { width: 1920, height: 1080 } })

async function openFilterEditor(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.locator('#btn-open-filters').click()
  await expect(page.locator('#modal-checkpoint-list')).toBeVisible()
}

test('the model and LoRA lists fill the right column down to the left column', async ({ page }) => {
  await openFilterEditor(page)
  const layout = await page.evaluate(() => {
    const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
    return {
      listHeight: box('#modal-checkpoint-list').height,
      loraHeight: box('#modal-lora-list').height,
      rightBottom: box('.filter-column-secondary').bottom,
      leftBottom: box('.filter-column-primary').bottom,
    }
  })
  // The old cap was 32vh (346px at this size).
  expect(layout.listHeight).toBeGreaterThan(500)
  expect(layout.loraHeight).toBe(layout.listHeight)
  expect(Math.abs(layout.rightBottom - layout.leftBottom)).toBeLessThan(2)
})

test('each colour dot shows its own hue, not the accent', async ({ page }) => {
  await openFilterEditor(page)
  const colours = await page.evaluate(() => {
    const out: Record<string, string> = {}
    document.querySelectorAll('input[name="color-hue"]').forEach((input) => {
      const dot = input.parentElement!.querySelector('.filter-hue-dot')!
      out[(input as HTMLInputElement).value] = getComputedStyle(dot).backgroundColor
    })
    return out
  })
  expect(Object.keys(colours)).toHaveLength(12)
  expect(new Set(Object.values(colours)).size).toBe(12)
  const accent = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.background = 'var(--accent)'
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).backgroundColor
    probe.remove()
    return value
  })
  for (const hue of ['cyan', 'blue', 'purple', 'pink']) {
    expect(colours[hue], hue).not.toBe(accent)
  }
})

test('the aspect label says aspect after translations re-apply, and empty trays take no space', async ({ page }) => {
  await openFilterEditor(page)
  await page.evaluate(() => (window as any).UIRefresh.applyTranslations())
  await expect(page.locator('#dimensions-heading')).toHaveText('纵横比例')
  await expect(page.locator('#modal-active-tags')).toBeHidden()
  await expect(page.locator('#modal-active-prompts')).toBeHidden()
})
