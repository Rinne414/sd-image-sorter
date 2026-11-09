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
