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

async function open(page: import('@playwright/test').Page, look: 'pro' | 'pro-b' | null, lang = 'en') {
  await page.addInitScript(([l, language]) => {
    localStorage.setItem('sd-image-sorter-lang', language as string)
    localStorage.setItem('aurora-entry-skip', '1')
    // A fresh browser has no look saved; only set one when asked (this runs on every load).
    if (l) localStorage.setItem('sd-look', l)
  }, [look, lang])
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
  // The app's own count refresh may land after this mark and re-mark from the
  // shared test library (which can hold Forge pictures in a parallel run):
  // mark again until the hidden state holds.
  await expect.poll(() => page.evaluate(() => {
    (window as any).markEmptyGeneratorTabs({ comfyui: 5 }, false)
    return getComputedStyle(document.querySelector('#generator-tabs .gen-tab[data-gen="forge"]') as HTMLElement).display
  })).toBe('none')
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

test('pro look: the details panel follows the picture under the pointer and can be hidden', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, 'pro')
  const tile = page.locator('#gallery-grid .gallery-item').nth(1)
  await expect(tile).toBeVisible()
  const panel = page.locator('#pro-inspector')
  await expect(panel).toBeVisible()
  const panelBox = (await panel.boundingBox())!
  const gridRight = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#gallery-grid .gallery-item')].map((el) => el.getBoundingClientRect().right)))
  expect(gridRight).toBeLessThanOrEqual(panelBox.x + 1)

  await tile.hover()
  const name = await tile.evaluate((el) => (window as any).App.AppState.images.find((img: any) => String(img.id) === (el as HTMLElement).dataset.id)?.filename)
  await expect(page.locator('.pro-inspector-name')).toHaveText(name)

  await page.locator('#btn-pro-inspector').click()
  await expect(panel).toBeHidden()
  await page.locator('#btn-pro-inspector').click()
  await expect(panel).toBeVisible()

  await page.evaluate(() => (window as any).SdLook.set(null))
  await expect(panel).toBeHidden()
  await expect(page.locator('#btn-pro-inspector')).toBeHidden()
})

test('pro look: the details panel speaks the chosen language from the first load and after a switch', async ({ page }) => {
  // It is drawn before the language packs load; it once stayed English in the Chinese UI.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, 'pro', 'zh-CN')
  const note = page.locator('#pro-inspector .pro-inspector-empty')
  const expected = (lang: string) => page.evaluate((l) => (window as any).I18n.translations[l]['inspector.empty'], lang)
  await expect(note).toHaveText(await expected('zh-CN'))
  await page.evaluate(() => (window as any).I18n.setLang('en'))
  await expect(note).toHaveText(await expected('en'))
})

