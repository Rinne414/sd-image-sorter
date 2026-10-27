import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Manual Sort says when it cannot keep its place:
 * - a step whose session file the program could not write (a session resumes
 *   after a restart only from that file) warns once, not on every key;
 * - a session left behind that could not be read back when the program
 *   started says so, and where its file was kept.
 */

test.use({ viewport: { width: 1366, height: 768 } })

function sessionAt(index: number, extra: Record<string, unknown> = {}) {
  return {
    done: false,
    mode: 'slot',
    index,
    total: 6,
    remaining: 6 - index,
    operation_mode: 'copy',
    folders: { w: 'C:/save-state-spec/w' },
    image: { id: 940000 + index, filename: `save-state-${index}.png`, path: `C:/save-state-spec/${index}.png` },
    tags: [],
    undo_available: index > 0,
    redo_available: false,
    library_id: 'main',
    library_mixed: false,
    restore_failure: null,
    ...extra,
  }
}

async function boot(page: Page, current: Record<string, unknown>) {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' }))
  })
  await page.route('**/api/sort/current', (route) => route.fulfill({ json: current }))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
}

test('a sort step whose place could not be saved warns once', async ({ page }) => {
  let steps = 0
  await page.route('**/api/sort/action?*', (route) => {
    steps += 1
    return route.fulfill({ json: sessionAt(steps, { session_saved: false }) })
  })
  await boot(page, sessionAt(0, { session_saved: true }))
  await page.evaluate(() => {
    const w = window as any
    w.App.switchView('sorting')
    w._switchSortingSub('manual')
  })
  await page.click('#btn-resume-sorting')
  await expect(page.locator('#sort-interface')).toBeVisible()

  const warnings = page.locator('#toast-container .toast.warning', { hasText: 'could not save its place' })
  await page.keyboard.press('Space')
  await expect(warnings).toHaveCount(1)
  await expect(warnings).toContainText('this session cannot be resumed')

  await page.keyboard.press('Space')
  await expect.poll(() => steps).toBe(2)
  await expect(page.locator('#sort-progress-text')).toHaveText('2 / 6')
  await expect(warnings).toHaveCount(1)
})

test('a session that could not be restored says so and where its file went', async ({ page }) => {
  await boot(page, {
    active: false,
    done: true,
    image: null,
    session_saved: true,
    restore_failure: {
      reason: 'unreadable_session_file',
      session_path: 'C:/state/sort-session.json',
      quarantine_path: 'C:/state/sort-session.json.corrupt-1760000000',
      detail: 'Expecting value: line 1 column 1 (char 0)',
      occurred_at: 1760000000,
    },
  })

  const notice = page.locator('#toast-container .toast.warning', { hasText: 'could not be restored' })
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('C:/state/sort-session.json.corrupt-1760000000')
})
