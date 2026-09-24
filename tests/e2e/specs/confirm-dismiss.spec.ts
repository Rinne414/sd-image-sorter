import { expect, test } from '../fixtures/click-ledger'

/**
 * A confirm dialog closed any way other than its buttons (dark backdrop,
 * Escape, or a second dialog replacing it) must count as Cancel. Callers
 * wrap showConfirm in a promise; before, those promises never settled, so a
 * busy-restart question closed by clicking outside left every Restart button
 * disabled until the page was reloaded.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as any).App?.showConfirm === 'function')
})

function askConfirm(page: any, label: string) {
  return page.evaluate((name: string) => new Promise((resolve) => {
    ;(window as any).App.showConfirm(
      `Title ${name}`,
      `Message ${name}`,
      () => resolve(`${name}:ok`),
      () => resolve(`${name}:cancel`),
    )
  }), label)
}

test('clicking the backdrop cancels the confirm', async ({ page }) => {
  const answer = askConfirm(page, 'backdrop')
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await page.locator('#confirm-modal .modal-backdrop').click({ position: { x: 5, y: 5 } })
  await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)
  expect(await answer).toBe('backdrop:cancel')
})

test('Escape cancels the confirm', async ({ page }) => {
  const answer = askConfirm(page, 'escape')
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)
  expect(await answer).toBe('escape:cancel')
})

test('a replaced confirm cancels, and the new one still answers', async ({ page }) => {
  const first = askConfirm(page, 'first')
  await expect(page.locator('#confirm-message')).toHaveText('Message first')
  const second = askConfirm(page, 'second')
  expect(await first).toBe('first:cancel')
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await expect(page.locator('#confirm-message')).toHaveText('Message second')
  await page.locator('#btn-confirm-ok').click()
  expect(await second).toBe('second:ok')
})
