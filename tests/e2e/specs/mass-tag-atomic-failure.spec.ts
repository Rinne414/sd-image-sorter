import { expect, test, type Page } from '../fixtures/click-ledger'

test.use({ viewport: { width: 1600, height: 900 } })

const desktopViewports = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const

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
    }, 'add')
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
        dry_run: false,
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

test('malformed dry-run success cannot unlock destructive Apply', async ({ page }) => {
  await page.route('**/api/tags/bulk/add', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ operation: 'bulk_add' }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.evaluate(() => {
    ;(window as any).AppFilterAccess.getSelectedImageIds = () => [1]
  })
  await page.locator('#btn-mass-tag-editor').click()
  await page.locator('.mass-tag-tab[data-mass-tag-tab="add"]').click()
  await page.locator('#mass-tag-add-tags').fill('new_tag')
  await page.locator('#btn-mass-tag-dry-run').click()

  await expect(page.locator('#mass-tag-status')).toContainText('invalid preview data')
  await expect(page.locator('#mass-tag-status')).toHaveClass(/vlm-status-error/)
  await expect(page.locator('#mass-tag-result')).toBeHidden()
  await expect(page.locator('#btn-mass-tag-apply')).toBeDisabled()
})

test('malformed apply success warns that the write status is uncertain', async ({ page }) => {
  await page.route('**/api/tags/bulk/add', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ operation: 'bulk_add', dry_run: false }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  const dispatched = await page.evaluate(async () => {
    let appliedEventDispatched = false
    window.addEventListener('massTagOperationApplied', () => {
      appliedEventDispatched = true
    })
    await (window as any).MassTagEditor._performApply({
      image_ids: [1],
      tags: ['new_tag'],
      confidence: 0.85,
      dry_run: false,
    }, 'add')
    return appliedEventDispatched
  })

  await expect(page.locator('#mass-tag-status')).toContainText('may have been applied')
  await expect(page.locator('#mass-tag-status')).toHaveClass(/vlm-status-error/)
  await expect(page.locator('#mass-tag-result')).toBeHidden()
  expect(dispatched).toBe(false)
})

test('each Mass Tag operation validates its own response contract', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  const checks = await page.evaluate(() => {
    const editor = (window as any).MassTagEditor
    const base = {
      dry_run: true,
      total_images_checked: 1,
      affected_images: 1,
      sample_changes: [],
    }
    const contracts = {
      find_replace: {
        ...base,
        operation: 'find_replace',
        affected_tags: 1,
        sample_changes: [{ image_id: 1, before: ['old_tag'], after: ['new_tag'] }],
      },
      add: {
        ...base,
        operation: 'bulk_add',
        total_tags_added: 1,
        sample_changes: [{ image_id: 1, added: ['new_tag'], before_count: 1, after_count: 2 }],
      },
      remove: {
        ...base,
        operation: 'bulk_remove',
        total_tags_removed: 1,
        sample_changes: [{ image_id: 1, removed: ['old_tag'], remaining_count: 0 }],
      },
      cleanup: {
        ...base,
        operation: 'cleanup',
        total_low_conf_removed: 1,
        total_duplicates_removed: 0,
        sample_changes: [{
          image_id: 1,
          before_count: 2,
          after_count: 1,
          removed_low_conf: 1,
          removed_dupes: 0,
        }],
      },
    }
    return Object.fromEntries(Object.entries(contracts).map(([tab, payload]) => [tab, {
      accepts: editor._validateResult(payload, tab, true),
      rejectsWrongMode: editor._validateResult({ ...payload, dry_run: false }, tab, true),
      rejectsWrongOperation: editor._validateResult({ ...payload, operation: 'wrong' }, tab, true),
      rejectsMalformedSample: editor._validateResult({
        ...payload,
        sample_changes: [{ image_id: 1 }],
      }, tab, true),
    }]))
  })

  for (const tab of ['find_replace', 'add', 'remove', 'cleanup'] as const) {
    expect(checks[tab].accepts).toBeNull()
    expect(checks[tab].rejectsWrongMode).toContain('invalid preview data')
    expect(checks[tab].rejectsWrongOperation).toContain('invalid preview data')
    expect(checks[tab].rejectsMalformedSample).toContain('invalid preview data')
  }
})

