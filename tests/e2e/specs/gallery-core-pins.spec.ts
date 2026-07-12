import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Characterization pins for the gallery.js god-file (4,708 lines) — "step 0" of a
 * later verbatim decomposition (mirrors the shipped censor-edit.js / dataset-maker.js
 * splits and the in-progress app.js -> app/*.js split).
 *
 * gallery.js publishes ONE global — `window.Gallery` — built as a single object
 * LITERAL (`const Gallery = { ...~4540 lines... }; window.Gallery = Gallery`). That
 * is structurally different from app.js (top-level `function` declarations collected
 * by a sealed `buildAppContext()` facade): a method cannot simply be cut into another
 * file and keep its identity, because object-literal method shorthand is not a global.
 * So the split must reassemble Gallery incrementally (`Object.assign(Gallery, {...})`),
 * and — unlike App — Gallery is NOT sealed and is reached into for private helpers by
 * other modules (`manual-sort.js` calls `_extractParsedData`, `image-reader.js` calls
 * `_buildPromptView`). This spec pins the OBSERVABLE behavior of the seams other
 * modules depend on so the split is provably zero-behavior-change: it MUST pass before
 * AND after the refactor.
 *
 * Scope note — pins here deliberately AVOID what neighboring specs already cover:
 *   - virtual-list layout / thumbnail-size reflow -> gallery-thumb-size-reflow.spec.ts
 *   - context-menu action list + positioning + modal open/prev-next scroll -> smoke.spec.ts
 * This spec pins the currently-UNPINNED units: the public surface shape, the
 * virtual-scroll THRESHOLD decision, non-virtual grid rendering, the favorites
 * hydrate/optimistic-toggle/rollback path, selection<->grid interplay, the pure
 * NAI<->SD prompt-format conversion, and the parsed-metadata fallback.
 *
 * The isolated e2e DB starts empty; every card here is synthesized in-page via
 * `Gallery.setImages([...])` (no DB seeding — avoids the `.tmp/e2e-data-<port>`
 * cross-run pollution pitfall), the same shape smoke.spec.ts's mockGalleryImages uses.
 */

test.describe.configure({ mode: 'serial' })

async function gotoGallery(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  // gallery.js loads right after app.js at the end of <body>; wait for both the
  // Gallery global and a settled App before driving anything.
  await page.waitForFunction(() =>
    typeof window.Gallery?.setImages === 'function'
    && typeof window.App?.switchView === 'function'
    && window.App?.AppState?.isLoading === false)
  await page.evaluate(() => window.App.switchView('gallery'))
}

/**
 * Render `count` synthetic cards into #gallery-grid via the real Gallery.setImages
 * path (non-virtual for count < GALLERY_VIRTUAL_CONFIG.threshold=96). Ids start at
 * 9001. Returns the id list. Mirrors AppState.images too, because selectRange reads
 * indices off AppState.images (not Gallery.images).
 */
async function seedGrid(page: Page, count: number): Promise<number[]> {
  const ids = await page.evaluate((n) => {
    const imgs = Array.from({ length: n }, (_v, i) => ({
      id: 9001 + i,
      filename: `pin-${9001 + i}.png`,
      generator: 'webui',
      width: 512,
      height: 512,
      file_size: 1000 + i,
    }))
    window.App.AppState.viewMode = 'grid'
    window.App.AppState.images = imgs
    window.Gallery.setImages(imgs)
    return imgs.map((im) => im.id)
  }, count)
  await expect
    .poll(() => page.locator('#gallery-grid .gallery-item[data-id]').count())
    .toBeGreaterThanOrEqual(count)
  return ids
}

test.beforeEach(async ({ page }) => {
  await gotoGallery(page)
})

// ---------------------------------------------------------------------------
// 1. Public surface — the (unsealed) window.Gallery other modules depend on.
// ---------------------------------------------------------------------------

test('window.Gallery is an unsealed object exposing the load-bearing public surface', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const G = window.Gallery
    // Names read by OTHER frontend/js files at runtime (grep `window.Gallery.` /
    // `Gallery.` across frontend/js). The split must keep every one callable on the
    // reassembled object — including the "private" _-prefixed ones cross-module
    // consumers reach into (image-reader._buildPromptView, manual-sort._extractParsedData,
    // app/gallery-load._getScrollContainer, app/toasts-modals._cleanupZoomHandlers).
    const requiredFns = [
      'hydrateFavorites', 'isFavorited', 'toggleFavorite', 'setUserRating',
      'initKeyboardNavigation', 'openPreview', 'openAdjacentPreview', 'setThumbnailSize',
      'getThumbnailSizePx', 'setViewMode', 'setImages', 'appendImages', 'refresh', 'render',
      'clearSelection', 'selectAllVisible', 'invertVisibleSelection', 'toggleSelection',
      'selectRange', 'syncSelectionState', 'handleSelectionInteraction', 'getVisibleGalleryIds',
      'refreshLocalizedContent', 'destroy', 'openMetadataEditor', 'saveMetadataEdit',
      'initVirtualScroll', 'shouldUseVirtualScroll', 'getVirtualStats',
      '_getScrollContainer', '_extractParsedData', '_buildPromptView', '_cleanupZoomHandlers',
    ]
    const requiredProps = ['images', 'favoriteIds', 'currentPreviewIndex', 'lastSelectedIndex',
      'useVirtualScroll', 'modalSectionState']
    return {
      isObject: G !== null && typeof G === 'object',
      // Deliberately NOT sealed (contrast with the sealed window.App facade): other
      // modules read private helpers off it, and the split reassembles it with
      // Object.assign — both require a mutable object.
      sealed: Object.isSealed(G),
      identity: window.Gallery === G,
      missingFns: requiredFns.filter((k) => typeof G[k] !== 'function'),
      missingProps: requiredProps.filter((k) => !(k in G)),
      imagesIsArray: Array.isArray(G.images),
      favoriteIdsIsSet: G.favoriteIds instanceof Set,
      // gallery.js also publishes this sibling global (used for the threshold pin).
      configThreshold: (window as any).GALLERY_VIRTUAL_CONFIG?.threshold,
    }
  })

  expect(probe.isObject).toBe(true)
  expect(probe.sealed).toBe(false)
  expect(probe.identity).toBe(true)
  expect(probe.missingFns).toEqual([])
  expect(probe.missingProps).toEqual([])
  expect(probe.imagesIsArray).toBe(true)
  expect(probe.favoriteIdsIsSet).toBe(true)
  expect(probe.configThreshold).toBe(96)
})

