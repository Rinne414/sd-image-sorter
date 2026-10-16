import { expect, test } from '@playwright/test'

/**
 * The app's shared confirmation (Remove from gallery, Move to Trash, Clear
 * library, ...) has no close button, so it never took focus: Enter and Space
 * still pressed what was focused on the page behind it. It now starts on
 * Cancel, the safe answer, says it is an alert dialog, and hands focus back.
 */

test.use({ viewport: { width: 1366, height: 768 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => Boolean((window as any).App?.showConfirm))
  await page.evaluate(() => {
    const opener = document.createElement('button')
    opener.id = 'confirm-opener'
    opener.textContent = 'Ask'
    document.body.prepend(opener)
  })
  await page.locator('#confirm-opener').focus()
})

test('the confirmation starts on Cancel, and Enter answers Cancel', async ({ page }) => {
  const answers = await page.evaluateHandle(() => [] as string[])
  await page.evaluate((list) => (window as any).App.showConfirm(
    'Remove?', 'A question', () => list.push('ok'), () => list.push('cancel'),
  ), answers)
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await expect(page.locator('#btn-confirm-cancel')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/visible/)
  expect(await answers.evaluate((list) => list)).toEqual(['cancel'])
  await expect(page.locator('#confirm-opener')).toBeFocused()
})

test('the confirmation says it is an alert dialog with its title and message', async ({ page }) => {
  await page.evaluate(() => (window as any).App.showConfirm('Remove these?', 'Files stay on disk'))
  const dialog = page.getByRole('alertdialog', { name: 'Remove these?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAccessibleDescription('Files stay on disk')
})