test('proposal B: the View and More menus hold their buttons, which still work; proposal A keeps them in the toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, 'pro-b')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()

  // View: the three view modes, Group runs and the details toggle.
  const view = page.locator('#btn-pro-view')
  await expect(view).toBeVisible()
  await expect(page.locator('#btn-group-runs')).toBeHidden()
  await view.click()
  await expect(page.locator('#pro-view-popover')).toBeVisible()
  const large = page.locator('#pro-view-popover .view-btn[data-size="large"]')
  await expect(large).toBeVisible()
  await large.click()
  await expect(page.locator('#pro-view-popover')).toBeHidden()
  await expect(large).toHaveAttribute('aria-pressed', 'true')
  await view.click()
  await page.keyboard.press('Escape')
  await expect(page.locator('#pro-view-popover')).toBeHidden()
  await expect(view).toBeFocused()

  // More: random picture and find moved images, each with its name.
  const more = page.locator('#btn-pro-more')
  await expect(page.locator('#btn-reconnect-missing')).toBeHidden()
  await more.click()
  await expect(page.locator('#pro-more-popover #btn-random')).toHaveText('Random picture')
  await expect(page.locator('#pro-more-popover #btn-reconnect-missing')).toHaveText('Find Moved Files')
  await page.keyboard.press('Escape')
  await expect(page.locator('#pro-more-popover')).toBeHidden()

  // The owner's top bar (2026-11-09, sample 3): Import is the one filled
  // button, All features is a find field, the guide and the language share a
  // Help menu, AI tagging sits among the gallery's tools; the update button
  // waits for an update.
  await expect(page.locator('#btn-open-model-manager .nav-action-label')).toHaveText('Settings')
  await expect(page.locator('#btn-all-features .nav-catalog-find')).toHaveText('Find a feature…')
  await expect(page.locator('#btn-all-features .nav-catalog-label')).toBeHidden()
  await expect(page.locator('.nav-actions .btn-primary:visible')).toHaveCount(1)
  await expect(page.locator('#view-gallery .gallery-header #btn-tag .btn-tag-short')).toHaveText('AI Tag')
  await expect(page.locator('.nav-actions #btn-tag')).toHaveCount(0)
  await expect(page.locator('#btn-help')).toBeHidden()
  await expect(page.locator('#btn-language-toggle')).toBeHidden()
  await page.locator('#btn-pro-help').click()
  await expect(page.locator('#pro-help-popover #btn-help')).toHaveText('Guide for this page')
  // The menu shows its sentence; the bar's short form (中文) stays hidden there.
  await expect(page.locator('#pro-help-popover #btn-language-toggle .pro-menu-label')).toHaveText('Switch to 中文')
  await expect(page.locator('#pro-help-popover #btn-language-toggle .nav-action-label')).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(page.locator('#pro-help-popover')).toBeHidden()
  await expect(page.locator('#btn-app-update')).toBeHidden()

  // Proposal A: everything back in the toolbar, no labels in the top bar.
  await page.evaluate(() => (window as any).SdLook.set('pro'))
  await expect(view).toBeHidden()
  await expect(more).toBeHidden()
  await expect(page.locator('#btn-group-runs')).toBeVisible()
  await expect(page.locator('#btn-random')).toBeVisible()
  await expect(page.locator('#view-gallery .view-btn[data-size="large"]')).toBeVisible()
  await expect(page.locator('#btn-open-model-manager .nav-action-label')).toBeHidden()
  // ...and its old top bar: AI tagging, Help and the language back in place.
  await expect(page.locator('.nav-actions #btn-tag')).toBeVisible()
  await expect(page.locator('.nav-actions #btn-help')).toBeVisible()
  await expect(page.locator('.nav-actions #btn-language-toggle')).toBeVisible()
  await expect(page.locator('#btn-pro-help')).toBeHidden()
})

test('proposal B: Select is a big button at the sidebar foot, filters start open and Clear all waits for a filter', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, 'pro-b')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()

  // The owner (2026-11-09): easy to see and click, where the batch panel opens.
  const select = page.locator('.filter-sidebar-footer #btn-toggle-select')
  await expect(select).toBeVisible()
  const [button, sidebar] = await Promise.all([select.boundingBox(), page.locator('.filter-sidebar').boundingBox()])
  expect(button!.height).toBeGreaterThanOrEqual(42)
  expect(button!.width).toBeGreaterThan(sidebar!.width * 0.8)
  await select.click()
  await expect(select).toHaveAttribute('aria-pressed', 'true')
  await select.click()
  await expect(select).toHaveAttribute('aria-pressed', 'false')

  const filters = page.locator('[data-sidebar-section="filters"] .sidebar-section-toggle')
  await expect(filters).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#btn-clear-filters')).toBeHidden()
  // The list shows only the filters that are on; with none, only "Add a filter".
  await expect(page.locator('#filter-summary .summary-row[data-filter-field="generators"]')).toBeHidden()
  const add = page.locator('#btn-pro-add-filter')
  await expect(add).toBeVisible()
  await add.click()
  await expect(page.locator('#filter-modal')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#filter-modal')).toBeHidden()

  // Proposal A keeps it at the sidebar's foot too.
  await page.evaluate(() => (window as any).SdLook.set('pro'))
  await expect(page.locator('.filter-sidebar-footer #btn-toggle-select')).toBeVisible()
})