// ---------------------------------------------------------------------------
// 2. shouldUseVirtualScroll — the threshold decision (grid=96, large/waterfall>0).
// ---------------------------------------------------------------------------

test('shouldUseVirtualScroll gates grid on the 96-item threshold and forces large/waterfall', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const G = window.Gallery
    return {
      // VirtualList must be loaded in the running app (the whole gallery relies on
      // it); the reflow spec proves it activates at 120 items.
      virtualListLoaded: typeof (window as any).VirtualList !== 'undefined',
      waterfallLoaded: typeof (window as any).WaterfallVirtualList !== 'undefined',
      grid95: G.shouldUseVirtualScroll(95, 'grid'),
      grid96: G.shouldUseVirtualScroll(96, 'grid'),
      large0: G.shouldUseVirtualScroll(0, 'large'),
      large1: G.shouldUseVirtualScroll(1, 'large'),
      waterfall0: G.shouldUseVirtualScroll(0, 'waterfall'),
      waterfall1: G.shouldUseVirtualScroll(1, 'waterfall'),
    }
  })

  expect(probe.virtualListLoaded).toBe(true)
  expect(probe.waterfallLoaded).toBe(true)
  // grid mode: strictly below threshold(96) = standard render, at/above = virtual.
  expect(probe.grid95).toBe(false)
  expect(probe.grid96).toBe(true)
  // large/waterfall: ANY item forces virtual (threshold is bypassed), empty = false.
  expect(probe.large0).toBe(false)
  expect(probe.large1).toBe(true)
  expect(probe.waterfall0).toBe(false)
  expect(probe.waterfall1).toBe(true)
})

