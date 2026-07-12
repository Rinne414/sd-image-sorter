import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Characterization pins for the app.js god-file (14,274 lines) — "step 0" of a
 * later verbatim decomposition (mirrors the shipped censor-edit.js and
 * dataset-maker.js splits).
 *
 * app.js owns the `window.App` facade, the FilterStore/SelectionStore glue,
 * the /api/images query builders, view switching and toasts. These are the
 * seams dozens of other modules read at runtime. This spec pins the OBSERVABLE
 * behavior of those seams so the split is provably zero-behavior-change: it
 * MUST pass before AND after the refactor.
 *
 * Deliberately pinned quirks (each has a loud comment + a REPORT entry):
 *   - `window.App` is SEALED, so the future facade must be built as one object
 *     literal, not assembled by later `App.x = …` assignments;
 *   - the runtime default filter shape comes from FilterStore and OMITS
 *     dateFrom/dateTo, while the app.js inline fallback (dead code at runtime)
 *     still lists them;
 *   - **BUG pinned as-is:** the file-time date range filter (roadmap #12,
 *     commit 8b5de3f) is silently dropped by FilterStore.cloneState, so it
 *     never reaches /api/images. See the dedicated test below.
 *
 * The isolated e2e DB starts empty (0-count galleries are legitimate); the
 * suite storageState seeds aurora-entry-skip=1 so we land straight in the app.
 */

test.describe.configure({ mode: 'serial' })

type AnyWin = typeof window & { App: any; FilterStore: any }

async function gotoApp(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  // app.js runs at end of <body>; wait until the sealed facade is published.
  await page.waitForFunction(() => typeof (window as any).App?.buildSelectionFilterRequest === 'function')
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page)
})

// ---------------------------------------------------------------------------
// 1. Public surface — the sealed facade other modules depend on.
// ---------------------------------------------------------------------------

