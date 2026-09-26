import { expect, test, type Locator, type Page } from '@playwright/test'

import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, openLibrary, pageOverflow, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 shell (slice 5a): the Settings page and its tabs as addresses, the Tools
 * menu and tool pages, the language moved into Appearance, the theme and the
 * interface zoom kept over a reload (the zoom set before first paint), the
 * gallery and menus still measuring right at 130%, Ctrl K reaching every tool,
 * tab and page help, and the top bar fitting at every desktop width.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4shelltoken'
const PREFIX = 'v4shell-'
const COUNT = 240
const DIR = 'v4-shell'

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))
test.beforeEach(async ({ page }) => markModelsReady(page))

/** Open V4 at an address in a language, with the zoom stored beforehand (once per page, so reloads keep what the test changed). */
async function openAt(page: Page, hash: string, { lang = 'en', scale }: { lang?: 'en' | 'zh-CN'; scale?: string } = {}) {
  await page.addInitScript(
    ([l, s]) => {
      if (sessionStorage.getItem('v4shell-init')) return
      sessionStorage.setItem('v4shell-init', '1')
      localStorage.setItem('sd-image-sorter-lang', l)
      localStorage.setItem('sd-v4-theme', 'dark')
      localStorage.setItem('sd-v4-update-autocheck', '0')
      if (s) localStorage.setItem('sd-v4-ui-scale', s)
      else localStorage.removeItem('sd-v4-ui-scale')
    },
    [lang, scale ?? ''] as const,
  )
  const res = await page.goto(`/v4/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

const topTabs = (page: Page) => page.getByRole('navigation', { name: 'main' }).getByRole('button')

/** Click one choice of a setting (the radio is the whole label). */
const choose = (setting: Locator, name: string) => setting.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()

test('settings tabs are addresses: clicking, typing the address, unknown tab, back', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)

  await page.getByTestId('settings-button').click()
  await expect(page).toHaveURL(/#\/settings\/appearance$/)
  await expect(page.getByTestId('settings-page')).toBeVisible()
  await expect(page.getByTestId('settings-button')).toHaveAttribute('aria-current', 'page')
  await expect(topTabs(page).and(page.locator('[aria-current="page"]'))).toHaveCount(0)

  // About & updates is built (slice 5c, v4-about.spec.ts): its page, not the placeholder
  // (its hardware probe would touch the GPU: answered here)
  await page.route('**/api/system-info', (route) => route.fulfill({ json: { system_info: { gpu_name: 'Test GPU', torch_cuda_available: true } } }))
  await page.getByTestId('settings-tab-about').click()
  await expect(page).toHaveURL(/#\/settings\/about$/)
  await expect(page.getByTestId('about-update')).toBeVisible()
  await expect(page.getByTestId('settings-planned')).toHaveCount(0)
  // the Model Center is built too (slice 5d, v4-models.spec.ts)
  await page.getByTestId('settings-tab-models').click()
  await expect(page.getByTestId('model-center')).toBeVisible()
  await expect(page.getByTestId('settings-planned')).toHaveCount(0)

  // every other tab: its address, one honest line, and the way to V3.5 (no controls that do nothing)
  for (const [id, name] of [['library', 'Library'], ['ai', 'AI services'], ['disk', 'Disk & cache']] as const) {
    await page.getByTestId(`settings-tab-${id}`).click()
    await expect(page).toHaveURL(new RegExp(`#/settings/${id}$`))
    await expect(page.getByTestId(`settings-tab-${id}`)).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(name)
    const planned = page.getByTestId('settings-planned')
    await expect(planned).toContainText('still being built')
    await expect(planned.getByRole('link', { name: 'Back to V3.5' })).toHaveAttribute('href', '/')
    await expect(planned.locator('input, select, textarea')).toHaveCount(0)
  }

  // the address opens a tab; an unknown tab opens Appearance
  await page.goto('/v4/#/settings/models')
  await expect(page.getByTestId('settings-tab-models')).toHaveAttribute('aria-current', 'page')
  await page.goto('/v4/#/settings/nothing-here')
  await expect(page.getByTestId('settings-appearance')).toBeVisible()

  // Esc with nothing open stays on the page
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-page')).toBeVisible()

  // back goes to the page Settings was opened from (the Batch page here)
  await page.goto('/v4/#/batch')
  await page.getByTestId('settings-button').click()
  await page.getByTestId('settings-back').click()
  await expect(page).toHaveURL(/#\/batch$/)
  await expect(page.getByTestId('settings-button')).not.toHaveAttribute('aria-current', 'page')
})

