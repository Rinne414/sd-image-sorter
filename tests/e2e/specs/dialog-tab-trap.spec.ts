import { expect, test, type Page } from '@playwright/test'

/**
 * The Tab trap read a dialog's first and last control once, disabled ones
 * included. The Mass Tag confirmation keeps Apply disabled for a 2 s
 * countdown, so Tab from Cancel left the question for the editor behind it.
 * The trap now reads the usable controls on each Tab.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const focusInsideConfirm = (page: Page) => page.evaluate(
  () => Boolean(document.getElementById('mass-tag-confirm-modal')?.contains(document.activeElement)))

test('Tab stays in the Mass Tag confirmation while Apply counts down', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => Boolean((window as any).App?.showModal && (window as any).MassTagEditor))
  await page.evaluate(async () => {
    const editor = (window as any).MassTagEditor
    await editor.openModal()
    editor.activeTab = 'add'
    editor._openConfirm({ tags: ['blue_sky'], confidence: 1 }, 3, 'test-signature', 'add')
  })
  await expect(page.locator('#btn-mass-tag-confirm-cancel')).toBeFocused()
  await expect(page.locator('#btn-mass-tag-confirm-apply')).toBeDisabled()
  await page.keyboard.press('Tab')
  expect(await focusInsideConfirm(page)).toBe(true)
  await page.keyboard.press('Shift+Tab')
  expect(await focusInsideConfirm(page)).toBe(true)
})