test('window.App is sealed and exposes the load-bearing public surface', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const App = (window as AnyWin).App
    // Names read by OTHER frontend/js files at runtime (grep `window.App.` and
    // `App.`). The future split's facade MUST keep every one of these callable.
    const requiredFns = [
      'showToast', 'showConfirm', 'showInputModal', 'showModal', 'hideModal', 'closeModal',
      'createGuideOverlay', 'copyTextToClipboard', 'showGlobalLoading', 'hideGlobalLoading',
      'createProgressTracker', 'resetProgressTracker', 'updateProgressTracker', 'buildProgressText',
      'formatDurationCompact', 'formatSize', 'loadImages', 'loadStats', 'beginTaggingProgress',
      'refreshAestheticStatus', 'updateSelectionUI', 'emitSelectionStateChanged', 'getSelectedGalleryCount',
      'isFilteredSelectionActiveForCurrentFilters', 'showRandomImage', 'showAnalytics', 'showExportModal',
      'showExportTagsModal', 'moveOrCopyGalleryImages', 'updateCollapsibleFilterUI', 'openModelSelect',
      'openFilterModal', 'applyModalFilters', 'resetAllFilters', 'updateFilterSummary', 'syncGenTabsWithFilters',
      'normalizePromptMatchMode', 'createDefaultFilterState', 'cloneFilterState', 'copyFilterState',
      'buildSelectionFilterRequest', 'getSelectionFilterCacheKey', 'buildAdvancedFilterContract',
      'getAdvancedFilterContractSignature', 'normalizeCheckpointFilterValue', 'setFilters', 'updateFilters',
      'createDefaultSelectionState', 'cloneSelectionState', 'setSelectionState', 'updateSelectionState',
      'mutateSelectedIds', 'clearSelectedIds', 'setSelectionMode', 'updateSortReverseButton',
      'syncGallerySortLabels', 'formatGeneratorLabel', 'loadSelectionData', 'loadSelectionDataByToken',
      'resetSelectionDataCache', 'markGalleryNeedsRefresh', 'openTagsLibrary', 'switchLibraryTab',
      'filterLibraryContent', 'switchView', 'openVlmSettings', 'openColorAnalysis', 'openGalleryPreview',
      'applyPromptFilter', 'applyTagFiltersFromExternal', 'showPipelineNextStep', 'hidePipelineNextStep',
      'addToCensorQueue', 'sendToCensor', 'addToDatasetMaker', 'openPromptBuildFromImage', 'openReaderFromImage',
      'openSimilarFromImage', 'deleteGalleryImagesByIds', 'removeGalleryImagesByIds', 'addRecentFolder',
      'getRecentFolders', 'updateScanDiagnosticsCard', 'copyScanDiagnostics', 'openScanLogFile',
      'clampTaggerChunkToAvailableOption', 'syncSettingsPreferenceStatus', 'persistArtistDefaultsFromDom', '$', '$$',
    ]
    const requiredObjs = ['API', 'Prefs', 'AppState', 'FilterStore', 'SelectionStore']
    // API sub-methods that consumers call directly (artist-ident, prompt-lab,
    // similar, censor family, mass-tag-editor, queue-solitaire, …).
    const requiredApiFns = [
      'get', 'post', 'delete', 'patch', 'getImages', 'getImage', 'buildFilterQueryParams',
      'createSelectionToken', 'getSelectionChunk', 'getSelectionData', 'getSelectionDataByToken',
      'getThumbnailUrl', 'getImageUrl', 'getTagsLibrary', 'getPromptsLibrary', 'getAnalyticsFacet',
      'batchMove', 'startSortSession',
    ]
    return {
      sealed: Object.isSealed(App),
      missingFns: requiredFns.filter((k) => typeof App[k] !== 'function'),
      missingObjs: requiredObjs.filter((k) => App[k] === undefined || App[k] === null),
      missingApiFns: requiredApiFns.filter((k) => typeof App.API?.[k] !== 'function'),
      // closeModal + sendToCensor are aliases of hideModal / addToCensorQueue.
      closeModalIsHideModal: App.closeModal === App.hideModal,
      sendToCensorIsAddToQueue: App.sendToCensor === App.addToCensorQueue,
    }
  })

  expect(probe.sealed).toBe(true)
  expect(probe.missingFns).toEqual([])
  expect(probe.missingObjs).toEqual([])
  expect(probe.missingApiFns).toEqual([])
  expect(probe.closeModalIsHideModal).toBe(true)
  expect(probe.sendToCensorIsAddToQueue).toBe(true)
})

// ---------------------------------------------------------------------------
// 2. createDefaultFilterState — the REAL runtime shape (FilterStore's).
// ---------------------------------------------------------------------------

test('createDefaultFilterState returns the FilterStore default shape (incl. dateFrom/dateTo)', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const App = (window as AnyWin).App
    const state = App.createDefaultFilterState()
    return {
      keyCount: Object.keys(state).length,
      generatorsLen: Array.isArray(state.generators) ? state.generators.length : -1,
      ratings: state.ratings,
      tags: state.tags,
      sortBy: state.sortBy,
      limit: state.limit,
      promptMatchMode: state.promptMatchMode,
      aspectRatio: state.aspectRatio,
      colorTemperature: state.colorTemperature,
      artistNull: state.artist === null,
      folderNull: state.folder === null,
      hasMetadataNull: state.hasMetadata === null,
      // Flipped from the pinned quirk: the date keys are first-class store
      // fields now (the missing-allowlist-entry bug is fixed).
      hasDateFromKey: 'dateFrom' in state,
      hasDateToKey: 'dateTo' in state,
      // Delegation check: app.js createDefaultFilterState forwards to FilterStore.
      matchesFilterStore:
        JSON.stringify(Object.keys(state).sort())
        === JSON.stringify(Object.keys((window as AnyWin).FilterStore.createDefaultFilterState()).sort()),
    }
  })

  // FilterStore.createDefaultFilterState (stores/filter-store.js) has exactly 43
  // keys. Bump this when a real filter field is added there — and make sure the
  // snake_case query builders + cloneState allowlist get it too (a key missing
  // from EITHER store function is silently stripped every cycle — the date-
  // filter bug this suite originally pinned).
  expect(probe.keyCount).toBe(43)
  expect(probe.matchesFilterStore).toBe(true)
  expect(probe.generatorsLen).toBe(14) // PRIMARY_GENERATORS + OTHERS bundle
  expect(probe.ratings).toEqual(['general', 'sensitive', 'questionable', 'explicit'])
  expect(probe.tags).toEqual([])
  expect(probe.sortBy).toBe('newest')
  expect(probe.limit).toBe(0)
  expect(probe.promptMatchMode).toBe('exact')
  expect(probe.aspectRatio).toBe('')
  expect(probe.colorTemperature).toBe('')
  expect(probe.artistNull).toBe(true)
  expect(probe.folderNull).toBe(true)
  expect(probe.hasMetadataNull).toBe(true)
  // Flipped 2026-07-13: dateFrom/dateTo are default keys now (the store
  // allowlists were the only gap; app.js's fallback branch already had them).
  expect(probe.hasDateFromKey).toBe(true)
  expect(probe.hasDateToKey).toBe(true)
})

