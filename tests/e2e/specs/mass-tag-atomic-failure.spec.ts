import { expect, test, type Page } from '../fixtures/click-ledger'

test.use({ viewport: { width: 1600, height: 900 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

async function performBulkAddAndCaptureDispatch(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    let appliedEventDispatched = false
    window.addEventListener('massTagOperationApplied', () => {
      appliedEventDispatched = true
    })
    const editor = (window as any).MassTagEditor
    editor.switchTab('add')
    await editor._performApply({
      image_ids: [1],
      tags: ['new_tag'],
      confidence: 0.85,
      dry_run: false,
    })
    return appliedEventDispatched
  })
}

async function renderPreviousAppliedResult(page: Page): Promise<void> {
  await page.locator('#btn-mass-tag-editor').click()
  await expect(page.locator('#mass-tag-modal')).toHaveClass(/visible/)
  await page.evaluate(() => {
    const editor = (window as any).MassTagEditor
    editor._renderResult({
      operation: 'bulk_add',
      total_images_checked: 1,
      affected_images: 1,
      total_tags_added: 1,
      sample_changes: [],
      op_id: null,
      undo_available: false,
    }, true)
  })
  await expect(page.locator('#mass-tag-result')).toBeVisible()
  await expect(page.locator('#mass-tag-result-summary')).toContainText('Applied')
}

test('bulk tag rollback is shown as an error and never dispatched as applied', async ({ page }) => {
  const serverError = 'Bulk tag update failed; all changes were rolled back. Cause: injected failure.'
  await page.route('**/api/tags/bulk/add', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: serverError,
        type: 'HTTPException',
        status_code: 500,
      }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await renderPreviousAppliedResult(page)

  const dispatched = await performBulkAddAndCaptureDispatch(page)

  await expect(page.locator('#mass-tag-status')).toHaveText(serverError)
  await expect(page.locator('#mass-tag-status')).toHaveClass(/vlm-status-error/)
  await expect(page.locator('#mass-tag-result')).toBeHidden()
  await expect(page.locator('#mass-tag-result')).toHaveAttribute('hidden', '')
  expect(dispatched).toBe(false)
})

test('message-shaped API errors remain errors and never render Applied', async ({ page }) => {
  const serverMessage = 'The selected tag scope changed before the operation could commit.'
  await page.route('**/api/tags/bulk/add', async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        message: serverMessage,
        status_code: 409,
      }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await renderPreviousAppliedResult(page)

  const dispatched = await performBulkAddAndCaptureDispatch(page)

  await expect(page.locator('#mass-tag-status')).toHaveText(serverMessage)
  await expect(page.locator('#mass-tag-status')).toHaveClass(/vlm-status-error/)
  await expect(page.locator('#mass-tag-result')).toBeHidden()
  await expect(page.locator('#mass-tag-result')).toHaveAttribute('hidden', '')
  expect(dispatched).toBe(false)
})

test('applied changes surface an undo-journal warning without hiding the result', async ({ page }) => {
  const journalWarning = 'Tags were applied, but undo is unavailable because the journal could not be saved.'
  await page.route('**/api/tags/bulk/add', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        operation: 'bulk_add',
        total_images_checked: 1,
        affected_images: 1,
        total_tags_added: 1,
        sample_changes: [],
        op_id: null,
        undo_available: false,
        warnings: [{
          code: 'undo_journal_persistence_failed',
          message: journalWarning,
        }],
      }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.locator('#btn-mass-tag-editor').click()
  await expect(page.locator('#mass-tag-modal')).toHaveClass(/visible/)
  await expect(page.locator('#mass-tag-modal .modal-description')).toContainText(
    'Successful edits offer Undo when an undo journal can be saved.',
  )
  await expect(page.locator('.mass-tag-confirm-note')).toContainText(
    'Undo is offered only when this operation\'s journal can be saved.',
  )

  const dispatched = await performBulkAddAndCaptureDispatch(page)

  await expect(page.locator('#mass-tag-status')).toHaveText(journalWarning)
  await expect(page.locator('#mass-tag-status')).toHaveClass(/vlm-status-warning/)
  await expect(page.locator('#mass-tag-result')).toBeVisible()
  await expect(page.locator('#mass-tag-result-summary')).toContainText('Applied')
  expect(dispatched).toBe(true)
})

test('undo keeps its applied result visible when redo is unavailable', async ({ page }) => {
  const redoWarning = 'Undo was applied, but redo is unavailable because the journal could not be saved.'
  await page.route('**/api/tags/bulk/undo/undoable-op', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        op_id: 'undoable-op',
        operation: 'bulk_add',
        restored: 1,
        skipped_conflicts: [],
        redo_op_id: null,
        redo_available: false,
        warnings: [{
          code: 'redo_journal_persistence_failed',
          message: redoWarning,
        }],
      }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.locator('#btn-mass-tag-editor').click()
  await expect(page.locator('#mass-tag-modal')).toHaveClass(/visible/)
  await page.evaluate(() => {
    ;(window as any).__massTagAppliedEvents = 0
    window.addEventListener('massTagOperationApplied', () => {
      ;(window as any).__massTagAppliedEvents += 1
    })
    ;(window as any).MassTagEditor._renderResult({
      operation: 'bulk_add',
      total_images_checked: 1,
      affected_images: 1,
      total_tags_added: 1,
      sample_changes: [],
      op_id: 'undoable-op',
      undo_available: true,
      warnings: [],
    }, true)
  })

  await page.locator('#mass-tag-undo-op').click()

  await expect(page.locator('#mass-tag-status')).toHaveText(
    `Undone: 1 images restored. ${redoWarning}`,
  )
  await expect(page.locator('#mass-tag-status')).toHaveClass(/vlm-status-warning/)
  await expect(page.locator('#mass-tag-result')).toBeVisible()
  await expect(page.locator('#mass-tag-undo-op')).toHaveText('Undone')
  await expect(page.locator('#mass-tag-undo-op')).toBeDisabled()
  await expect.poll(
    () => page.evaluate(() => (window as any).__massTagAppliedEvents),
  ).toBe(1)
})

test('failed dry-run clears stale results before showing the server error', async ({ page }) => {
  const serverError = 'Bulk tag preview failed before any changes were applied.'
  await page.route('**/api/tags/bulk/add', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ detail: serverError }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.evaluate(() => (window as any).MassTagEditor.switchTab('add'))
  await renderPreviousAppliedResult(page)

  await page.evaluate(async () => {
    const editor = (window as any).MassTagEditor
    const tagInput = document.getElementById('mass-tag-add-tags')
    if (!(tagInput instanceof HTMLTextAreaElement)) {
      throw new Error('Mass Tag add input is unavailable')
    }
    tagInput.value = 'new_tag'
    editor.resolveScopePayload = async () => ({
      scopeSize: 1,
      scopeFields: { image_ids: [1] },
    })
    await editor.runDryRun()
  })

  await expect(page.locator('#mass-tag-status')).toHaveText(serverError)
  await expect(page.locator('#mass-tag-status')).toHaveClass(/vlm-status-error/)
  await expect(page.locator('#mass-tag-result')).toBeHidden()
  await expect(page.locator('#mass-tag-result')).toHaveAttribute('hidden', '')
})
