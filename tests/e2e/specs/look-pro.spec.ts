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

test('pro look: the sidebar and gallery first rows share one line; the pinned toolbar covers the grid', async ({ page }) => {
  await open(page, 'pro')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  const look = await page.evaluate(() => {
    // The two facts that put both first rows on one line; live positions are
    // not compared because a scan notice from another worker can shift one
    // column in a parallel run (2026-11-08).
    const height = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().height
    const bg = getComputedStyle(document.getElementById('gallery-toolbar')!).backgroundColor
    return {
      galleryTopPadding: getComputedStyle(document.querySelector('#view-gallery .gallery-container')!).paddingTop,
      heightGap: Math.abs(height('#sidebar-library-line') - height('#view-gallery .gallery-header')),
      toolbarSeeThrough: bg === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(bg),
    }
  })
  expect(look.galleryTopPadding).toBe('0px')
  expect(look.heightGap).toBeLessThanOrEqual(2)
  expect(look.toolbarSeeThrough).toBe(false)
})

test('pro look: the gallery toolbar has one control height and the grid starts where the toolbar starts', async ({ page }) => {
  await open(page, 'pro')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  const look = await page.evaluate(() => {
    const controls = ['#generator-tabs', '.view-btn[data-size="grid"]', '#btn-group-runs', '#gallery-search-input', '#btn-pro-filters', '#gallery-sort', '#sort-reverse-btn']
    const heights = [...new Set(controls.map((sel) => Math.round(document.querySelector(sel)!.getBoundingClientRect().height)))]
    const left = (sel: string) => Math.round(document.querySelector(sel)!.getBoundingClientRect().left)
    return { heights, edgeGap: Math.abs(left('#gallery-grid .gallery-item') - left('#gallery-search-input')) }
  })
  expect(look.heights).toEqual([32])
  expect(look.edgeGap).toBeLessThanOrEqual(1)
})

test('pro look: the right-click menu keeps its tools behind one Tools row; today\'s look lists them all', async ({ page }) => {
  await open(page, 'pro')
  const tile = page.locator('#gallery-grid .gallery-item').first()
  await expect(tile).toBeVisible()
  const menu = page.locator('.gallery-context-menu')
  await tile.click({ button: 'right' })
  const tools = menu.locator('.context-menu-item').filter({ has: page.locator('.context-menu-label', { hasText: /^Tools$/ }) })
  await expect(tools).toBeVisible()
  await expect(menu.locator('.context-menu-item', { hasText: 'Find Similar' })).toHaveCount(0)
  expect(await menu.evaluate((m) => m.scrollHeight <= m.clientHeight + 1)).toBe(true)

  await tools.click()
  await expect(menu).toBeVisible()
  await expect(menu.locator('.context-menu-item', { hasText: 'Find Similar' })).toBeVisible()
  await menu.locator('.context-menu-item', { hasText: 'Back' }).click()
  await expect(menu.locator('.context-menu-item').filter({ has: page.locator('.context-menu-label', { hasText: /^Tools$/ }) })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  await page.evaluate(() => (window as any).SdLook.set(null))
  await tile.click({ button: 'right' })
  await expect(menu.locator('.context-menu-item', { hasText: 'Find Similar' })).toBeVisible()
  await expect(menu.locator('.context-menu-item').filter({ has: page.locator('.context-menu-label', { hasText: /^Tools$/ }) })).toHaveCount(0)
})

test.describe('pro look gallery toolbar in one row when it fits', () => {
  async function openZh(page: import('@playwright/test').Page, width: number, height: number) {
    await page.setViewportSize({ width, height })
    await page.addInitScript(() => {
      localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
      localStorage.setItem('aurora-entry-skip', '1')
      localStorage.setItem('sd-look', 'pro')
    })
    await page.goto('/')
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.appReady)).toBe('1')
    await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  }

  test('at 2560 the search row joins the header with every control whole; typing keeps focus', async ({ page }) => {
    await openZh(page, 2560, 1440)
    // How many source tabs show depends on the shared test library; with only
    // "All" the row fits at 2560. A width change makes the toolbar ask again.
    await page.addStyleTag({ content: '#generator-tabs .gen-tab:not([data-gen="all"]) { display: none !important; }' })
    await page.setViewportSize({ width: 2550, height: 1440 })
    await expect(page.locator('html')).toHaveClass(/pro-toolbar-one-row/)
    await expect(page.locator('#gallery-search-row')).toBeHidden()
    const layout = await page.evaluate(() => {
      const header = document.querySelector('#view-gallery .gallery-header')!.getBoundingClientRect()
      const ids = ['#image-count', '#generator-tabs', '#gallery-search-input', '#btn-pro-filters', '#gallery-sort', '#sort-reverse-btn', '#btn-group-runs', '#grid-size-slider']
      const boxes = ids.map((sel) => document.querySelector(sel)!.getBoundingClientRect())
      return {
        oneLine: boxes.every((b) => b.top >= header.top - 1 && b.bottom <= header.bottom + 1),
        inside: boxes.every((b) => b.width > 0 && b.left >= header.left - 1 && b.right <= header.right + 1),
        overlaps: boxes.some((a, i) => boxes.some((b, j) => j > i && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)),
      }
    })
    expect(layout).toEqual({ oneLine: true, inside: true, overlaps: false })

    const input = page.locator('#gallery-search-input')
    await input.click()
    await input.pressSequentially('girl', { delay: 40 })
    await page.waitForTimeout(1500)
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('girl')
  })

  test('at 1366 the two rows stay', async ({ page }) => {
    await openZh(page, 1366, 768)
    await page.waitForTimeout(500)
    await expect(page.locator('html')).not.toHaveClass(/pro-toolbar-one-row/)
    await expect(page.locator('#gallery-search-row')).toBeVisible()
  })
})