// ---------------------------------------------------------------------------
// 3. buildSelectionFilterRequest — the camelCase selection/token contract.
// ---------------------------------------------------------------------------

test('buildSelectionFilterRequest emits the 42-key camelCase selection contract', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const App = (window as AnyWin).App
    const req = App.buildSelectionFilterRequest(App.createDefaultFilterState())
    const keys = Object.keys(req)
    return {
      keyCount: keys.length,
      // Present in the selection contract (camelCase — the /api/images/selection-*
      // POST body key names the backend expects verbatim).
      hasDateFrom: 'dateFrom' in req,
      hasDateTo: 'dateTo' in req,
      hasCollectionId: 'collectionId' in req,
      hasFolder: 'folder' in req,
      hasHasMetadata: 'hasMetadata' in req,
      hasNoCaption: 'noCaption' in req,
      hasSeed: 'seed' in req,
      hasMinUserRating: 'minUserRating' in req,
      // NOT part of the selection contract: `limit` (selection is unbounded).
      hasLimit: 'limit' in req,
      // Defaults collapse to null/empty on the wire.
      dateFromValue: req.dateFrom,
      artistValue: req.artist,
      aspectRatioValue: req.aspectRatio,
    }
  })

  // buildSelectionFilterRequest (app.js:391) returns 42 keys — the 41 default
  // fields MINUS `limit` PLUS dateFrom/dateTo (which it re-adds as null).
  expect(probe.keyCount).toBe(42)
  expect(probe.hasDateFrom).toBe(true)
  expect(probe.hasDateTo).toBe(true)
  expect(probe.hasCollectionId).toBe(true)
  expect(probe.hasFolder).toBe(true)
  expect(probe.hasHasMetadata).toBe(true)
  expect(probe.hasNoCaption).toBe(true)
  expect(probe.hasSeed).toBe(true)
  expect(probe.hasMinUserRating).toBe(true)
  expect(probe.hasLimit).toBe(false)
  expect(probe.dateFromValue).toBeNull()
  expect(probe.artistValue).toBeNull()
  expect(probe.aspectRatioValue).toBeNull() // normalized '' -> null in this builder
})

// ---------------------------------------------------------------------------
// 4. buildAdvancedFilterContract — the persisted/signature subset.
// ---------------------------------------------------------------------------

