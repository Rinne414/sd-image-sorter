import { expect, test } from '@playwright/test'

/**
 * The opt-in professional look (goal 2026-11-08, .plans/ui-pro-2026-11):
 * chosen in Settings > Appearance, remembered, and it shows only the source
 * tabs the library has pictures from (today's look keeps showing all of them).
 */

test.use({ viewport: { width: 1366, height: 768 } })

async function open(page: import('@playwright/test').Page, look: 'pro' | null) {
  await page.addInitScript((l) => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('aurora-entry-skip', '1')
    // A fresh browser has no look saved; only set one when asked (this runs on every load).
    if (l) localStorage.setItem('sd-look', l)
  }, look)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.appReady)).toBe('1')
}

test('a source tab is marked empty only when the library has none, never the chosen one or while counting', async ({ page }) => {
  await open(page, 'pro')
  const marks = await page.evaluate(() => {
    const w = window as any
    const tabs = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('#generator-tabs .gen-tab[data-gen]')].map((t) => [t.dataset.gen, t.classList.contains('is-empty')]))
    w.markEmptyGeneratorTabs({ comfyui: 5, nai: 0 }, false)
    const settled = tabs()
    w.markEmptyGeneratorTabs({}, true)
    const counting = tabs()
    const nai = document.querySelector<HTMLElement>('#generator-tabs .gen-tab[data-gen="nai"]')!
    nai.classList.add('active')
    w.markEmptyGeneratorTabs({ comfyui: 5 }, false)
    const chosen = tabs()
    nai.classList.remove('active')
    return { settled, counting, chosen }
  })
  expect(marks.settled).toMatchObject({ all: false, comfyui: false, nai: true, forge: true, webui: true })
  expect(Object.values(marks.counting).every((empty) => !empty)).toBe(true)
  expect(marks.chosen.nai).toBe(false)
})

test('the pro look hides empty source tabs and keeps the count; classic shows them all', async ({ page }) => {
  await open(page, 'pro')
  await page.evaluate(() => (window as any).markEmptyGeneratorTabs({ comfyui: 5 }, false))
  await expect(page.locator('#generator-tabs .gen-tab[data-gen="forge"]')).toBeHidden()
  await expect(page.locator('#generator-tabs .gen-tab[data-gen="all"]')).toBeVisible()
  await expect(page.locator('#image-count')).toBeVisible()
  await page.evaluate(() => (window as any).SdLook.set(null))
  await expect(page.locator('#generator-tabs .gen-tab[data-gen="forge"]')).toBeVisible()
})

test('Settings > Appearance switches the look, and it is remembered', async ({ page }) => {
  await open(page, null)
  await expect(page.locator('html')).not.toHaveAttribute('data-look', /./)
  await page.evaluate(() => {
    const select = document.getElementById('settings-look') as HTMLSelectElement
    select.value = 'pro'
    select.dispatchEvent(new Event('change'))
  })
  await expect(page.locator('html')).toHaveAttribute('data-look', 'pro')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-look', 'pro')
  await expect(page.locator('#settings-look')).toHaveValue('pro')
})