test('pro look: the details panel opens the picture’s folder', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, 'pro')
  const tile = page.locator('#gallery-grid .gallery-item').nth(1)
  await expect(tile).toBeVisible()
  // Answer the request here: a real call would open the file manager on this machine.
  const asked: number[] = []
  await page.route('**/api/open-folder', async (route) => {
    asked.push(Number(route.request().postDataJSON()?.image_id))
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' })
  })
  await tile.hover()
  const id = Number(await tile.getAttribute('data-id'))
  const folder = page.locator('#pro-inspector .pro-inspector-folder')
  await expect(folder).toBeVisible()
  await folder.click()
  await expect.poll(() => asked).toEqual([id])
})

test('pro look: Duplicate Cleanup and the Tags library are sized to their content, with one close', async ({ page }) => {
  // UI audit #10: both filled 90% of a 1920 window with their content in the left third.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, 'pro')
  await page.evaluate(() => (window as any).DupCleaner.open())
  const dup = page.locator('#dup-cleaner-modal .modal-content')
  await expect(dup).toBeVisible()
  expect((await dup.boundingBox())!.width).toBeLessThanOrEqual(1201)
  await page.keyboard.press('Escape')
  await expect(dup).toBeHidden()

  await page.evaluate(() => document.getElementById('btn-tags-library')!.click())
  const library = page.locator('#tags-library-modal .modal-content')
  await expect(library).toBeVisible()
  expect((await library.boundingBox())!.width).toBeLessThanOrEqual(961)
  await expect(page.locator('#btn-close-tags-library')).toBeVisible()
  await expect(page.locator('#btn-close-tags-library-2')).toBeHidden()
})

test('Professional look: Quick views count and show All, Not tagged yet and Last 7 days', async ({ page }) => {
  // Rounds 17-18: Eagle-style default views. "Not tagged yet" is the untagged
  // filter (tagged_at empty), not the caption filter a tagging run never changes.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, 'pro-b')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  const views = page.locator('#pro-library-views .pro-library-view')
  await expect(views).toHaveCount(3)
  await expect(page.locator('#pro-library-views .pro-library-view[data-view="all"]')).toHaveClass(/is-active/)
  await expect(page.locator('#pro-library-views [data-view="all"] .pro-library-view-count')).toHaveText(/^\d+$/)

  // The row's count is what the server counts for the same filter.
  const expected = await page.evaluate(async () => (await (await fetch('/api/images/count?untagged=true')).json()).total)
  await expect(page.locator('#pro-library-views [data-view="untagged"] .pro-library-view-count')).toHaveText(String(expected))

  await page.locator('#pro-library-views [data-view="untagged"]').click()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.untagged)).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.noCaption)).toBeFalsy()
  await expect(page.locator('#pro-library-views [data-view="untagged"]')).toHaveClass(/is-active/)
  await page.locator('#pro-library-views [data-view="all"]').click()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.untagged)).toBeFalsy()

  // A view replaces the search: the box empties instead of showing a search
  // that no longer applies (walkthrough 2026-11-09).
  const box = page.locator('#gallery-search-input')
  await box.fill('rain')
  await box.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.search)).toBe('rain')
  await page.locator('#pro-library-views [data-view="untagged"]').click()
  await expect(box).toHaveValue('')
  await page.locator('#pro-library-views [data-view="all"]').click()

  // ...and leaves a folder scope, as Clear all does: no "Folder: ..." line stays.
  await page.locator('#folder-tree .folder-row-open').first().click()
  await expect(page.locator('#folder-tree-browsing')).toBeVisible()
  await page.locator('#pro-library-views [data-view="all"]').click()
  await expect(page.locator('#folder-tree-browsing')).toBeHidden()

  // It folds like the other sidebar sections (round 19: the one without an arrow).
  const toggle = page.locator('#pro-library-views .sidebar-section-toggle')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#pro-library-views [data-view="all"]')).toBeHidden()
  await toggle.click()
  await expect(page.locator('#pro-library-views [data-view="all"]')).toBeVisible()

  // Proposal A and today's look do not show the list.
  await page.evaluate(() => (window as any).SdLook.set('pro'))
  await expect(page.locator('#pro-library-views')).toBeHidden()
})

