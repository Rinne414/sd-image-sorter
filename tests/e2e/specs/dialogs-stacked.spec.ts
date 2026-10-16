import { expect, test, type Page } from '@playwright/test'

/**
 * Dialogs open on top of one another, e.g. a confirmation over a form. The
 * shared dialog helper kept one opener and one Tab trap
 * for the whole app and let every open dialog answer Escape, so one Escape
 * closed the confirmation AND the dialog under it, Tab escaped the dialog that
 * stayed open, and the last dialog to close had no opener to hand focus back
 * to. Escape and the Tab trap now belong to the topmost dialog, and each dialog
 * returns focus to what opened it.
 */

test.use({ viewport: { width: 1366, height: 768 } })

async function openApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as any).App?.showModal === 'function'
    && typeof (window as any).App?.showConfirm === 'function')
  // An opener of our own on the page, so focus-back has one known target.
  await page.evaluate(() => {
    const opener = document.createElement('button')
    opener.id = 'stack-opener'
    opener.textContent = 'Open'
    document.body.prepend(opener)
  })
}

/** The scan dialog from the page opener, then a confirmation from inside it. */
async function openStack(page: Page) {
  await page.evaluate(() => {
    document.getElementById('stack-opener')!.focus()
    ;(window as any).App.showModal('scan-modal')
  })
  await expect(page.locator('#scan-modal')).toHaveClass(/visible/)
  await page.evaluate(() => {
    (document.getElementById('btn-browse-folder') as HTMLElement).focus()
    ;(window as any).App.showConfirm('Stacked', 'A confirmation over the scan dialog')
  })
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
}

test('Escape closes only the confirmation over a dialog, then the dialog itself', async ({ page }) => {
  await openApp(page)
  await openStack(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#scan-modal')).toHaveClass(/visible/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#scan-modal')).not.toHaveClass(/visible/)
})

test('each stacked dialog hands focus back to what opened it', async ({ page }) => {
  await openApp(page)
  await openStack(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('#btn-browse-folder')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#stack-opener')).toBeFocused()
})

test('Tab stays inside the dialog left open under a closed confirmation', async ({ page }) => {
  await openApp(page)
  await openStack(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/visible/)
  const count = await page.locator('#scan-modal').evaluate((modal) => modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])').length)
  for (let step = 0; step < count + 3; step += 1) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(() => Boolean(document.getElementById('scan-modal')?.contains(document.activeElement)))
    expect(inside, `Tab ${step + 1} left the scan dialog`).toBe(true)
  }
})

test('a dialog hidden by hand and opened again hands focus back to its new opener', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const second = document.createElement('button')
    second.id = 'stack-opener-2'
    second.textContent = 'Open again'
    document.body.prepend(second)
    document.getElementById('stack-opener')!.focus()
    ;(window as any).App.showModal('scan-modal')
  })
  await expect(page.locator('#scan-modal')).toHaveClass(/visible/)
  // Some dialogs are closed by removing the class, without the helper.
  await page.evaluate(() => {
    document.getElementById('scan-modal')!.classList.remove('visible')
    document.getElementById('stack-opener-2')!.focus()
    ;(window as any).App.showModal('scan-modal')
  })
  await expect(page.locator('#scan-modal')).toHaveClass(/visible/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#scan-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#stack-opener-2')).toBeFocused()
})