test('Tools menu: keyboard, Esc closes only the menu, tool pages, back', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const button = page.getByTestId('tools-menu')

  // ↓ on the button opens the menu with the first tool focused; ↓ moves, Enter opens
  await button.focus()
  await page.keyboard.press('ArrowDown')
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Reader' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Reverse prompt' })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(menu.getByRole('menuitem', { name: 'Edit tags…' })).toBeFocused()

  // Esc closes the menu, gives the focus back to the button and leaves the page where it is
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(button).toBeFocused()
  await expect(page.getByTestId('gallery-scroller')).toBeVisible()
  expect(page.url()).not.toContain('#/tools')

  // Enter on the button opens it the same way; Enter on an item opens that tool
  await page.keyboard.press('Enter')
  await expect(menu.getByRole('menuitem', { name: 'Reader' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/tools\/reverse$/)
  const toolPage = page.getByTestId('tool-page')
  await expect(toolPage.getByRole('heading', { level: 1 })).toHaveText('Reverse prompt')
  await expect(page.getByTestId('reverse-page')).toBeVisible()
  // a tool not built in V4 yet says so and points to V3.5
  await page.goto('/v4/#/tools/promptlab')
  await expect(page.getByTestId('tool-planned')).toContainText('still being built')
  await page.goto('/v4/#/tools/reverse')
  await expect(button).toHaveAttribute('aria-current', 'page')
  await expect(topTabs(page).and(page.locator('[aria-current="page"]'))).toHaveCount(0)

  // every tool has its address
  for (const id of ['reader', 'promptlab', 'artist', 'lexicon', 'privacy']) {
    await page.goto(`/v4/#/tools/${id}`)
    await expect(toolPage).toHaveAttribute('data-tool', id)
  }

  // censoring from the menu with nothing picked or open says what to do first
  await button.click()
  await page.getByRole('menuitem', { name: 'Censor…' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Click an image in the library first' })).toBeVisible()

  await page.getByTestId('tool-back').click()
  await expect(page).toHaveURL(/#\/library$/)
})

test('language lives in Appearance and Ctrl K, and survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/settings/appearance', { lang: 'zh-CN' })
  // no language button in the top bar any more
  await expect(page.locator('header').getByRole('button', { name: 'English' })).toHaveCount(0)

  const lang = page.getByTestId('setting-lang')
  await choose(lang, 'English')
  await expect(topTabs(page).first()).toHaveText('Library')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(lang.getByRole('status')).toHaveText('Saved')
  await page.reload()
  await expect(topTabs(page).first()).toHaveText('Library')
  await expect(page.getByTestId('setting-lang').getByRole('radio', { name: 'English' })).toBeChecked()

  // Ctrl K switches back, found by the word in either language
  await page.keyboard.press('Control+k')
  await page.keyboard.type('语言')
  await page.keyboard.press('Enter')
  await expect(topTabs(page).first()).toHaveText('图库')
})

test('theme from Appearance survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/settings/appearance')
  await choose(page.getByTestId('setting-theme'), 'Light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.getByTestId('setting-theme').getByRole('radio', { name: 'Light' })).toBeChecked()
})