test('pro look: with no picture shown the details panel shows the library at a glance', async ({ page }) => {
  // Eagle and Billfish show the folder's facts when nothing is selected; ours
  // was one line of text in an empty column (2026-11-09).
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, 'pro-b')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  const panel = page.locator('#pro-inspector')
  await expect(panel.locator('.pro-inspector-overview .pro-inspector-name')).toBeVisible()

  // Known numbers, so the rows are pinned whatever the test library holds:
  // the stats below, and 5 pictures not tagged yet from the count endpoint.
  await page.route('**/api/images/count', (route) => route.fulfill({ json: { count: 5, exact: true } }))
  await page.evaluate(() => {
    const w = window as any
    w.App.AppState.analytics = {
      ...w.App.AppState.analytics,
      totalImages: 12,
      checkpoints: [{ checkpoint: 'model_a.safetensors', checkpoint_normalized: 'model_a', count: 9 }],
      loras: [{ lora: 'lora_a', count: 4 }],
      top_tags: [{ tag: 'silver_hair', count: 7 }],
    }
    window.dispatchEvent(new CustomEvent('library-stats-loaded'))
  })
  // Round 19: no repeated picture count; what to do next comes first.
  await expect(panel.locator('.pro-inspector-todo-text')).toHaveText('5 pictures are not tagged yet')
  await expect(panel.locator('.pro-inspector-rank')).toHaveCount(2)
  await expect(panel.locator('.pro-inspector-tag-button')).toHaveText(['silver hair'])

  // A model row shows only that model's pictures.
  await panel.locator('.pro-inspector-rank', { hasText: 'model_a.safetensors' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.checkpoints)).toEqual(['model_a'])

  // All statistics opens the statistics dialog.
  await page.evaluate(() => (window as any).setAppFilters((window as any).createDefaultFilterState()))
  await panel.locator('.pro-inspector-stats').click()
  await expect(page.locator('#analytics-modal .analytics-grid')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#analytics-modal .analytics-grid')).toBeHidden()

  // "Tag them" opens the AI tagging dialog, the top bar's own door.
  await panel.locator('.pro-inspector-todo-start').click()
  await expect(page.locator('#tag-modal')).toHaveClass(/visible/)
})

test('pro look: the viewer keeps the accent for its main action; selection shows one kind of number', async ({ page }) => {
  // Walkthrough 2026-11-09: magenta labels and chips in the viewer, the
  // negative prompt in error red, and sort numbers beside pick numbers.
  const ACCENT = 'rgb(213, 35, 122)'
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, 'pro-b')
  const tiles = page.locator('#gallery-grid .gallery-item')
  await expect(tiles.first()).toBeVisible()

  // The daily "today: favourited N" ribbon is not drawn in the pro looks.
  await page.evaluate(() => {
    const ribbon = document.getElementById('gallery-comfort-ribbon')!
    ribbon.dataset.mode = 'today'
    ribbon.hidden = false
    ribbon.textContent = 'Today'
  })
  await expect(page.locator('#gallery-comfort-ribbon')).toBeHidden()

  // Selection mode: the place in the sort shows only on hover.
  await page.locator('#btn-toggle-select').click()
  await tiles.nth(1).click()
  await page.mouse.move(2, 1070)
  const order = tiles.nth(3).locator('.gallery-item-order')
  await expect.poll(() => order.evaluate((node) => getComputedStyle(node).opacity)).toBe('0')
  await tiles.nth(3).hover()
  await expect.poll(() => order.evaluate((node) => getComputedStyle(node).opacity)).toBe('1')
  await page.locator('#btn-toggle-select').click()

  // The viewer: neutral labels, no error red on the negative prompt.
  await tiles.first().dblclick()
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  const colors = await page.evaluate(() => {
    const color = (sel: string) => { const node = document.querySelector(sel); return node ? getComputedStyle(node).color : null }
    return { label: color('#image-modal .key-param strong'), negative: color('#image-modal .modal-negative-text') }
  })
  if (colors.label) expect(colors.label).not.toBe(ACCENT)
  if (colors.negative) expect(colors.negative).not.toBe('rgb(222, 107, 102)')
})