test('Apply cancels when its async scope resolution invalidates the preview', async ({ page }) => {
  let blockScopeResolution = false
  let releaseScopeResolution: () => void = () => {
    throw new Error('Apply scope resolution was not blocked')
  }
  let reportScopeResolutionStarted: () => void = () => {
    throw new Error('Apply scope resolution did not start')
  }
  const scopeResolutionReleased = new Promise<void>((resolve) => {
    releaseScopeResolution = resolve
  })
  const scopeResolutionStarted = new Promise<void>((resolve) => {
    reportScopeResolutionStarted = resolve
  })
  await page.route('**/api/images/selection-token', async (route) => {
    if (blockScopeResolution) {
      reportScopeResolutionStarted()
      await scopeResolutionReleased
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        selection_token: 'mass-tag-filter-token',
        total_estimate: 1,
        exact_total: true,
      }),
    })
  })

  const requests: Array<Record<string, unknown>> = []
  await page.route('**/api/tags/bulk/add', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    requests.push(body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        operation: 'bulk_add',
        dry_run: body.dry_run,
        total_images_checked: 1,
        affected_images: 1,
        total_tags_added: 1,
        sample_changes: [],
        op_id: null,
        undo_available: false,
        warnings: [],
      }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.locator('#btn-mass-tag-editor').click()
  await page.locator('.mass-tag-tab[data-mass-tag-tab="add"]').click()
  await page.locator('#mass-tag-add-tags').fill('scope_race_tag')
  await page.locator('input[name="mass-tag-scope"][value="filter"]').check()
  await page.locator('#btn-mass-tag-dry-run').click()
  await expect(page.locator('#btn-mass-tag-apply')).toBeEnabled()
  expect(requests).toHaveLength(1)

  blockScopeResolution = true
  await page.locator('#btn-mass-tag-apply').click()
  await scopeResolutionStarted
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('gallery-filters-changed'))
  })
  releaseScopeResolution()

  await expect(page.locator('#mass-tag-status')).toContainText('run the dry-run preview again')
  await expect(page.locator('#btn-mass-tag-apply')).toBeDisabled()
  expect(requests).toHaveLength(1)
})