// ---------------------------------------------------------------------------
// 3. setImages (< threshold) renders real non-virtual cards into #gallery-grid.
// ---------------------------------------------------------------------------

test('setImages renders non-virtual gallery cards with id, favorite button and generator overlay', async ({ page }) => {
  await seedGrid(page, 6)

  const grid = page.locator('#gallery-grid')
  // 6 < 96 -> the standard (non-virtual) render path; the grid must NOT be in
  // virtual-scroll mode here (that mode is pinned separately by the reflow spec).
  await expect(grid).not.toHaveClass(/virtual-scroll/)
  await expect(grid.locator('.gallery-item[data-id]')).toHaveCount(6)

  const first = grid.locator('.gallery-item[data-id="9001"]')
  await expect(first).toBeVisible()
  // Each card carries the heart toggle (default not-favorited) and the generator badge.
  await expect(first.locator('.gallery-item-fav[aria-pressed="false"]')).toHaveCount(1)
  await expect(first.locator('.gallery-item-generator')).toHaveAttribute('data-generator-value', 'webui')
  expect(await page.evaluate(() => window.Gallery.useVirtualScroll)).toBe(false)
})

// ---------------------------------------------------------------------------
// 4. hydrateFavorites — /api/collections/favorites/ids -> favoriteIds + DOM hearts.
// ---------------------------------------------------------------------------