test('buildAdvancedFilterContract is the persisted subset (drops sortBy + toolbar 24d keys)', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const App = (window as AnyWin).App
    const contract = App.buildAdvancedFilterContract(App.createDefaultFilterState())
    const keys = Object.keys(contract)
    return {
      keyCount: keys.length,
      // Kept: the durable filter scope.
      hasDateFrom: 'dateFrom' in contract,
      hasCollectionId: 'collectionId' in contract,
      hasFolder: 'folder' in contract,
      hasHasMetadata: 'hasMetadata' in contract,
      // Dropped: sort + the Aurora Phase-3 toolbar/24d transient toggles.
      hasSortBy: 'sortBy' in contract,
      hasNoCaption: 'noCaption' in contract,
      hasAestheticUnscored: 'aestheticUnscored' in contract,
      hasMinSaturation: 'minSaturation' in contract,
      hasSeed: 'seed' in contract,
      // The signature helper is a stable JSON string of exactly this contract.
      signatureMatches:
        App.getAdvancedFilterContractSignature(App.createDefaultFilterState())
        === JSON.stringify(contract),
    }
  })

  // buildAdvancedFilterContract (app.js:447) returns 36 keys.
  expect(probe.keyCount).toBe(36)
  expect(probe.hasDateFrom).toBe(true)
  expect(probe.hasCollectionId).toBe(true)
  expect(probe.hasFolder).toBe(true)
  expect(probe.hasHasMetadata).toBe(true)
  expect(probe.hasSortBy).toBe(false)
  expect(probe.hasNoCaption).toBe(false)
  expect(probe.hasAestheticUnscored).toBe(false)
  expect(probe.hasMinSaturation).toBe(false)
  expect(probe.hasSeed).toBe(false)
  expect(probe.signatureMatches).toBe(true)
})

// ---------------------------------------------------------------------------
// 5. API.getImages — camelCase filter state -> snake_case query params.
// ---------------------------------------------------------------------------

test('API.getImages maps camelCase filters to snake_case /api/images query params', async ({ page }) => {
  let capturedUrl = ''
  await page.route(/\/api\/images\?/, async (route) => {
    capturedUrl = route.request().url()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ images: [], has_more: false, total: 0 }),
    })
  })

  // Rich filter object passed DIRECTLY to getImages (not through the store), so
  // getImages' own mapping is what we observe — including dateFrom, which the
  // store would otherwise strip (see the date-filter bug test).
  await page.evaluate(async () => {
    await (window as AnyWin).App.API.getImages({
      generators: ['comfyui', 'nai'],
      ratings: ['general'],
      tags: ['1girl', 'solo'],
      tagMode: 'or',
      checkpoints: ['model.safetensors'],
      minWidth: 512,
      maxHeight: 2048,
      aspectRatio: 'portrait',
      dateFrom: '2026-01-01',
      dateTo: '2026-02-01',
      minUserRating: 4,
      excludeTags: ['bad'],
      colorHues: ['red', 'blue'],
      hasMetadata: false,
      noCaption: true,
      minSaturation: 20,
      seed: 12345,
      sortBy: 'oldest',
      limit: 42,
    })
  })

  const q = new URL(capturedUrl).searchParams
  expect(q.get('generators')).toBe('comfyui,nai')
  expect(q.get('ratings')).toBe('general')
  expect(q.get('tags')).toBe('1girl,solo')
  expect(q.get('tag_mode')).toBe('or') // sent only when != 'and'
  expect(q.get('checkpoints')).toBe('model.safetensors')
  expect(q.get('min_width')).toBe('512')
  expect(q.get('max_height')).toBe('2048')
  expect(q.get('aspect_ratio')).toBe('portrait')
  expect(q.get('date_from')).toBe('2026-01-01')
  expect(q.get('date_to')).toBe('2026-02-01')
  expect(q.get('min_user_rating')).toBe('4')
  expect(q.get('exclude_tags')).toBe('bad')
  expect(q.get('color_hues')).toBe('red,blue')
  expect(q.get('has_metadata')).toBe('false')
  expect(q.get('no_caption')).toBe('true')
  expect(q.get('min_saturation')).toBe('20')
  expect(q.get('seed')).toBe('12345')
  expect(q.get('sort_by')).toBe('oldest')
  expect(q.get('limit')).toBe('42')

  // tagMode 'and' is the default and must be OMITTED from the wire.
  await page.evaluate(async () => {
    await (window as AnyWin).App.API.getImages({ tags: ['x'], tagMode: 'and' })
  })
  const q2 = new URL(capturedUrl).searchParams
  expect(q2.get('tag_mode')).toBeNull()
  // limit defaults to 200 when not supplied.
  expect(q2.get('limit')).toBe('200')
})

