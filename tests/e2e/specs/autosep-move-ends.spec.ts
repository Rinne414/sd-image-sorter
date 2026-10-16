import { expect, test, type Page } from '@playwright/test'

/**
 * Auto-Separate's Hide stopped the page following the move while the move went
 * on in the background, so its result, its failures and the Gallery refresh
 * were never shown. A move that stopped on an internal error said only
 * "Failed to move images", although the pictures before the error had moved.
 */

test.use({ viewport: { width: 1366, height: 768 } })

type MoveState = Record<string, unknown>

const RUNNING: MoveState = {
  status: 'running', step: 'moving', current: 1, total: 3, moved: 1, errors: 0, operation: 'move', message: 'Moving...',
}
const DONE_WITH_A_FAILURE: MoveState = {
  status: 'done', step: 'done', current: 3, total: 3, moved: 2, errors: 1, operation: 'move', message: 'Done',
  recent_errors: [{ filename: 'locked-picture.png', error: 'The file is in use by another program.' }],
}
const STOPPED_ON_ERROR: MoveState = {
  status: 'error', step: 'error', current: 2, total: 3, moved: 2, errors: 0, operation: 'move',
  message: 'Batch move failed due to an internal error', message_key: 'error', recent_errors: [],
}

/** Auto-Separate following a move whose progress the test sets. */
async function followMove(page: Page, state: { current: MoveState }) {
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.route('**/api/batch-move/progress', (route) => route.fulfill({ json: state.current }))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1'
    && typeof (window as any).pollAutosepMoveProgress === 'function')
  await page.evaluate(() => {
    const w = window as any
    w.App.switchView('sorting')
    w._switchSortingSub('autosep')
  })
  await expect(page.locator('#view-autosep')).toBeVisible()
  await page.evaluate(() => {
    const w = window as any
    w.showAutosepMoveProgress(3)
    void w.pollAutosepMoveProgress(3, '')
  })
  await expect(page.locator('#autosep-move-progress')).toBeVisible()
}

test('a move hidden while it runs still reports how it ended, with its failures', async ({ page }) => {
  const state = { current: RUNNING }
  await followMove(page, state)
  await page.locator('#btn-hide-autosep-move').click()
  await expect(page.locator('#autosep-move-progress')).toBeHidden()

  state.current = DONE_WITH_A_FAILURE
  await expect(page.locator('#toast-container .toast').last()).toContainText('Moved 2 images. 1 failed.')
  // The failures bring the panel back with their details.
  await expect(page.locator('#autosep-move-progress')).toBeVisible()
  await expect(page.locator('#autosep-move-errors')).toContainText('locked-picture.png')
})

test('a move that stops on an error says how many pictures it moved first', async ({ page }) => {
  const state = { current: RUNNING }
  await followMove(page, state)
  state.current = STOPPED_ON_ERROR
  await expect(page.locator('#toast-container .toast.error').last()).toContainText(
    'Moving stopped on an error after 2 images; the rest stay where they were.',
  )
})

test('Run again while a hidden move runs brings its progress back and keeps following it', async ({ page }) => {
  const state = { current: RUNNING }
  await followMove(page, state)
  await page.locator('#btn-hide-autosep-move').click()
  await expect(page.locator('#autosep-move-progress')).toBeHidden()
  await page.evaluate(() => (window as any).executeAutoSeparateWithProgress())
  await expect(page.locator('#autosep-move-progress')).toBeVisible()
  await expect(page.locator('#toast-container .toast.info').last()).toContainText('A move is still running; its progress is shown again.')

  state.current = DONE_WITH_A_FAILURE
  await expect(page.locator('#toast-container .toast').last()).toContainText('Moved 2 images. 1 failed.')
})