test('hydrateFavorites loads the favorite id set and reflects it on rendered hearts', async ({ page }) => {
  const ids = await seedGrid(page, 6)
  const favId = ids[2] // 9003

  await page.route('**/api/collections/favorites/ids', async (route) => {
    await route.fulfill({ json: { image_ids: [favId] } })
  })

  const state = await page.evaluate(async () => {
    await window.Gallery.hydrateFavorites()
    return {
      favIds: Array.from(window.Gallery.favoriteIds),
      isFav: window.Gallery.isFavorited(9003),
      notFav: window.Gallery.isFavorited(9001),
    }
  })

  expect(state.favIds).toEqual([favId])
  expect(state.isFav).toBe(true)
  expect(state.notFav).toBe(false)
  // hydrate re-applies to already-rendered cards: only 9003's heart flips on.
  await expect(page.locator('.gallery-item[data-id="9003"] .gallery-item-fav')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.gallery-item[data-id="9001"] .gallery-item-fav')).toHaveAttribute('aria-pressed', 'false')
})

// ---------------------------------------------------------------------------
// 5. toggleFavorite — optimistic add, reconcile with the server `favorited` flag.
// ---------------------------------------------------------------------------

test('toggleFavorite optimistically favorites, reconciles with the server, and updates the heart', async ({ page }) => {
  await seedGrid(page, 6)
  // notifyChanged() fires a fire-and-forget collections refresh; keep it benign.
  await page.route('**/api/collections', async (route) => route.fulfill({ json: { collections: [] } }))
  let sawBody: any = null
  await page.route('**/api/collections/favorites', async (route) => {
    sawBody = route.request().postDataJSON()
    await route.fulfill({ json: { favorited: true } })
  })

  const result = await page.evaluate(async () => {
    await window.Gallery.toggleFavorite(9002)
    return window.Gallery.isFavorited(9002)
  })

  expect(result).toBe(true)
  // The POST body is the {image_id, favorited} contract app/api-features.js sends.
  expect(sawBody).toMatchObject({ image_id: 9002, favorited: true })
  await expect(page.locator('.gallery-item[data-id="9002"] .gallery-item-fav')).toHaveAttribute('aria-pressed', 'true')
})

// ---------------------------------------------------------------------------
// 6. toggleFavorite — rolls the optimistic change back when the server errors.
// ---------------------------------------------------------------------------

test('toggleFavorite rolls back the optimistic favorite when the server call fails', async ({ page }) => {
  await seedGrid(page, 6)
  await page.route('**/api/collections', async (route) => route.fulfill({ json: { collections: [] } }))
  await page.route('**/api/collections/favorites', async (route) => {
    await route.fulfill({ status: 500, json: { error: 'boom' } })
  })

  const result = await page.evaluate(async () => {
    await window.Gallery.toggleFavorite(9004)
    return window.Gallery.isFavorited(9004)
  })

  // Optimistic add is reverted on failure -> id absent, heart back to not-pressed.
  expect(result).toBe(false)
  await expect(page.locator('.gallery-item[data-id="9004"] .gallery-item-fav')).toHaveAttribute('aria-pressed', 'false')
})

// ---------------------------------------------------------------------------
// 7. toggleSelection — flips the card DOM + AppState.selectedIds, scope 'visible'.
// ---------------------------------------------------------------------------

test('toggleSelection marks the card selected, mirrors AppState.selectedIds, and sets visible scope', async ({ page }) => {
  await seedGrid(page, 6)

  const afterSelect = await page.evaluate(() => {
    window.Gallery.toggleSelection(9002)
    return {
      selectedIds: Array.from(window.App.AppState.selectedIds),
      scope: window.App.AppState.selectionScope,
    }
  })
  expect(afterSelect.selectedIds).toContain(9002)
  expect(afterSelect.scope).toBe('visible')
  const card = page.locator('.gallery-item[data-id="9002"]')
  await expect(card).toHaveClass(/selected/)
  await expect(card).toHaveAttribute('aria-selected', 'true')

  // Toggling again clears it back off.
  const afterDeselect = await page.evaluate(() => {
    window.Gallery.toggleSelection(9002)
    return Array.from(window.App.AppState.selectedIds)
  })
  expect(afterDeselect).not.toContain(9002)
  await expect(card).not.toHaveClass(/selected/)
  await expect(card).toHaveAttribute('aria-selected', 'false')
})

// ---------------------------------------------------------------------------
// 8. selectAllVisible / clearSelection — operate over the rendered visible grid.
// ---------------------------------------------------------------------------

test('selectAllVisible selects every rendered card and clearSelection empties it', async ({ page }) => {
  const ids = await seedGrid(page, 6)

  const afterAll = await page.evaluate(() => {
    window.Gallery.selectAllVisible()
    return {
      selectedIds: (Array.from(window.App.AppState.selectedIds) as number[]).sort((a, b) => a - b),
      scope: window.App.AppState.selectionScope,
      visibleIds: (window.Gallery.getVisibleGalleryIds() as number[]).sort((a, b) => a - b),
    }
  })
  expect(afterAll.selectedIds).toEqual(ids)
  expect(afterAll.visibleIds).toEqual(ids)
  expect(afterAll.scope).toBe('visible')
  await expect(page.locator('#gallery-grid .gallery-item.selected')).toHaveCount(6)

  const afterClear = await page.evaluate(() => {
    window.Gallery.clearSelection()
    return Array.from(window.App.AppState.selectedIds)
  })
  expect(afterClear).toEqual([])
  await expect(page.locator('#gallery-grid .gallery-item.selected')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// 9. selectRange — inclusive index window off AppState.images, scope 'loaded'.
// ---------------------------------------------------------------------------

test('selectRange selects the inclusive index window and switches scope to loaded', async ({ page }) => {
  const ids = await seedGrid(page, 6)

  const probe = await page.evaluate(() => {
    // Indices 1..3 inclusive -> AppState.images[1..3] = ids 9002,9003,9004.
    window.Gallery.selectRange(1, 3)
    return {
      selectedIds: (Array.from(window.App.AppState.selectedIds) as number[]).sort((a, b) => a - b),
      scope: window.App.AppState.selectionScope,
      lastSelectedIndex: window.Gallery.lastSelectedIndex,
    }
  })

  expect(probe.selectedIds).toEqual([ids[1], ids[2], ids[3]])
  // selectRange is the shift-click path -> the durable 'loaded' scope, not 'visible'.
  expect(probe.scope).toBe('loaded')
  expect(probe.lastSelectedIndex).toBe(3)
})

// ---------------------------------------------------------------------------
// 10. _buildPromptView — the pure NAI<->SD conversion image-reader.js reuses.
// ---------------------------------------------------------------------------

test('_buildPromptView converts NAI<->SD weight syntax and passes original through unchanged', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const G = window.Gallery
    // NAI source: {emphasis} -> (…:1.05), [de-emphasis] -> (…:0.952), n::tag:: -> (tag:n).
    const naiImage = { generator: 'nai', prompt: '{masterpiece}, [bad], 1.3::detailed::' }
    const toSd = G._buildPromptView(naiImage, {}, 'sd')
    const naiOriginal = G._buildPromptView(naiImage, {}, 'original')
    // SD source: (tag:w) -> w::tag::, <lora:name:w> -> w::name::.
    const sdImage = { generator: 'webui', prompt: '(masterpiece:1.2), <lora:foo:0.8>' }
    const toNai = G._buildPromptView(sdImage, {}, 'nai')
    return {
      sdText: toSd.promptText,
      sdLabel: toSd.formatLabel,
      sdConverted: toSd.isConverted,
      naiOriginalText: naiOriginal.promptText,
      naiOriginalConverted: naiOriginal.isConverted,
      naiText: toNai.promptText,
      naiLabel: toNai.formatLabel,
      naiConverted: toNai.isConverted,
    }
  })

  // NAI -> SD.
  expect(probe.sdLabel).toBe('SD')
  expect(probe.sdConverted).toBe(true)
  expect(probe.sdText).toContain('(masterpiece:1.05)')
  expect(probe.sdText).toContain('(bad:0.952)')
  expect(probe.sdText).toContain('(detailed:1.3)')
  // 'original' target is a verbatim passthrough of the source prompt.
  expect(probe.naiOriginalConverted).toBe(false)
  expect(probe.naiOriginalText).toBe('{masterpiece}, [bad], 1.3::detailed::')
  // SD -> NAI.
  expect(probe.naiLabel).toBe('NAI')
  expect(probe.naiConverted).toBe(true)
  expect(probe.naiText).toContain('1.2::masterpiece::')
  expect(probe.naiText).toContain('0.8::foo::')
})

// ---------------------------------------------------------------------------
// 11. _extractParsedData — returns metadata_json._parsed, else the empty fallback.
// ---------------------------------------------------------------------------

test('_extractParsedData returns the embedded _parsed block or the empty fallback shape', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const G = window.Gallery
    // metadata_json may arrive as a JSON string (DB column) or an object.
    const withParsed = G._extractParsedData({
      metadata_json: JSON.stringify({ _parsed: { is_img2img: true, character_prompts: [{ prompt: 'a' }] } }),
    })
    const missing = G._extractParsedData({ metadata_json: '{}' })
    return {
      withParsedImg2img: withParsed.is_img2img,
      withParsedChars: withParsed.character_prompts.length,
      fallbackImg2img: missing.is_img2img,
      fallbackChars: Array.isArray(missing.character_prompts) ? missing.character_prompts.length : -1,
      fallbackNodes: Array.isArray(missing.prompt_nodes) ? missing.prompt_nodes.length : -1,
      fallbackModelAssetsNull: missing.model_assets === null,
      fallbackParamsEmpty: missing.generation_params && Object.keys(missing.generation_params).length === 0,
    }
  })

  expect(probe.withParsedImg2img).toBe(true)
  expect(probe.withParsedChars).toBe(1)
  // Fallback shape (consumed by manual-sort.js): all-empty, model_assets null.
  expect(probe.fallbackImg2img).toBe(false)
  expect(probe.fallbackChars).toBe(0)
  expect(probe.fallbackNodes).toBe(0)
  expect(probe.fallbackModelAssetsNull).toBe(true)
  expect(probe.fallbackParamsEmpty).toBe(true)
})