test('Space: a tap opens the quick look until Space or Esc; a hold closes on release', async ({ page }) => {
  // Walkthrough 2026-11-09: a tester tapped Space and saw nothing (it only
  // peeked while held). Eagle and macOS open on a tap and close on the next.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, null)
  const tile = page.locator('#gallery-grid .gallery-item[data-id]').first()
  await expect(tile).toBeVisible()
  await tile.hover()
  const peek = page.locator('#gallery-comfort-peek')

  await page.keyboard.press('Space')
  await expect(peek).toBeVisible()
  await page.waitForTimeout(400)
  await expect(peek).toBeVisible()
  await page.keyboard.press('Space')
  await expect(peek).toBeHidden()

  await page.keyboard.press('Space')
  await expect(peek).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(peek).toBeHidden()

  await page.keyboard.down('Space')
  await expect(peek).toBeVisible()
  await page.waitForTimeout(400)
  await page.keyboard.up('Space')
  await expect(peek).toBeHidden()
})

test('Professional look: whole pictures by default at the grid density; only a pick is remembered', async ({ page }) => {
  // Owner's sample pick (2026-11-09): whole pictures, as Eagle and Billfish
  // show them. Start-up no longer saves the layout as if it were a pick.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, 'pro-b')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  const state = () => page.evaluate(() => ({
    mode: (window as any).App.AppState.viewMode,
    saved: localStorage.getItem('gallery-view-mode'),
  }))
  await expect.poll(state).toEqual({ mode: 'waterfall', saved: null })
  // The same density as the grid: the waterfall's column is the grid's tile.
  const widths = await page.evaluate(() => {
    const layout = (window as any).Gallery
    return { waterfall: layout._effectiveMinColumnWidth('waterfall'), grid: layout._effectiveMinColumnWidth('grid') }
  })
  expect(widths.waterfall).toBe(widths.grid)

  // A pick is remembered and survives a reload.
  await page.locator('#btn-pro-view').click()
  await page.locator('#pro-view-popover .view-btn[data-size="grid"]').click()
  await expect.poll(state).toEqual({ mode: 'grid', saved: 'grid' })
  await page.reload()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.appReady)).toBe('1')
  await expect.poll(state).toEqual({ mode: 'grid', saved: 'grid' })
})

test('pro look: the pages beside the gallery share one frame, one tool switch and readable text', async ({ page }) => {
  await open(page, 'pro-b')
  const go = async (view: string) => {
    await page.evaluate((v) => (document.querySelector(`.nav-tab[data-view="${v}"]`) as HTMLElement).click(), view)
    await expect(page.locator(`#view-${view}`)).toHaveClass(/active/)
  }
  const box = (selector: string) => page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement
    const cs = getComputedStyle(el)
    return { height: Math.round(el.getBoundingClientRect().height), border: cs.borderTopWidth, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, weight: cs.fontWeight }
  }, selector)

  // Read Image: the dashed area is the only frame, and the tool switch is the shared segmented control.
  await go('reader')
  expect((await box('#view-reader .reader-left')).border).toBe('0px')
  expect((await box('#reader-tool-tab-reader')).height).toBe(28)
  expect((await box('#reader-paste-btn')).weight).toBe('500')

  // Organize: the same switch; panels share the 12 px corner.
  await go('sorting')
  expect((await box('#view-sorting .sorting-sub-tab.active')).height).toBe(28)
  expect((await box('#view-sorting .autosep-pane')).radius).toBe('12px')

  // Censor: the sidebars are chrome like the top bar, their cards are sections without a box.
  await go('censor')
  const navBg = (await box('.nav-bar')).bg
  expect((await box('#view-censor .censor-sidebar-v2.left')).bg).toBe(navBg)
  expect((await box('#view-censor .censor-tab-pane.is-active .censor-side-card')).radius).toBe('0px')

  // Style Finder: the counts are a line of text, not a row of boxes.
  await go('artist')
  expect((await box('#view-artist .artist-stats')).border).toBe('0px')

  // No page text under 11 px in these pages' resting state.
  for (const view of ['reader', 'sorting', 'reverse', 'promptlab', 'artist']) {
    await go(view)
    const small = await page.evaluate((v) => {
      const out: string[] = []
      const walker = document.createTreeWalker(document.getElementById(`view-${v}`)!, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const text = (node.textContent || '').trim()
        const el = node.parentElement!
        if (!text || !el.getClientRects().length) continue
        if (parseFloat(getComputedStyle(el).fontSize) < 11) out.push(`${text.slice(0, 20)} ${getComputedStyle(el).fontSize}`)
      }
      return out
    }, view)
    expect(small, view).toEqual([])
  }
})