for (const viewport of desktopViewports) {
test(`Apply requires a current preview at ${viewport.width}x${viewport.height}`, async ({ page }) => {
  await page.setViewportSize(viewport)
  const requests: Array<Record<string, unknown>> = []
  await page.route('**/api/tags/bulk/add', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    requests.push(body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        operation: 'bulk_add',
        dry_run: body.dry_run,
        total_images_checked: 1,
        affected_images: 1,
        total_tags_added: 1,
        sample_changes: [],
        op_id: null,
        undo_available: false,
        warnings: [],
      }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.evaluate(() => {
    ;(window as any).AppFilterAccess.getSelectedImageIds = () => [1]
  })

  await page.locator('#btn-mass-tag-editor').click()
  await expect(page.locator('#mass-tag-modal')).toHaveClass(/visible/)
  await page.locator('.mass-tag-tab[data-mass-tag-tab="add"]').click()
  await page.locator('#mass-tag-add-tags').fill('previewed_tag')

  const layout = await page.evaluate(() => {
    const modal = document.querySelector('#mass-tag-modal .modal-content')?.getBoundingClientRect()
    const preview = document.getElementById('btn-mass-tag-dry-run')?.getBoundingClientRect()
    const apply = document.getElementById('btn-mass-tag-apply')?.getBoundingClientRect()
    return {
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      modal: modal ? { left: modal.left, top: modal.top, right: modal.right, bottom: modal.bottom } : null,
      preview: preview ? { left: preview.left, top: preview.top, right: preview.right, bottom: preview.bottom } : null,
      apply: apply ? { left: apply.left, top: apply.top, right: apply.right, bottom: apply.bottom } : null,
    }
  })
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(0)
  expect(layout.modal).not.toBeNull()
  expect(layout.modal!.left).toBeGreaterThanOrEqual(0)
  expect(layout.modal!.top).toBeGreaterThanOrEqual(0)
  expect(layout.modal!.right).toBeLessThanOrEqual(viewport.width)
  expect(layout.modal!.bottom).toBeLessThanOrEqual(viewport.height)
  expect(layout.preview).not.toBeNull()
  expect(layout.apply).not.toBeNull()
  expect(layout.preview!.right).toBeLessThanOrEqual(layout.apply!.left)
  expect(layout.preview!.bottom).toBeLessThanOrEqual(viewport.height)
  expect(layout.apply!.bottom).toBeLessThanOrEqual(viewport.height)

  await expect(page.locator('#btn-mass-tag-apply')).toBeDisabled()
  expect(requests).toEqual([])

  await page.locator('#btn-mass-tag-dry-run').click()
  await expect(page.locator('#mass-tag-status')).toContainText('Dry-run complete')
  await expect(page.locator('#mass-tag-result-summary')).toContainText('Dry-run')
  await expect(page.locator('#btn-mass-tag-apply')).toBeEnabled()
  expect(requests).toEqual([
    expect.objectContaining({
      image_ids: [1],
      tags: ['previewed_tag'],
      dry_run: true,
    }),
  ])

  await page.locator('input[name="mass-tag-scope"][value="filter"]').check()
  await expect(page.locator('#btn-mass-tag-apply')).toBeDisabled()
  await expect(page.locator('#mass-tag-result')).toBeHidden()
  expect(requests).toHaveLength(1)
  await page.locator('input[name="mass-tag-scope"][value="selection"]').check()
  await page.locator('#btn-mass-tag-dry-run').click()
  await expect(page.locator('#btn-mass-tag-apply')).toBeEnabled()
  expect(requests).toHaveLength(2)

  await page.evaluate(() => {
    ;(window as any).AppFilterAccess.getSelectedImageIds = () => [2]
  })
  await page.locator('#btn-mass-tag-apply').click()
  await expect(page.locator('#mass-tag-status')).toContainText('run the dry-run preview again')
  await expect(page.locator('#btn-mass-tag-apply')).toBeDisabled()
  expect(requests).toHaveLength(2)

  await page.evaluate(() => {
    ;(window as any).AppFilterAccess.getSelectedImageIds = () => [1]
  })

  await page.locator('#mass-tag-add-tags').fill('changed_after_preview')
  await expect(page.locator('#btn-mass-tag-apply')).toBeDisabled()
  await expect(page.locator('#mass-tag-result')).toBeHidden()
  expect(requests).toHaveLength(2)

  await page.locator('#btn-mass-tag-dry-run').click()
  await expect(page.locator('#btn-mass-tag-apply')).toBeEnabled()
  const applyButton = page.locator('#btn-mass-tag-apply')
  await applyButton.dblclick()
  await expect(page.locator('#mass-tag-status')).toContainText('Applied')
  expect(requests).toHaveLength(4)
  expect(requests[2]).toEqual(expect.objectContaining({
    image_ids: [1],
    tags: ['changed_after_preview'],
    dry_run: true,
  }))
  expect(requests[3]).toEqual(expect.objectContaining({
    image_ids: [1],
    tags: ['changed_after_preview'],
    dry_run: false,
  }))
})
}

test('large-scope confirmation rejects a selection changed during its countdown', async ({ page }) => {
  const requests: Array<Record<string, unknown>> = []
  await page.route('**/api/tags/bulk/add', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    requests.push(body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        operation: 'bulk_add',
        dry_run: body.dry_run,
        total_images_checked: 1001,
        affected_images: 1001,
        total_tags_added: 1001,
        sample_changes: [],
        op_id: null,
        undo_available: false,
        warnings: [],
      }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.evaluate(() => {
    ;(window as any).__massTagSelectionIds = Array.from({ length: 1001 }, (_, index) => index + 1)
    ;(window as any).AppFilterAccess.getSelectedImageIds = () => (
      (window as any).__massTagSelectionIds
    )
  })
  await page.locator('#btn-mass-tag-editor').click()
  await page.locator('.mass-tag-tab[data-mass-tag-tab="add"]').click()
  await page.locator('#mass-tag-add-tags').fill('large_scope_tag')
  await page.locator('#btn-mass-tag-dry-run').click()
  await expect(page.locator('#btn-mass-tag-apply')).toBeEnabled()

  await page.locator('#btn-mass-tag-apply').click()
  await expect(page.locator('#mass-tag-confirm-modal')).toHaveClass(/visible/)
  await page.evaluate(() => {
    ;(window as any).__massTagSelectionIds = Array.from({ length: 1001 }, (_, index) => index + 2)
  })
  await expect(page.locator('#btn-mass-tag-confirm-apply')).toBeEnabled({ timeout: 4000 })
  await page.locator('#btn-mass-tag-confirm-apply').click()

  await expect(page.locator('#mass-tag-confirm-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#mass-tag-status')).toContainText('run the dry-run preview again')
  await expect(page.locator('#btn-mass-tag-apply')).toBeDisabled()
  expect(requests).toHaveLength(1)
  expect(requests[0]).toEqual(expect.objectContaining({
    tags: ['large_scope_tag'],
    dry_run: true,
  }))
})
