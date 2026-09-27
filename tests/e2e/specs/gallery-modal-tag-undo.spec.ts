import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Undo after a tag edit in the image modal says what happened (V3.5 3-6).
 *
 * The backend skips an image whose tags changed again after the edit
 * (``skipped_conflicts``). The modal used to say "Tags restored" anyway.
 */

test.describe.configure({ mode: 'serial' })

async function undoWith(page: Page, answers: Array<Record<string, unknown>>) {
  let call = 0
  await page.route('**/api/tags/bulk/undo/**', async (route) => {
    const answer = answers[Math.min(call, answers.length - 1)]
    call += 1
    await route.fulfill({ json: { op_id: `op-${call}`, operation: 'bulk_add', redo_available: false, warnings: [], ...answer } })
  })
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1'
    && typeof (window as any).Gallery?._undoModalTagOps === 'function')
  const opIds = answers.map((_, index) => `op-${index + 1}`)
  await page.evaluate((ids) => (window as any).Gallery._undoModalTagOps(424242, ids), opIds)
}

test('an undo the backend skipped says it was not undone', async ({ page }) => {
  await undoWith(page, [{ restored: 0, skipped_conflicts: [424242] }])

  await expect(page.locator('#toast-container')).toContainText('没有撤销：这张图的标签在这次修改之后又被改过了')
  await expect(page.locator('#toast-container')).not.toContainText('标签已恢复')
})

test('an undo that restored one part and skipped another says it was partly undone', async ({ page }) => {
  await undoWith(page, [
    { restored: 1, skipped_conflicts: [] },
    { restored: 0, skipped_conflicts: [424242] },
  ])

  await expect(page.locator('#toast-container')).toContainText('只撤销了一部分')
})

test('a clean undo still says the tags were restored', async ({ page }) => {
  await undoWith(page, [{ restored: 1, skipped_conflicts: [] }])

  await expect(page.locator('#toast-container')).toContainText('标签已恢复')
})