test('Style Finder: the "Use GPU" option shows its checkbox in every look', async ({ page }) => {
  for (const look of [null, 'pro-b'] as const) {
    await open(page, look)
    await page.evaluate(() => (document.querySelector('.nav-tab[data-view="artist"]') as HTMLElement).click())
    const mark = page.locator('#view-artist label:has(#artist-use-gpu) .checkbox-custom')
    await expect(mark).toBeVisible()
    // The choice is remembered, so the second look starts from the first one's click.
    const before = await page.locator('#artist-use-gpu').isChecked()
    await mark.click()
    await expect.poll(() => page.locator('#artist-use-gpu').isChecked()).toBe(!before)
  }
})

test('Prompt Helper: the chosen template picture stays shown (the language refresh used to replace it)', async ({ page }) => {
  await open(page, null)
  await page.evaluate(() => (document.querySelector('.nav-tab[data-view="promptlab"]') as HTMLElement).click())
  await page.click('.promptlab-tab[data-mode="build"]')
  const source = page.locator('#pl-build-source')
  await expect.poll(() => source.locator('option').count()).toBeGreaterThan(1)
  await source.selectOption({ index: 1 })
  const thumb = page.locator('#pl-build-preview .promptlab-image-preview-thumb')
  await expect(thumb).toBeVisible()
  // The refresh that overwrote it ran a moment after the pick.
  await page.waitForTimeout(1500)
  await expect(thumb).toBeVisible()
  await expect(page.locator('#pl-build-preview')).not.toHaveAttribute('data-i18n', /.+/)
  // Back to "nothing chosen": the empty text and its key return.
  await source.selectOption({ index: 0 })
  await expect(page.locator('#pl-build-preview')).toHaveAttribute('data-i18n', 'promptlab.buildPreviewEmpty')
})

test('pro look: the picture being sorted uses the room between the folder cards', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, 'pro-b')
  const size = await page.evaluate(() => {
    const sortInterface = document.getElementById('sort-interface') as HTMLElement
    document.querySelectorAll<HTMLElement>('.view').forEach((view) => view.classList.toggle('active', view.id === 'view-sorting'))
    ;(document.getElementById('view-manual') as HTMLElement).style.display = 'block'
    sortInterface.style.display = 'block'
    return Math.round((document.getElementById('image-stack') as HTMLElement).getBoundingClientRect().width)
  })
  expect(size).toBe(1080 - 424)
})

test('a message that stays on screen has a close button and leaves when the page changes', async ({ page }) => {
  await open(page, null)
  const show = () => page.evaluate(() => {
    const app = (window as any).App
    app.showToast('Saved 3 pictures', 'success', { persistent: true, actionLabel: 'Open folder', onAction() {} })
    app.showPipelineNextStep({ icon: 'i-folders', title: 'Copied. What next?', actions: [{ icon: '#i-grid', label: 'Censor', action: 'view:censor' }] })
  })
  await show()
  const toast = page.locator('.toast[data-persistent="1"]')
  await expect(toast).toHaveCount(1)
  await toast.locator('.toast-close-btn').click()
  await expect(toast).toHaveCount(0)

  await show()
  await expect(page.locator('#pipeline-next-step')).toBeVisible()
  await page.evaluate(() => (document.querySelector('.nav-tab[data-view="dataset"]') as HTMLElement).click())
  await expect(toast).toHaveCount(0)
  await expect(page.locator('#pipeline-next-step')).toBeHidden()
})