// ---------------------------------------------------------------------------
// 6. API.buildFilterQueryParams — same mapping, no pagination/sort.
// ---------------------------------------------------------------------------

test('API.buildFilterQueryParams mirrors getImages mapping without pagination/sort keys', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const App = (window as AnyWin).App
    const params = App.API.buildFilterQueryParams({
      generators: ['comfyui'],
      tags: ['1girl'],
      dateFrom: '2026-03-04',
      hasMetadata: true,
      sortBy: 'oldest', // must be IGNORED by this builder
      limit: 99, // must be IGNORED
      cursor: 'abc', // must be IGNORED
    })
    const q = params.toString()
    return {
      isSearchParams: params instanceof URLSearchParams,
      generators: params.get('generators'),
      tags: params.get('tags'),
      dateFrom: params.get('date_from'),
      hasMetadata: params.get('has_metadata'),
      // These three belong to getImages only — the count/preview builder omits them.
      hasSortBy: q.includes('sort_by='),
      hasLimit: q.includes('limit='),
      hasCursor: q.includes('cursor='),
    }
  })

  expect(probe.isSearchParams).toBe(true)
  expect(probe.generators).toBe('comfyui')
  expect(probe.tags).toBe('1girl')
  expect(probe.dateFrom).toBe('2026-03-04')
  expect(probe.hasMetadata).toBe('true')
  expect(probe.hasSortBy).toBe(false)
  expect(probe.hasLimit).toBe(false)
  expect(probe.hasCursor).toBe(false)
})

// ---------------------------------------------------------------------------
// 7. updateFilters / setFilters round-trip through the FilterStore.
// ---------------------------------------------------------------------------

test('updateFilters mutates AppState.filters and setFilters restores defaults', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const App = (window as AnyWin).App
    App.updateFilters((f: any) => { f.tags = ['alpha', 'beta']; f.search = 'hello' })
    const afterUpdate = {
      tags: [...App.AppState.filters.tags],
      search: App.AppState.filters.search,
    }
    App.setFilters(App.createDefaultFilterState())
    const afterReset = {
      tags: [...App.AppState.filters.tags],
      search: App.AppState.filters.search,
      generatorsLen: App.AppState.filters.generators.length,
    }
    return { afterUpdate, afterReset }
  })

  // AppState.filters is kept in sync by the FilterStore subscription (app.js:733).
  expect(probe.afterUpdate.tags).toEqual(['alpha', 'beta'])
  expect(probe.afterUpdate.search).toBe('hello')
  expect(probe.afterReset.tags).toEqual([])
  expect(probe.afterReset.search).toBe('')
  expect(probe.afterReset.generatorsLen).toBe(14)
})

// ---------------------------------------------------------------------------
// 8. FIXED (was the pinned date-filter bug): the range survives the store.
// ---------------------------------------------------------------------------