test('zoom: chosen, kept over a reload from the first paint, auto by window width, a warning when too big', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, '#/settings/appearance')
  const scale = page.getByTestId('setting-scale')
  await expect(page.getByTestId('scale-now')).toHaveText('By window width, 100% now.')
  await choose(scale, '130%')
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('1.3')
  await expect(page.getByTestId('scale-now')).toHaveText('Fixed at 130% now.')
  await expect(page.getByTestId('scale-too-big')).toHaveCount(0)

  // after a reload the zoom is on before the app's own script runs
  await page.reload({ waitUntil: 'commit' })
  await page.waitForFunction(() => document.readyState !== 'loading' || !!document.documentElement.style.zoom)
  expect(await page.evaluate(() => document.documentElement.style.zoom)).toBe('1.3')
  await expect(page.getByTestId('setting-scale').getByRole('radio', { name: '130%' })).toBeChecked()

  // the page still fits the window exactly: no scrollbars, nothing past the bottom
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  const bottom = await page.evaluate(() => document.querySelector('#root > div')!.getBoundingClientRect().bottom)
  expect(Math.round(bottom)).toBe(1080)

  // a smaller window at the same zoom leaves less than the layout's 1280 px: a warning, not a block
  await page.setViewportSize({ width: 1366, height: 768 })
  await expect(page.getByTestId('scale-too-big')).toContainText('1,051 px')
  await choose(page.getByTestId('setting-scale'), 'Auto')
  await expect(page.getByTestId('scale-too-big')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('')

  // auto: 2560 wide gets 130%
  await page.setViewportSize({ width: 2560, height: 1440 })
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('1.3')
  await expect(page.getByTestId('scale-now')).toHaveText('By window width, 130% now.')
})

test('at 130% the gallery, the right-click menu and Ctrl K still measure right', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('v4shell-zoom')) {
      sessionStorage.setItem('v4shell-zoom', '1')
      localStorage.setItem('sd-v4-ui-scale', '1.3')
    }
  })
  await openLibrary(page, TOKEN, COUNT)
  expect(await page.evaluate(() => document.documentElement.style.zoom)).toBe('1.3')

  const layout = () =>
    page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="gallery-scroller"]')!.getBoundingClientRect()
      const rects = [...document.querySelectorAll('[data-testid="tile"]')].map((t) => t.getBoundingClientRect()).filter((r) => r.width > 2)
      let overlaps = 0
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i]!
          const b = rects[j]!
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps++
        }
      }
      const visible = rects.filter((r) => r.bottom > scroller.top && r.top < scroller.bottom)
      const right = Math.max(...rects.map((r) => r.right))
      const colW = rects[0]?.width ?? 0
      return { tiles: rects.length, visible: visible.length, overlaps, rightGap: scroller.right - right, colW, overflowX: right - scroller.right }
    })

  // scroll through: every stretch is filled, nothing overlaps
  for (const y of [0, 2500, 6000, 12000]) {
    await page.getByTestId('gallery-scroller').evaluate((el, top) => (el.scrollTop = top), y)
    await page.waitForTimeout(250)
    const l = await layout()
    expect(l.overlaps, `overlaps at ${y}`).toBe(0)
    expect(l.visible, `empty stretch at ${y}`).toBeGreaterThan(4)
    expect(l.overflowX, `tiles past the right edge at ${y}`).toBeLessThanOrEqual(1)
    expect(l.rightGap, `a missing column at ${y}`).toBeLessThan(l.colW)
  }

  // the right-click menu opens at the pointer (page px and screen px differ under zoom)
  await page.getByTestId('gallery-scroller').evaluate((el) => (el.scrollTop = 0))
  const box = (await page.getByTestId('tile').nth(1).boundingBox())!
  await page.mouse.click(box.x + 12, box.y + 12, { button: 'right' })
  const menu = page.getByRole('menu')
  const menuBox = (await menu.boundingBox())!
  expect(Math.abs(menuBox.x - (box.x + 12))).toBeLessThan(3)
  await expect(menu).toBeInViewport({ ratio: 1 })
  await page.keyboard.press('Escape')

  // Ctrl K fits inside the window
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('palette')).toBeInViewport({ ratio: 1 })
  await page.keyboard.press('Escape')
})