test('the shared confirm button does not keep the last dialog’s own label', async ({ page }) => {
  await open(page, null)
  const label = () => page.locator('#btn-confirm-ok').innerText()
  await page.evaluate(() => (window as any).App.showConfirm('T', 'M', () => {}, () => {}, { okLabel: 'Discard session' }))
  await expect.poll(label).toBe('Discard session')
  await page.click('#btn-confirm-cancel')
  await page.evaluate(() => (window as any).App.showConfirm('T', 'M', () => {}, () => {}))
  await expect.poll(label).toBe('Yes, proceed')
  await page.click('#btn-confirm-cancel')
})

test('the error strip ignores the browser’s size-observer note and still shows real errors', async ({ page }) => {
  await open(page, null)
  const shown = () => page.evaluate(() => Boolean(document.querySelector('#app-error-strip:not([hidden])')))
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' })))
  expect(await shown()).toBe(false)
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') })))
  expect(await shown()).toBe(true)
})

test('pro look: Similar, Style Finder and Style Map say in one sentence what the page is for', async ({ page }) => {
  await open(page, 'pro-b')
  for (const [view, text] of [['similar', /look alike/], ['artist', /artist whose style/], ['stylemap', /Every picture is a dot/]] as const) {
    await page.evaluate((v) => (document.querySelector(`.nav-tab[data-view="${v}"]`) as HTMLElement).click(), view)
    await expect(page.locator(`#view-${view} .page-lead`)).toBeVisible()
    await expect(page.locator(`#view-${view} .page-lead`)).toHaveText(text)
  }
  // Today's look keeps these pages as they were.
  await page.evaluate(() => (window as any).SdLook.set(null))
  await expect(page.locator('#view-stylemap .page-lead')).toBeHidden()
})

test('Read Image: a dropped picture’s copy is not saved into the upload temp folder, and the editor is one click away', async ({ page }) => {
  await open(page, null)
  await page.evaluate(() => (document.querySelector('.nav-tab[data-view="reader"]') as HTMLElement).click())
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await page.setInputFiles('#reader-file-input', { name: 'dropped-picture.png', mimeType: 'image/png', buffer: png })
  await expect(page.locator('.reader-container')).toHaveClass(/reader-has-image/)
  const output = page.locator('#reader-edit-output-path')
  // The default arrives from the server a moment later: "<save folder>/reader/<name>.edited.png".
  await expect.poll(() => output.inputValue()).toMatch(/[\\/]reader[\\/]dropped-picture\.edited\.png$/)
  expect(await output.inputValue()).not.toMatch(/reader_uploads/)
  await expect(page.locator('#reader-edit-output-hint')).not.toHaveAttribute('data-i18n', /.+/)

  await expect(page.locator('#reader-editor-body')).toBeHidden()
  await page.click('#reader-edit-jump')
  await expect(page.locator('#reader-editor-body')).toBeVisible()
  await expect(page.locator('#reader-edit-prompt')).toBeFocused()
})

test('Organize: the empty preview holds a start button that keeps its place after the language refresh', async ({ page }) => {
  await open(page, null)
  await page.evaluate(() => (document.querySelector('.nav-tab[data-view="sorting"]') as HTMLElement).click())
  const start = page.locator('#autosep-preview-list #btn-preview-autosep-start')
  await expect(start).toBeVisible()
  // The refresh used to rewrite the whole empty state's text, which removed the button.
  await page.waitForTimeout(1200)
  await expect(start).toBeVisible()
  await expect(page.locator('#autosep-preview-list .autosep-preview-empty-text')).not.toBeEmpty()
})

test('Reverse Prompt says why its button is off; in the pro look a main button that is off is not accent-coloured', async ({ page }) => {
  await open(page, 'pro-b')
  await page.evaluate(() => (document.querySelector('.nav-tab[data-view="reverse"]') as HTMLElement).click())
  await expect(page.locator('#btn-reverse-run')).toBeDisabled()
  await expect(page.locator('#reverse-run-hint')).toBeVisible()
  const colours = await page.evaluate(() => {
    const off = getComputedStyle(document.getElementById('btn-reverse-run')!).backgroundColor
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    const probe = document.createElement('i'); probe.style.color = accent; document.body.appendChild(probe)
    const accentRgb = getComputedStyle(probe).color; probe.remove()
    return { off, accentRgb }
  })
  expect(colours.off).not.toBe(colours.accentRgb)
})