test('date range filter survives the FilterStore round-trip onto the wire', async ({ page }) => {
  // History: roadmap #12 / commit 8b5de3f added dateFrom/dateTo to the filter
  // modal + the app.js createDefaultFilterState FALLBACK + the query builders,
  // but not to stores/filter-store.js — and the store's cloneState allowlist
  // runs on EVERY filter write, so the value was silently discarded and the
  // gallery date filter was a runtime no-op. This suite pinned that bug as-is;
  // the store fix flipped these expectations to assert the value survives all
  // three hops: store -> selection contract -> /api/images query string.
  let capturedUrl = ''
  await page.route(/\/api\/images\?/, async (route) => {
    capturedUrl = route.request().url()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ images: [], has_more: false, total: 0 }),
    })
  })

  const probe = await page.evaluate(async () => {
    const App = (window as AnyWin).App
    App.setFilters(App.createDefaultFilterState())
    App.updateFilters((f: any) => { f.dateFrom = '2026-01-01'; f.dateTo = '2026-02-01' })
    // Read the value back out of the single source of truth after the round-trip.
    const storedDateFrom = App.AppState.filters.dateFrom
    // And what the selection contract would put on the wire for this state.
    const selReq = App.buildSelectionFilterRequest(App.AppState.filters)
    // And what the gallery's own load path sends.
    await App.API.getImages(App.AppState.filters)
    return {
      storedDateFrom: storedDateFrom ?? null,
      storedHasKey: 'dateFrom' in App.AppState.filters,
      selectionDateFrom: selReq.dateFrom,
    }
  })

  const q = new URL(capturedUrl).searchParams
  // The value lands in the store...
  expect(probe.storedDateFrom).toBe('2026-01-01')
  expect(probe.storedHasKey).toBe(true)
  // ...the selection contract carries it...
  expect(probe.selectionDateFrom).toBe('2026-01-01')
  // ...and the gallery query puts it on the wire.
  expect(q.get('date_from')).toBe('2026-01-01')
  expect(q.get('date_to')).toBe('2026-02-01')
})

// ---------------------------------------------------------------------------
// 9. switchView side effects (view panels, nav tabs, selection FAB).
// ---------------------------------------------------------------------------

test('switchView toggles currentView, the active .view panel, nav tab state and the selection FAB', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const App = (window as AnyWin).App
    App.switchView('sorting')
    const onSorting = {
      currentView: App.AppState.currentView,
      sortingActive: document.getElementById('view-sorting')?.classList.contains('active') ?? null,
      galleryActive: document.getElementById('view-gallery')?.classList.contains('active') ?? null,
      // The multi-select FAB must be hidden outside the gallery view.
      selectionActionsDisplay: (document.getElementById('selection-actions') as HTMLElement | null)?.style.display ?? null,
      sortingTabSelected: document.querySelector('.nav-tab[data-view="sorting"]')?.getAttribute('aria-selected') ?? null,
    }
    App.switchView('gallery')
    const onGallery = {
      currentView: App.AppState.currentView,
      galleryActive: document.getElementById('view-gallery')?.classList.contains('active') ?? null,
      sortingActive: document.getElementById('view-sorting')?.classList.contains('active') ?? null,
    }
    return { onSorting, onGallery }
  })

  expect(probe.onSorting.currentView).toBe('sorting')
  expect(probe.onSorting.sortingActive).toBe(true)
  expect(probe.onSorting.galleryActive).toBe(false)
  expect(probe.onSorting.selectionActionsDisplay).toBe('none')
  expect(probe.onSorting.sortingTabSelected).toBe('true')
  expect(probe.onGallery.currentView).toBe('gallery')
  expect(probe.onGallery.galleryActive).toBe(true)
  expect(probe.onGallery.sortingActive).toBe(false)
})

// ---------------------------------------------------------------------------
// 10. showToast — dedup of identical toasts + a hard cap of 5 visible.
// ---------------------------------------------------------------------------

test('showToast deduplicates identical messages and caps the stack at five', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const App = (window as AnyWin).App
    const container = document.getElementById('toast-container')
    if (container) container.replaceChildren()

    // Identical message + type twice => a single toast (dedup on message+type).
    App.showToast('pin-dup-message', 'info')
    App.showToast('pin-dup-message', 'info')
    const afterDup = document.querySelectorAll('#toast-container .toast').length

    // Six distinct messages => container is capped at 5 (oldest dropped).
    for (let i = 0; i < 6; i += 1) App.showToast(`pin-cap-${i}`, 'success')
    const afterCap = document.querySelectorAll('#toast-container .toast').length

    return { afterDup, afterCap }
  })

  expect(probe.afterDup).toBe(1)
  expect(probe.afterCap).toBeLessThanOrEqual(5)
})