test('pro look: one library switcher, the sidebar name; today\'s look keeps the top-bar chip too', async ({ page }) => {
  await open(page, 'pro')
  await expect(page.locator('#nav-library-chip')).toBeHidden()
  const sidebarSwitch = page.locator('#btn-sidebar-library')
  await expect(sidebarSwitch).toBeVisible()
  await sidebarSwitch.click()
  await expect(page.locator('#entry-library-menu')).toBeVisible()
  await page.keyboard.press('Escape')

  // Today's look, switched live (the init script would bring the pro look back
  // on a reload), at a width where its top bar has room for the chip (at 1366
  // in English the top bar's own fitting hides it).
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.evaluate(() => (window as any).SdLook.set(null))
  await expect(page.locator('#nav-library-chip')).toBeVisible()
  await expect(page.locator('#btn-sidebar-library')).toBeVisible()
})

test('pro look: one labelled Filter button holds the quick filters; today’s look keeps them in the toolbar', async ({ page }) => {
  await open(page, 'pro')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  const button = page.locator('#btn-pro-filters')
  await expect(button).toBeVisible()
  await expect(page.locator('#chip-aesthetic-7')).toBeHidden()
  await expect(page.locator('#btn-toolbar-filters')).toBeHidden()

  await button.click()
  const panel = page.locator('#pro-filter-popover')
  await expect(panel).toBeVisible()
  await page.locator('#chip-no-caption').click()
  await expect(page.locator('#pro-filters-count')).toHaveText('1')
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await button.click()
  await page.locator('#chip-no-caption').click()
  await expect(page.locator('#pro-filters-count')).toBeHidden()
  await page.locator('#btn-pro-filters-more').click()
  await expect(panel).toBeHidden()

  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as any).SdLook.set(null))
  await expect(page.locator('#btn-pro-filters')).toBeHidden()
  await expect(page.locator('#chip-aesthetic-7')).toBeVisible()
  await expect(page.locator('#btn-toolbar-filters')).toBeVisible()
})

