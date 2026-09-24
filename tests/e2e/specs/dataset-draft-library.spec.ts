import { expect, test } from '../fixtures/click-ledger'

/**
 * The unsaved Dataset Maker draft belongs to the library it was started in.
 * A library switch stores the new id before its event runs, so a pending
 * save used to write library A's queue into library B's draft slot, and B's
 * own unsaved captions were overwritten.
 */

const DRAFT_PREFIX = 'sd-image-sorter-dataset-session:'

test('switching libraries keeps each unsaved dataset draft in its own library', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.waitForFunction(() => {
    const dm = (window as any).DatasetMaker
    return dm?._trainerContractState?.status === 'ready' && dm?._pendingProjectSettings === null
  })

  // An edit in main whose debounced save is still pending when the switch happens.
  const otherId = await page.evaluate(async () => {
    const dm = (window as any).DatasetMaker
    const lw = (window as any).LibraryWorkspace
    dm._quickfilledTrigger = 'Main_Token'
    dm._scheduleSaveSession(60000)
    const res = await lw.apiFetch('/api/libraries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name: `E2E draft ${Date.now()}` }),
    })
    const data = await res.json()
    await lw.setCurrentLibraryId(data.library.id, { reloadGallery: false })
    return String(data.library.id)
  })

  try {
    // The other library opens with its own (empty) draft, not main's queue.
    await expect.poll(() => page.evaluate(() => (window as any).DatasetMaker._quickfilledTrigger)).toBe('')
    const slots = await page.evaluate(({ prefix, id }) => ({
      main: JSON.parse(localStorage.getItem(`${prefix}main`) || 'null')?.quickfilledTrigger ?? null,
      other: JSON.parse(localStorage.getItem(`${prefix}${id}`) || 'null')?.quickfilledTrigger ?? null,
    }), { prefix: DRAFT_PREFIX, id: otherId })
    expect(slots.main).toBe('Main_Token')
    expect(slots.other).not.toBe('Main_Token')

    // Back in main, its draft comes back.
    await page.evaluate(async () => {
      await (window as any).LibraryWorkspace.setCurrentLibraryId('main', { reloadGallery: false })
    })
    await expect.poll(() => page.evaluate(() => (window as any).DatasetMaker._quickfilledTrigger)).toBe('Main_Token')
  } finally {
    await page.evaluate(async (id) => {
      const lw = (window as any).LibraryWorkspace
      await lw.setCurrentLibraryId('main', { reloadGallery: false })
      await lw.apiFetch(`/api/libraries/${encodeURIComponent(id)}`, { method: 'DELETE' })
      localStorage.removeItem(`sd-image-sorter-dataset-session:${id}`)
    }, otherId)
  }
})
