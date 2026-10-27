import { expect, test, type Locator, type Page } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { pageOverflow, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * Customize top bar (feature nav.customize), in V Opus and in /next/: show or
 * hide each place, reorder it by dragging or with the arrows, keep at least one
 * place in the bar, restore the defaults. A hidden place stays reachable (More,
 * Ctrl K). Each interface keeps its own choice. With every place shown the bar
 * still fits every desktop width in both languages.
 *
 * Needs the frontend-v4 build: `cd frontend-v4 && npm run build`.
 */

test.beforeEach(async ({ page }) => markModelsReady(page))

interface Face {
  name: string
  base: string
  key: string
  /** Place ids in the bar by default. */
  defaults: string[]
  /** Test id of a place's button in the bar. */
  inBar: (id: string) => string
  /** The menu that holds hidden places and the Customize item. */
  moreId: string
  /** Opens the menu that holds "Customize top bar…". */
  entrance: string
  /** A place that can be hidden and still reached from More. */
  hideId: string
  hideEn: string
  /** Every id, in the default order. */
  all: string[]
  /** Go-to command Ctrl K offers for hideId, when it has one. */
  paletteEn?: string
}

const VOPUS: Face = {
  name: 'V Opus',
  base: '/vopus/',
  key: 'sd-v4-nav-places',
  defaults: ['library', 'batch', 'sort'],
  inBar: (id) => `topbar-place-${id}`,
  moreId: 'topbar-more',
  entrance: 'tools-menu',
  hideId: 'library',
  hideEn: 'Library',
  all: ['library', 'batch', 'sort', 'tool-reader'],
  paletteEn: 'Go to library',
}

const NEXT: Face = {
  name: '/next/',
  base: '/next/',
  key: 'sd-next-nav-places',
  defaults: ['library', 'batch', 'sort', 'reader', 'censor', 'similar', 'stylemap'],
  inBar: (id) => (['censor', 'similar'].includes(id) ? `next-${id}` : `next-place-${id}`),
  moreId: 'next-more',
  entrance: 'next-more',
  hideId: 'batch',
  hideEn: 'Batches',
  all: ['library', 'batch', 'sort', 'reader', 'censor', 'similar', 'stylemap'],
}

async function openAt(page: Page, face: Face, lang: 'en' | 'zh-CN' = 'en', hash = '#/library') {
  await page.addInitScript(
    ([l, key]) => {
      if (sessionStorage.getItem('navcustom-init')) return
      sessionStorage.setItem('navcustom-init', '1')
      localStorage.setItem('sd-image-sorter-lang', l)
      localStorage.setItem('sd-v4-theme', 'dark')
      localStorage.setItem('sd-v4-update-autocheck', '0')
      localStorage.removeItem(key)
    },
    [lang, face.key] as const,
  )
  const res = await page.goto(`${face.base}${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'frontend-v4 is not built: run npm run build').toBe(200)
}

/** The ids of the places the bar draws now, left to right. */
async function barOrder(page: Page, face: Face): Promise<string[]> {
  const found = await Promise.all(
    face.all.map(async (id) => {
      const place = page.getByTestId(face.inBar(id)).first()
      const box = (await place.count()) ? await place.boundingBox() : null
      return box ? { id, x: box.x } : null
    }),
  )
  return found.filter((f): f is { id: string; x: number } => f !== null).sort((a, b) => a.x - b.x).map((f) => f.id)
}

async function openDialog(page: Page, face: Face): Promise<Locator> {
  if (face.name === 'V Opus') {
    await page.getByTestId('tools-menu').click()
    await page.locator('[data-item="customize-places"]').click()
  } else {
    await page.getByTestId('next-more').click()
    await page.locator('[data-item="customize-places"]').click()
  }
  const dialog = page.getByTestId('navcustom-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key)

for (const face of [VOPUS, NEXT]) {
  test.describe(face.name, () => {
    test('the dialog lists every place, ticked as the bar shows them', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 })
      await openAt(page, face)
      expect(await barOrder(page, face)).toEqual(face.defaults)
      const dialog = await openDialog(page, face)
      await expect(dialog.getByRole('heading', { name: 'Customize top bar' })).toBeVisible()
      for (const id of face.all) {
        const box = dialog.getByTestId(`navcustom-show-${id}`)
        if (face.defaults.includes(id)) await expect(box).toBeChecked()
        else await expect(box).not.toBeChecked()
      }
      // the first row cannot go up, the last cannot go down
      await expect(dialog.getByTestId(`navcustom-up-${face.all[0]}`)).toBeDisabled()
      await expect(dialog.getByTestId(`navcustom-down-${face.all.at(-1)}`)).toBeDisabled()
      // nothing to restore yet
      await expect(dialog.getByTestId('navcustom-reset')).toBeDisabled()
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    })

    test('right-click on the bar opens it too, and Esc closes only the dialog', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 })
      await openAt(page, face)
      await page.locator('header').first().click({ button: 'right', position: { x: 600, y: 20 } })
      await expect(page.getByTestId('navcustom-dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('navcustom-dialog')).toHaveCount(0)
      await expect(page).toHaveURL(/#\/library$/)
    })

    test('hide a place: it leaves the bar, waits under More, survives a reload, comes back', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 })
      await openAt(page, face)
      const dialog = await openDialog(page, face)
      await dialog.getByTestId(`navcustom-show-${face.hideId}`).uncheck()
      await expect(dialog.getByTestId(`navcustom-row-${face.hideId}`)).toContainText('Under More')
      await dialog.getByTestId('navcustom-done').click()
      await expect(page.getByTestId('navcustom-dialog')).toHaveCount(0)
      expect(await barOrder(page, face)).toEqual(face.defaults.filter((id) => id !== face.hideId))

      // reachable from More
      await page.getByTestId(face.moreId).click()
      const item = page.locator(`[data-item="place-${face.hideId}"]`)
      await expect(item).toBeVisible()
      await expect(item).toContainText(face.hideEn)
      await item.click()
      await expect(page).toHaveURL(new RegExp(`#/${face.hideId}$`))
      // the page it opened is lit on More while its tab is out of the bar
      await expect(page.getByTestId(face.moreId)).toHaveAttribute('aria-current', 'page')

      // kept across a reload
      await page.reload()
      await expect(page.getByTestId(face.moreId)).toBeVisible()
      expect(await barOrder(page, face)).toEqual(face.defaults.filter((id) => id !== face.hideId))

      // show it again: back in its old slot
      const again = await openDialog(page, face)
      await again.getByTestId(`navcustom-show-${face.hideId}`).check()
      await again.getByTestId('navcustom-done').click()
      expect(await barOrder(page, face)).toEqual(face.defaults)
    })

    test('reorder with the arrows (keyboard) and by dragging; the bar follows', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 })
      await openAt(page, face)
      const dialog = await openDialog(page, face)
      const [first, second, third] = face.all as [string, string, string]

      // arrows: Enter on the "down" button of the first row, twice from the keyboard
      const down = dialog.getByTestId(`navcustom-down-${first}`)
      await down.focus()
      await page.keyboard.press('Enter')
      expect(await barOrder(page, face)).toEqual([second, first, third, ...face.defaults.slice(3)].filter((id) => face.defaults.includes(id)))
      // the focus stays on the arrow just pressed, so a second press moves it again
      await expect(down).toBeFocused()
      await page.keyboard.press('Enter')
      expect(await barOrder(page, face)).toEqual([second, third, first, ...face.defaults.slice(3)].filter((id) => face.defaults.includes(id)))
      await dialog.getByTestId(`navcustom-up-${first}`).click()
      await dialog.getByTestId(`navcustom-up-${first}`).click()
      expect(await barOrder(page, face)).toEqual(face.defaults)

      // drag the first row onto the third
      await dialog.getByTestId(`navcustom-row-${first}`).dragTo(dialog.getByTestId(`navcustom-row-${third}`))
      expect(await barOrder(page, face)).toEqual([second, third, first, ...face.defaults.slice(3)].filter((id) => face.defaults.includes(id)))
      const saved = JSON.parse((await stored(page, face.key)) ?? '{}') as { order: string[] }
      expect(saved.order.slice(0, 3)).toEqual([second, third, first])

      // restore defaults
      await expect(dialog.getByTestId('navcustom-reset')).toBeEnabled()
      await dialog.getByTestId('navcustom-reset').click()
      expect(await barOrder(page, face)).toEqual(face.defaults)
      expect(await stored(page, face.key)).toBeNull()
    })

    test('the last place in the bar stays, and the dialog says why', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 })
      await openAt(page, face)
      const dialog = await openDialog(page, face)
      const keep = face.defaults[0]!
      for (const id of face.defaults.slice(1)) await dialog.getByTestId(`navcustom-show-${id}`).uncheck()
      await expect(dialog.getByTestId('navcustom-notice')).toHaveCount(0)
      await dialog.getByTestId(`navcustom-show-${keep}`).click()
      await expect(dialog.getByTestId('navcustom-notice')).toContainText('keeps at least one place')
      await expect(dialog.getByTestId(`navcustom-show-${keep}`)).toBeChecked()
      expect(await barOrder(page, face)).toEqual([keep])
      // the notice goes once the user does something else
      await dialog.getByTestId(`navcustom-show-${face.defaults[1]}`).check()
      await expect(dialog.getByTestId('navcustom-notice')).toHaveCount(0)
    })

    test('the choice is this interface\'s own: the other one keeps its default', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 })
      const other = face === VOPUS ? NEXT : VOPUS
      await openAt(page, face)
      const dialog = await openDialog(page, face)
      await dialog.getByTestId(`navcustom-show-${face.hideId}`).uncheck()
      expect(await stored(page, face.key)).not.toBeNull()
      expect(await stored(page, other.key)).toBeNull()
    })

    test('Chinese: the dialog, its refusal and the More menu read in Chinese', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 })
      await openAt(page, face, 'zh-CN')
      const dialog = await openDialog(page, face)
      await expect(dialog.getByRole('heading', { name: '自定义顶栏' })).toBeVisible()
      await dialog.getByTestId(`navcustom-show-${face.hideId}`).uncheck()
      await expect(dialog.getByTestId(`navcustom-row-${face.hideId}`)).toContainText('在「更多」里')
      for (const id of face.defaults.filter((x) => x !== face.hideId).slice(1)) await dialog.getByTestId(`navcustom-show-${id}`).uncheck()
      const last = face.defaults.filter((x) => x !== face.hideId)[0]!
      await dialog.getByTestId(`navcustom-show-${last}`).click()
      await expect(dialog.getByTestId('navcustom-notice')).toContainText('顶栏至少要留一个页面')
      await dialog.getByTestId('navcustom-done').click()
      await page.getByTestId(face.moreId).click()
      await expect(page.locator('[data-item="customize-places"]')).toContainText('自定义顶栏…')
    })

    for (const viewport of VIEWPORTS) {
      test(`with every place shown the bar fits at ${viewport.width} in both languages`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await openAt(page, face)
        const dialog = await openDialog(page, face)
        for (const id of face.all) await dialog.getByTestId(`navcustom-show-${id}`).check()
        // the dialog itself fits too
        const panel = (await dialog.boundingBox())!
        expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height)
        await dialog.getByTestId('navcustom-done').click()
        for (const lang of ['en', 'zh-CN'] as const) {
          await page.evaluate((l) => localStorage.setItem('sd-image-sorter-lang', l), lang)
          await page.reload()
          await expect(page.getByTestId('open-palette')).toBeVisible()
          expect(await barOrder(page, face), lang).toEqual(face.all)
          for (const id of ['import-button', 'open-palette', 'settings-button']) await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
          expect(await pageOverflow(page), `${lang} at ${viewport.width}`).toBeLessThanOrEqual(0)
          // the free space in the bar: the jobs button, the AI busy chip and the update hint fit in it later
          const room = await page.evaluate(() => {
            const gap = document.querySelector('header > span[class*="gap"]')!
            const zoom = parseFloat(document.documentElement.style.zoom) || 1
            return gap.getBoundingClientRect().width / zoom
          })
          expect(room, `${lang} at ${viewport.width}`).toBeGreaterThan(200)
          // short of that room the brand keeps only its mark (wide fonts): Home is still there by name
          const brandName = face === VOPUS ? (lang === 'en' ? 'Home' : '首页') : lang === 'en' ? /SD Image Sorter/ : /SD 图片管理器/
          await expect(page.locator('header').getByRole('button', { name: brandName }).first()).toBeInViewport({ ratio: 1 })
          const overlaps = await page.evaluate(() => {
            const items = [...document.querySelector('header')!.children]
              .map((el) => ({ what: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24), r: el.getBoundingClientRect() }))
              .filter(({ r }) => r.width > 0 && r.top >= 0)
            const hits: string[] = []
            for (let i = 1; i < items.length; i++) if (items[i]!.r.left < items[i - 1]!.r.right - 1) hits.push(`${items[i - 1]!.what} | ${items[i]!.what}`)
            return hits
          })
          expect(overlaps, `${lang} at ${viewport.width}`).toEqual([])
        }
      })
    }
  })
}

test('V Opus: a hidden page is still one Ctrl K away', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, VOPUS, 'en', '#/batch')
  const dialog = await openDialog(page, VOPUS)
  await dialog.getByTestId('navcustom-show-library').uncheck()
  await dialog.getByTestId('navcustom-done').click()
  await page.keyboard.press('Control+k')
  await page.getByTestId('palette').locator('input').fill('library')
  await page.getByRole('option', { name: /library/i }).first().click()
  await expect(page).toHaveURL(/#\/library$/)
})

test('/next/: a hidden Censor menu moves its items under More', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, NEXT)
  const dialog = await openDialog(page, NEXT)
  await dialog.getByTestId('navcustom-show-censor').uncheck()
  await dialog.getByTestId('navcustom-done').click()
  await expect(page.getByTestId('next-censor')).toHaveCount(0)
  await page.getByTestId('next-more').click()
  await expect(page.locator('[data-item="censor-batches"]')).toBeVisible()
  await page.locator('[data-item="censor-batches"]').click()
  await expect(page).toHaveURL(/#\/batch$/)
})
