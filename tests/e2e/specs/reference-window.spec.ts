import { expect, test, type Page } from '../fixtures/click-ledger'
import { seedPictures } from '../fixtures/seed-library'

/**
 * "Float as reference": a picture kept in a small window of its own.
 * The desktop program and picture-in-picture windows cannot be driven from
 * here, so these tests cover the hand-over to the desktop program, the
 * ordinary-window path in full, and the view's own controls (shared by all
 * three paths).
 */

test.beforeAll(async ({ request }) => {
  await seedPictures(request, 'reference-window', 2)
})

async function openViewer(page: Page): Promise<number> {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  const id = await page.evaluate(() => Number((window as any).App.AppState.images[0].id))
  await page.evaluate((imageId) => (window as any).Gallery.openPreview(imageId), id)
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  return id
}

async function pressFloat(page: Page) {
  await page.locator('#modal-tools-menu > summary').click()
  await page.locator('#btn-modal-reference').click()
}

const transformOf = (page: Page) => page.locator('.reference-picture').evaluate((node) => (node as HTMLElement).style.transform)

test('without a way to stay on top it opens an ordinary window, says so, and the view works', async ({ page }) => {
  // No picture-in-picture window and no desktop program: the plain-browser path.
  await page.addInitScript(() => Object.defineProperty(window, 'documentPictureInPicture', { value: undefined }))
  const id = await openViewer(page)

  const [reference] = await Promise.all([page.waitForEvent('popup'), pressFloat(page)])
  await expect(page.locator('.toast').filter({ hasText: 'ordinary window' })).toBeVisible()
  expect(new URL(reference.url()).searchParams.get('id')).toBe(String(id))

  const picture = reference.locator('.reference-picture')
  await expect.poll(() => picture.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  const fit = reference.getByRole('button', { name: 'Whole picture' })
  await expect(fit).toBeDisabled()

  // The wheel zooms in; the picture can then be dragged; "Whole picture" undoes both.
  const size = reference.viewportSize()!
  await reference.mouse.move(size.width / 2, size.height / 2)
  await reference.mouse.wheel(0, -300)
  await expect.poll(() => transformOf(reference)).toContain('scale(1.2')
  await reference.mouse.down()
  await reference.mouse.move(size.width / 2 + 40, size.height / 2 + 25)
  await reference.mouse.up()
  await expect.poll(() => transformOf(reference)).toContain('translate(40px, 25px)')
  await expect(fit).toBeEnabled()
  await fit.click()
  await expect.poll(() => transformOf(reference)).toBe('translate(0px, 0px) scale(1, 1)')

  // Mirror and Grey are switches, by button or by key.
  const mirror = reference.getByRole('button', { name: 'Mirror' })
  await mirror.click()
  await expect(mirror).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => transformOf(reference)).toContain('scale(-1, 1)')
  await reference.keyboard.press('h')
  await expect(mirror).toHaveAttribute('aria-pressed', 'false')
  await reference.keyboard.press('g')
  await expect(reference.getByRole('button', { name: 'Grey' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => picture.evaluate((node) => (node as HTMLElement).style.filter)).toBe('grayscale(1)')

  // Nothing runs off the small window, and Esc closes it.
  expect(await reference.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  // The window may be gone before the key press reports back.
  const closed = reference.waitForEvent('close')
  await reference.keyboard.press('Escape').catch(() => {})
  await closed
})

test('in the desktop program the picture is handed to its always-on-top window', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as any).sdDesktop = {
      openReference: (imageId: number, name: string) => {
        ;(window as any).__referenceAsked = [imageId, name]
        return Promise.resolve(true)
      },
    }
  })
  const id = await openViewer(page)
  const name = await page.evaluate(() => String((window as any).App.AppState.images[0].filename))

  await pressFloat(page)

  await expect.poll(() => page.evaluate(() => (window as any).__referenceAsked)).toEqual([id, name])
  // The tools menu closed and no second window was opened by the page.
  await expect(page.locator('#modal-tools-menu')).not.toHaveAttribute('open', '')
  expect(page.context().pages()).toHaveLength(1)
})

test('the Gallery right-click menu offers it too', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as any).sdDesktop = {
      openReference: (imageId: number) => {
        ;(window as any).__referenceAsked = imageId
        return Promise.resolve(true)
      },
    }
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  const tile = page.locator('#gallery-grid .gallery-item').first()
  await expect(tile).toBeVisible()
  const id = Number(await tile.getAttribute('data-id'))
  await tile.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Float as reference' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__referenceAsked)).toBe(id)
})

test('the window says so when it has no picture, or the picture cannot be shown', async ({ page }) => {
  await page.goto('/static/reference.html')
  await expect(page.locator('.reference-problem')).toHaveText('No picture was chosen for this window.')

  await page.goto('/static/reference.html?id=987654321')
  await expect(page.locator('.reference-problem')).toHaveText('This picture cannot be shown. Its file may have been moved or deleted.')
  await expect(page.locator('.reference-bar')).toBeHidden()

  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.goto('/static/reference.html?id=987654321')
  await expect(page.locator('.reference-problem')).toHaveText('这张图片无法显示，文件可能已被移动或删除。')
})
