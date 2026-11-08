import { expect, test } from '@playwright/test'

import { cleanupImages, seedImages } from '../fixtures/v4-seed'

/**
 * The opt-in professional look (goal 2026-11-08, .plans/ui-pro-2026-11):
 * chosen in Settings > Appearance, remembered, and it shows only the source
 * tabs the library has pictures from (today's look keeps showing all of them).
 */

test.use({ viewport: { width: 1366, height: 768 } })

// The gallery toolbar folds while the library is empty: bring our own pictures.
test.beforeAll(() => seedImages({ prefix: 'lookpro-', token: 'lookprotoken', count: 3, dir: 'look-pro' }))
test.afterAll(() => cleanupImages('lookpro-', ['look-pro']))

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

test('pro look: the gallery chrome uses the accent only for the main action', async ({ page }) => {
  await open(page, 'pro')
  // Blind judges (2026-11-08) counted the accent in nine places at once.
  const accented = await page.evaluate(() => {
    const isAccent = (c: string) => /rgba?\(213, 35, 122/.test(c)
    return [...document.querySelectorAll('.nav-bar *, #view-gallery .gallery-header *, #gallery-toolbar *')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) return false
        const cs = getComputedStyle(el)
        return isAccent(cs.backgroundColor) || (isAccent(cs.borderTopColor) && parseFloat(cs.borderTopWidth) > 0)
      })
      .map((el) => el.id || (el as HTMLElement).className)
  })
  expect(accented).toEqual(['btn-scan'])
})

test('pro look: Settings is a content-width column whose On/Off controls are switches', async ({ page }) => {
  await open(page, 'pro')
  await page.evaluate(() => (window as any).openModelManager('general'))
  const dialog = page.locator('#model-manager-modal .modal-content')
  await expect(dialog).toBeVisible()
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(1120)

  const sound = page.locator('#btn-settings-sound-toggle')
  const box = (await sound.boundingBox())!
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([44, 26])
  const knob = () => sound.evaluate((el) => getComputedStyle(el, '::after').transform)
  const before = await sound.getAttribute('aria-pressed')
  const knobBefore = await knob()
  await sound.click()
  await expect(sound).not.toHaveAttribute('aria-pressed', before!)
  expect(await knob()).not.toBe(knobBefore)
  // the words stay for screen readers
  await expect(sound).toHaveAccessibleName(/.+/)
  await sound.click()
  await expect(sound).toHaveAttribute('aria-pressed', before!)
})

test('the confirm dialog shows rows and a note, and the next question starts without them', async ({ page }) => {
  await open(page, null)
  await page.evaluate(() => (window as any).showConfirm('Found ComfyUI', 'These folders hold 10 models:', null, null, {
    tone: 'primary',
    list: [{ text: 'I:\ComfyUI', meta: '4 models' }, { text: 'I:\hf-cache\hub', meta: '6 models' }],
    note: 'The program only reads these files.',
  }))
  const modal = page.locator('#confirm-modal')
  await expect(modal.locator('#confirm-list li')).toHaveCount(2)
  await expect(modal.locator('#confirm-list li').first()).toContainText('4 models')
  await expect(modal.locator('#confirm-note')).toHaveText('The program only reads these files.')
  await page.click('#btn-confirm-cancel')

  await page.evaluate(() => (window as any).showConfirm('Delete?', 'This cannot be undone.', null, null))
  await expect(modal.locator('#confirm-message')).toHaveText('This cannot be undone.')
  await expect(modal.locator('#confirm-list')).toBeHidden()
  await expect(modal.locator('#confirm-note')).toBeHidden()
  await page.click('#btn-confirm-cancel')
})

test('pro look: Organize has one frame per column and shows which mode is chosen', async ({ page }) => {
  await open(page, 'pro')
  await page.evaluate(() => (window as any).App.switchView('sorting'))
  await expect(page.locator('#autosep-preview-list')).toBeVisible()
  const look = await page.evaluate(() => {
    const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!)
    const dashed = [...document.querySelectorAll('#view-sorting *')].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 4 && r.height > 4 && getComputedStyle(el).borderTopStyle === 'dashed'
    }).length
    const [chosen, other] = [...document.querySelectorAll('.sorting-sub-tab')].map((el) => getComputedStyle(el).backgroundColor)
    return {
      dashed,
      previewFramed: cs('#autosep-preview-list').borderTopStyle !== 'none' && parseFloat(cs('#autosep-preview-list').borderTopWidth) > 0,
      chosenStandsOut: chosen !== other,
      filterRowHeight: Math.round(document.querySelector('#autosep-filter-summary .summary-item')!.getBoundingClientRect().height),
    }
  })
  expect(look).toEqual({ dashed: 0, previewFramed: false, chosenStandsOut: true, filterRowHeight: 36 })
})

test('pro look folds the tag tools into More; today\'s look keeps them in the bar', async ({ page }) => {
  await open(page, 'pro')
  await expect(page.locator('#btn-tags-library')).toBeHidden()
  await expect(page.locator('#btn-mass-tag-editor')).toBeHidden()
  await page.click('#nav-tools-toggle')
  const entry = page.locator('#nav-tools-tags-library')
  await expect(entry).toBeVisible()
  await expect(page.locator('#nav-tools-mass-tag')).toBeVisible()
  await entry.click()
  await expect(page.locator('#tags-library-modal')).toHaveClass(/visible/)
  await expect(page.locator('#nav-tools-menu')).toBeHidden()

  await page.evaluate(() => (window as any).SdLook.set(null))
  await page.keyboard.press('Escape')
  await expect(page.locator('#btn-tags-library')).toBeVisible()
  await page.click('#nav-tools-toggle')
  await expect(page.locator('#nav-tools-tags-library')).toBeHidden()
})
