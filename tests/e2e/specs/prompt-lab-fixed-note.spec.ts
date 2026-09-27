import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Prompt Helper says when Generate cannot change the prompt (review of 8cbd754).
 *
 * The slots are the user's own picks, so a prompt built only from slots has no
 * random part: pressing Generate again gives the same prompt. The backend now
 * answers random_part: false for that, and the page says why next to the
 * result instead of looking broken. Randomize (which fills the slots itself)
 * does not show the note.
 */

test.describe.configure({ mode: 'serial' })

const SHOT_DIR = '../../.tmp/v35-fix'
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const

async function openRandomMode(page: Page, randomPart: boolean) {
  await page.route('**/api/prompts/generate', (route) => route.fulfill({
    json: { positive_prompt: 'hatsune_miku, smile', negative_prompt: '', warnings: [], random_part: randomPart },
  }))
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1'
    && typeof (window as any).App?.switchView === 'function')
  await page.evaluate(() => (window as any).App.switchView('promptlab'))
  await expect.poll(() => page.evaluate(() => (window as any).PromptLab?.isReady === true)).toBe(true)
  await page.locator('.promptlab-tab[data-mode="random"]').click()
  await page.evaluate(() => {
    const lab = (window as any).PromptLab
    lab.slots = { ...lab.slots, character: ['hatsune_miku'], expression: ['smile'] }
    lab.renderSlotBuilder()
  })
}

test('Generate from fixed slots says the prompt has no random part', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openRandomMode(page, false)

  await page.locator('#btn-promptlab-generate').click()
  const note = page.locator('#promptlab-fixed-note')
  await expect(note).toBeVisible()
  await expect(note).toHaveText('只用了固定槽位，没有随机部分，所以再点「生成」结果不会变。想要变化请用「随机生成」。')

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    await note.scrollIntoViewIfNeeded()
    await expect(note).toBeInViewport()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBe(0)
    await page.screenshot({ path: `${SHOT_DIR}/promptlab-fixed-note-${viewport.width}.png` })
  }

  // Randomize fills the slots itself: no note there.
  await page.evaluate(() => (window as any).PromptLab.randomize())
  await expect(note).toBeHidden()
})

test('a prompt with a random part shows no note', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openRandomMode(page, true)

  await page.locator('#btn-promptlab-generate').click()
  await expect(page.locator('#promptlab-output')).toHaveValue(/hatsune_miku/)
  await expect(page.locator('#promptlab-fixed-note')).toBeHidden()
})