test('Ctrl K: every tool, every settings tab, the zoom, and each page\'s help', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/library', { lang: 'zh-CN' })
  await expect(page.getByTestId('tile').first()).toBeVisible()

  const run = async (query: string) => {
    await page.keyboard.press('Control+k')
    await expect(page.getByTestId('palette')).toBeVisible()
    await page.keyboard.type(query)
    await page.keyboard.press('Enter')
  }

  await run('读图')
  await expect(page).toHaveURL(/#\/tools\/reader$/)
  await run('prompt lab')
  await expect(page).toHaveURL(/#\/tools\/promptlab$/)
  await run('模型中心')
  await expect(page).toHaveURL(/#\/settings\/models$/)
  await run('disk cache')
  await expect(page).toHaveURL(/#\/settings\/disk$/)

  await run('缩放 115%')
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('1.15')
  await run('zoom auto')
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('')

  // help: what the page is for, and its keys
  await run('说明 分拣')
  const sheet = page.getByTestId('shortcut-sheet')
  await expect(sheet).toBeInViewport({ ratio: 1 })
  await expect(page.getByTestId('help-purpose')).toContainText('分拣')
  for (const key of ['W', 'Space', 'Backspace', 'Ctrl+Z', 'K', 'X']) await expect(sheet.locator('kbd', { hasText: new RegExp(`^${key.replace('+', '\\+')}$`) }).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  await run('help batch')
  await expect(sheet).toContainText('批次 · 打码')
  await expect(sheet.locator('kbd', { hasText: /^Alt\+←$/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  // the Settings page has no keys of its own: the sheet says so and lists the ones that work anywhere
  await run('说明 设置')
  await expect(sheet).toContainText('这一页没有自己的快捷键')
  await expect(sheet.locator('kbd', { hasText: 'Ctrl+K' })).toBeVisible()
})

for (const viewport of VIEWPORTS) {
  test(`top bar fits at ${viewport.width} in both languages, with room for the busy chip and update hint`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openAt(page, '#/settings/appearance', { lang: 'zh-CN' })
    for (const lang of ['zh-CN', 'en'] as const) {
      await page.evaluate((l) => localStorage.setItem('sd-image-sorter-lang', l), lang)
      await page.reload()
      await expect(page.getByTestId('settings-page')).toBeVisible()
      for (const id of ['import-button', 'open-palette', 'tools-menu', 'settings-button', 'theme-toggle']) await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
      await expect(page.locator('header').getByRole('link', { name: lang === 'en' ? 'Back to V3.5' : '回到 V3.5' })).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      // the free space in the bar, in page px: the jobs button, the AI busy chip and the update hint fit in it later
      const room = await page.evaluate(() => {
        const gap = document.querySelector('header > span[class*="gap"]')!
        const zoom = parseFloat(document.documentElement.style.zoom) || 1
        return gap.getBoundingClientRect().width / zoom
      })
      expect(room, `${lang} at ${viewport.width}`).toBeGreaterThan(200)
      // nothing in the bar overlaps its neighbour
      const overlaps = await page.evaluate(() => {
        // the top bar is the first header (a page's own head is another one)
        const items = [...document.querySelector('header')!.children]
          .map((el) => ({ what: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24), r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.top >= 0)
        const hits: string[] = []
        for (let i = 1; i < items.length; i++) {
          if (items[i]!.r.left < items[i - 1]!.r.right - 1) hits.push(`${items[i - 1]!.what} | ${items[i]!.what}`)
        }
        return hits
      })
      expect(overlaps, `${lang} at ${viewport.width}`).toEqual([])
    }
  })
}
