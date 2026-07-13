import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Characterization pins for the similar.js god-file (1,517 lines) — "step 0" of a
 * later VERBATIM decomposition (mirrors the shipped gallery.js -> gallery/*.js,
 * app.js -> app/*.js, image-reader.js pins, censor, dataset, autosep, manual-sort,
 * prompt-lab, v321-ui splits).
 *
 * similar.js publishes TWO globals:
 *   - `window.SimilarImages` — a single object LITERAL (`const SimilarImages = { ...
 *     ~1470 lines... }`) that is NOT wrapped in an IIFE and holds NO closure-private
 *     state (every method uses `this.*` + the `window.*` globals). That is the exact
 *     shape gallery.js / image-reader.js have, so — unlike queue-solitaire.js's
 *     true-IIFE exemption — it is fully splittable by reassembling the object
 *     incrementally (`Object.assign(window.SimilarImages, {...})`). The object is NOT
 *     sealed.
 *   - `window.initSimilar` — the boot remainder: a module-private `let
 *     similarInitialized` guard + `function initSimilar()` that calls
 *     `SimilarImages.init()` once (and `resumeEmbeddingProgress()` thereafter).
 *
 * Cross-module consumers the split must keep working (grep confirms these are the ONLY
 * external runtime entry points):
 *   - app/view-switch.js  -> `window.initSimilar()` when the Similar view activates.
 *   - app/handoffs.js     -> `window.initSimilar()` then `window.SimilarImages.searchByImage(id)`.
 * backend/tests/test_frontend_contract.py does NOT pin any similar.js literal, but its
 * generic per-file rules (no `AppState.*` writes, no `window.App.*` writes) DO cover
 * every future frontend/js/similar/*.js file — similar.js already complies.
 *
 * No DB seeding and no CLIP models: every case drives SimilarImages in-page via direct
 * method calls + route-mocked /api/similarity/* responses (avoids the
 * `.tmp/e2e-data-<port>` cross-run pollution pitfall and the missing-model dependency).
 * It MUST pass before AND after the refactor.
 */

test.describe.configure({ mode: 'serial' })

/**
 * Land on the app, wait for SimilarImages + App.API to exist, and reveal #view-similar
 * so its controls are visible (the view is otherwise display:none). Deliberately does
 * NOT call initSimilar(): the pins below call SimilarImages methods directly, so the
 * real /api/similarity/model-status|stats|progress boot never fires unless a test opts
 * into it via initSimilarView().
 */
async function gotoSimilar(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => {
    const w = window as any
    return !!w.SimilarImages
      && typeof w.SimilarImages.searchByImage === 'function'
      && typeof w.initSimilar === 'function'
      && typeof w.App?.API?.get === 'function'
  })
  await page.evaluate(() => {
    const view = document.getElementById('view-similar')
    if (!view) return
    document.querySelectorAll('.view').forEach((node) => {
      if (node !== view) (node as HTMLElement).style.display = 'none'
    })
    ;(view as HTMLElement).style.display = 'block'
    view.classList.add('active')
  })
}

/**
 * Run the real init() once with the boot endpoints mocked to a "ready" state, so
 * bindEvents() wires the DOM handlers. Used only by the tab-switch pin.
 */
async function initSimilarView(page: Page): Promise<void> {
  await page.route('**/api/similarity/model-status', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true }) }))
  await page.route('**/api/similarity/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ total_images: 10, embedded_count: 10, pending_count: 0, unreadable_count: 0 }),
    }))
  await page.route('**/api/similarity/progress', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ running: false }) }))
  await page.evaluate(() => (window as any).initSimilar())
  await page.waitForFunction(() => (window as any).SimilarImages.isCheckingEmbeddingStatus === false)
}

test.beforeEach(async ({ page }) => {
  await gotoSimilar(page)
})

// ---------------------------------------------------------------------------
// 1. Public surface — the (unsealed) window.SimilarImages other modules depend on.
// ---------------------------------------------------------------------------

test('window.SimilarImages is an unsealed object + window.initSimilar exposing the load-bearing surface', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const S = (window as any).SimilarImages
    // Public entries + the internal methods a bad cut could drop off the reassembled
    // object. searchByImage is the app/handoffs.js seam; init is the initSimilar() seam.
    const requiredFns = [
      'init', 'bindEvents',
      'getScopeQuery', 'loadScopeOptions', 'onScopeChange', 'getEmbeddingStats',
      'refreshWorkflowStatus', 'refreshContentVisibility', 'updateActionAvailability',
      'setEmbeddingUiState', 'resetEmbeddingUi', 'beginSearchRequest', 'beginDuplicateRequest',
      'renderSearchMessage', 'renderDuplicateMessage', 'formatIssueSummary',
      'renderEmbeddingProgress', 'resumeEmbeddingProgress', 'loadModelStatus', 'loadStats',
      'startEmbedding', 'pollEmbedProgress',
      'searchByImage', 'searchByText', 'searchByUpload', 'handleUploadDrop', 'handleUploadInputChange',
      'findDuplicates', 'renderSearchResults', 'renderDuplicateResults',
      'loadMoreSearchResults', 'loadMoreDuplicateResults',
      '_renderSearchResult', '_renderDuplicatePair', '_previewImage', '_sendToEdit',
      '_openInReader', '_openInBuild', '_addToDataset', '_addToCollection', '_t',
    ]
    const requiredProps = [
      'isEmbedding', 'isCheckingEmbeddingStatus', 'embedProgress', 'modelStatus', 'stats',
      'searchResults', 'duplicateResults', 'searchPageSize', 'duplicatePageSize',
      'currentSearchThreshold', 'currentDuplicateThreshold', 'requestSequence',
      'activeSearchToken', 'activeDuplicateToken', 'collectionId',
    ]
    return {
      isObject: S !== null && typeof S === 'object',
      sealed: Object.isSealed(S),
      identity: (window as any).SimilarImages === S,
      initSimilarIsFn: typeof (window as any).initSimilar === 'function',
      missingFns: requiredFns.filter((k) => typeof S[k] !== 'function'),
      missingProps: requiredProps.filter((k) => !(k in S)),
      searchPageSize: S.searchPageSize,
      duplicatePageSize: S.duplicatePageSize,
      searchThreshold: S.currentSearchThreshold,
      dupThreshold: S.currentDuplicateThreshold,
      requestSequence: S.requestSequence,
      collectionId: S.collectionId,
    }
  })

  expect(probe.isObject).toBe(true)
  // Deliberately NOT sealed: the split reassembles it with Object.assign.
  expect(probe.sealed).toBe(false)
  expect(probe.identity).toBe(true)
  expect(probe.initSimilarIsFn).toBe(true)
  expect(probe.missingFns).toEqual([])
  expect(probe.missingProps).toEqual([])
  // Documented default state (the object-literal initializers).
  expect(probe.searchPageSize).toBe(100)
  expect(probe.duplicatePageSize).toBe(500)
  expect(probe.searchThreshold).toBe(0.5)
  expect(probe.dupThreshold).toBe(0.95)
  expect(probe.requestSequence).toBe(0)
  expect(probe.collectionId).toBeNull()
})

// ---------------------------------------------------------------------------
// 2. getScopeQuery + onScopeChange — the "&collection_id=" scope suffix contract.
// ---------------------------------------------------------------------------

test('getScopeQuery is empty for the whole library and onScopeChange only keeps positive integer ids', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const S = (window as any).SimilarImages
    S.currentSearchMode = null // no active search -> onScopeChange never re-fires one
    S.collectionId = null
    const emptyScope = S.getScopeQuery()
    S.onScopeChange('7')
    const afterSet = { id: S.collectionId, query: S.getScopeQuery() }
    S.onScopeChange('0')
    const afterZero = S.collectionId
    S.onScopeChange('')
    const afterEmpty = S.collectionId
    S.onScopeChange('not-a-number')
    const afterNaN = S.collectionId
    return { emptyScope, afterSet, afterZero, afterEmpty, afterNaN }
  })

  expect(probe.emptyScope).toBe('')
  expect(probe.afterSet.id).toBe(7)
  expect(probe.afterSet.query).toBe('&collection_id=7')
  expect(probe.afterZero).toBeNull()
  expect(probe.afterEmpty).toBeNull()
  expect(probe.afterNaN).toBeNull()
})

// ---------------------------------------------------------------------------
// 3. getEmbeddingStats — normalizes the backend key aliases + computes pending.
// ---------------------------------------------------------------------------

test('getEmbeddingStats reads the embedded_count/embedded_images aliases and derives pending', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const S = (window as any).SimilarImages
    S.stats = { total_images: 100, embedded_count: 40, pending_count: 55, unreadable_count: 5 }
    const explicit = S.getEmbeddingStats()
    // No pending_count -> falls back to max(0, total - embedded); embedded via the
    // legacy embedded_images alias.
    S.stats = { total_images: 100, embedded_images: 30 }
    const aliased = S.getEmbeddingStats()
    S.stats = null
    const empty = S.getEmbeddingStats()
    return { explicit, aliased, empty }
  })

  expect(probe.explicit).toEqual({ total: 100, embedded: 40, pending: 55, unreadable: 5 })
  expect(probe.aliased).toEqual({ total: 100, embedded: 30, pending: 70, unreadable: 0 })
  expect(probe.empty).toEqual({ total: 0, embedded: 0, pending: 0, unreadable: 0 })
})

// ---------------------------------------------------------------------------
// 4. begin*Request — one shared monotonic sequence, two independent active tokens.
// ---------------------------------------------------------------------------

test('beginSearchRequest / beginDuplicateRequest share requestSequence but track separate active tokens', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const S = (window as any).SimilarImages
    S.requestSequence = 0
    S.activeSearchToken = 0
    S.activeDuplicateToken = 0
    const s1 = S.beginSearchRequest()
    const d1 = S.beginDuplicateRequest()
    const s2 = S.beginSearchRequest()
    return {
      s1, d1, s2,
      sequence: S.requestSequence,
      activeSearch: S.activeSearchToken,
      activeDuplicate: S.activeDuplicateToken,
    }
  })

  // Sequence bumps once per call, regardless of which kind.
  expect(probe.s1).toBe(1)
  expect(probe.d1).toBe(2)
  expect(probe.s2).toBe(3)
  expect(probe.sequence).toBe(3)
  // The active tokens hold the LATEST value of their own kind.
  expect(probe.activeSearch).toBe(3)
  expect(probe.activeDuplicate).toBe(2)
})

// ---------------------------------------------------------------------------
// 5. searchByImage — request URL shape + result cards + load-more toggle.
// ---------------------------------------------------------------------------

test('searchByImage issues the paged/threshold/scope URL, renders scored cards + 6 action buttons, toggles load-more', async ({ page }) => {
  const searchUrls: string[] = []
  let searchResponse: unknown = {}
  await page.route('**/api/similarity/search/**', (route) => {
    searchUrls.push(route.request().url())
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(searchResponse) })
  })

  searchResponse = {
    results: [
      { id: 501, filename: 'alpha.png', similarity: 0.9 },
      { id: 502, filename: 'beta.png', similarity: 0.8 },
    ],
    has_more: true,
    total: 2,
  }
  await page.evaluate(() => {
    const S = (window as any).SimilarImages
    S.isEmbedding = false
    S.isCheckingEmbeddingStatus = false
    S.collectionId = null
    return S.searchByImage(42)
  })

  // URL carries the default page size (100), offset 0, the slider threshold (0.5), no scope.
  expect(searchUrls[0]).toMatch(/\/api\/similarity\/search\/42\?limit=100&offset=0&threshold=0\.50?(?:&|$)/)
  expect(searchUrls[0]).not.toContain('collection_id')

  await expect(page.locator('#similar-results .similar-result')).toHaveCount(2)
  await expect(page.locator('#similar-results .similar-result[data-id="501"] .similar-score')).toHaveText('90.0%')
  await expect(page.locator('#similar-results .similar-result[data-id="502"] .similar-score')).toHaveText('80.0%')

  const actions = await page
    .locator('#similar-results .similar-result[data-id="501"] .similar-action-btn')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-action')))
  expect(actions).toEqual(['preview', 'reader', 'edit', 'dataset', 'collection', 'build'])

  // has_more:true -> Load More is shown.
  await expect(page.locator('#btn-similar-load-more')).toBeVisible()

  // Re-run with has_more:false -> Load More hides.
  searchResponse = { results: [{ id: 501, filename: 'alpha.png', similarity: 0.9 }], has_more: false, total: 1 }
  await page.evaluate(() => (window as any).SimilarImages.searchByImage(42))
  await expect(page.locator('#btn-similar-load-more')).toBeHidden()
})

// ---------------------------------------------------------------------------
// 6. activeSearchToken guard — a newer search supersedes an in-flight older one.
// ---------------------------------------------------------------------------

test('a newer image search wins the race and the slower older response is dropped', async ({ page }) => {
  await page.route('**/api/similarity/search/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/search/100')) {
      // Older request resolves LATE.
      await new Promise((resolve) => setTimeout(resolve, 300))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [{ id: 111, filename: 'old.png', similarity: 0.5 }], has_more: false, total: 1 }),
      })
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [{ id: 222, filename: 'new.png', similarity: 0.6 }], has_more: false, total: 1 }),
      })
    }
  })

  await page.evaluate(() => {
    const S = (window as any).SimilarImages
    S.isEmbedding = false
    S.isCheckingEmbeddingStatus = false
    S.searchByImage(100) // token N (slow)
    S.searchByImage(200) // token N+1 (fast) -> becomes activeSearchToken
  })

  // The fast, newer response renders.
  await expect(page.locator('#similar-results .similar-result[data-id="222"]')).toHaveCount(1)
  // After the slow one lands it must NOT overwrite the newer results.
  await page.waitForTimeout(600)
  await expect(page.locator('#similar-results .similar-result[data-id="222"]')).toHaveCount(1)
  await expect(page.locator('#similar-results .similar-result[data-id="111"]')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// 7. searchByText — POST body shape (threshold 0, trimmed query, optional scope).
// ---------------------------------------------------------------------------

test('searchByText posts the trimmed query with threshold 0 and only adds collection_id when scoped', async ({ page }) => {
  let capturedBody: Record<string, unknown> = {}
  await page.route('**/api/similarity/search-text', (route) => {
    capturedBody = JSON.parse(route.request().postData() || '{}')
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: [{ id: 601, filename: 'sem.png', similarity: 0.3 }], has_more: false, total: 1 }),
    })
  })

  // Whole-library: no collection_id, threshold pinned to 0 (the slider does NOT apply
  // to cross-modal text search), query trimmed.
  await page.evaluate(() => {
    const S = (window as any).SimilarImages
    S.isEmbedding = false
    S.isCheckingEmbeddingStatus = false
    S.collectionId = null
    return S.searchByText('  red dress  ')
  })
  expect(capturedBody).toEqual({ query: 'red dress', limit: 100, offset: 0, threshold: 0 })
  await expect(page.locator('#similar-results .similar-result[data-id="601"] .similar-score')).toHaveText('30.0%')

  // Scoped: collection_id is added.
  await page.evaluate(() => {
    const S = (window as any).SimilarImages
    S.collectionId = 7
    return S.searchByText('cat')
  })
  expect(capturedBody).toEqual({ query: 'cat', limit: 100, offset: 0, threshold: 0, collection_id: 7 })
})

// ---------------------------------------------------------------------------
// 8. searchByUpload + handleUploadDrop — upload URL shape + image-only drop gate.
// ---------------------------------------------------------------------------

test('searchByUpload posts to the paged upload URL and handleUploadDrop only searches for image files', async ({ page }) => {
  const uploadUrls: string[] = []
  await page.route('**/api/similarity/search-upload**', (route) => {
    uploadUrls.push(route.request().url())
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: [{ id: 701, filename: 'up.png', similarity: 0.75 }], has_more: false, total: 1 }),
    })
  })

  await page.evaluate(() => {
    const S = (window as any).SimilarImages
    S.isEmbedding = false
    S.isCheckingEmbeddingStatus = false
    S.collectionId = null
    const file = new File([new Uint8Array([1, 2, 3])], 'ref.png', { type: 'image/png' })
    return S.searchByUpload(file)
  })
  expect(uploadUrls[0]).toMatch(/\/api\/similarity\/search-upload\?limit=100&offset=0&threshold=0\.50?(?:&|$)/)
  await expect(page.locator('#similar-results .similar-result[data-id="701"] .similar-score')).toHaveText('75.0%')

  // Dropping a NON-image fires no upload search.
  await page.evaluate(() => {
    const S = (window as any).SimilarImages
    const dt = new DataTransfer()
    dt.items.add(new File(['not an image'], 'notes.txt', { type: 'text/plain' }))
    S.handleUploadDrop({ preventDefault() {}, dataTransfer: dt } as unknown as DragEvent)
  })
  expect(uploadUrls.length).toBe(1)

  // Dropping an image DOES fire an upload search.
  await page.evaluate(() => {
    const S = (window as any).SimilarImages
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([9])], 'pic.png', { type: 'image/png' }))
    S.handleUploadDrop({ preventDefault() {}, dataTransfer: dt } as unknown as DragEvent)
  })
  await expect.poll(() => uploadUrls.length).toBe(2)
})

// ---------------------------------------------------------------------------
// 9. findDuplicates — request shape + renders BOTH the new + legacy pair payloads.
// ---------------------------------------------------------------------------

test('findDuplicates issues the threshold/paged URL and renders both {image_a,image_b} and legacy {id1,id2} pairs', async ({ page }) => {
  const dupUrls: string[] = []
  await page.route('**/api/similarity/duplicates**', (route) => {
    dupUrls.push(route.request().url())
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        duplicates: [
          { id1: 11, filename1: 'x1.png', id2: 12, filename2: 'x2.png', similarity: 0.99 },
          { image_a: { id: 21, filename: 'y1.png' }, image_b: { id: 22, filename: 'y2.png' }, similarity: 0.97 },
        ],
        has_more: false,
        total: 2,
      }),
    })
  })

  await page.evaluate(() => {
    const S = (window as any).SimilarImages
    S.isEmbedding = false
    S.isCheckingEmbeddingStatus = false
    return S.findDuplicates()
  })

  // Default duplicate threshold (0.95) + page size (500) + offset 0.
  expect(dupUrls[0]).toContain('threshold=0.95&limit=500&offset=0')

  await expect(page.locator('#similar-duplicates .duplicate-pair')).toHaveCount(2)
  // Legacy id1/id2 shape.
  await expect(page.locator('#similar-duplicates .dup-image[data-id="11"]')).toHaveCount(1)
  await expect(page.locator('#similar-duplicates .dup-image[data-id="12"]')).toHaveCount(1)
  // New image_a/image_b shape.
  await expect(page.locator('#similar-duplicates .dup-image[data-id="21"]')).toHaveCount(1)
  await expect(page.locator('#similar-duplicates .dup-image[data-id="22"]')).toHaveCount(1)

  const scores = await page
    .locator('#similar-duplicates .dup-score')
    .evaluateAll((els) => els.map((el) => el.textContent))
  expect(scores).toEqual(['99.0%', '97.0%'])
})

// ---------------------------------------------------------------------------
// 10. findDuplicates reason branches — insufficient vs too_many render distinct copy.
// ---------------------------------------------------------------------------

test('findDuplicates renders the reason-specific empty message for insufficient_embeddings vs too_many_embeddings', async ({ page }) => {
  let dupResponse: unknown = {}
  await page.route('**/api/similarity/duplicates**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dupResponse) }))

  dupResponse = { duplicates: [], reason: 'insufficient_embeddings', minimum_required: 2, has_more: false, total: 0 }
  const insufficient = await page.evaluate(async () => {
    const S = (window as any).SimilarImages
    S.isEmbedding = false
    S.isCheckingEmbeddingStatus = false
    await S.findDuplicates()
    return {
      rendered: document.querySelector('#similar-duplicates .empty-state')?.textContent ?? null,
      state: S.duplicateEmptyMessage,
    }
  })

  dupResponse = { duplicates: [], reason: 'too_many_embeddings', max_embeddings: 5000, embedded_count: 99999, has_more: false, total: 0 }
  const tooMany = await page.evaluate(async () => {
    const S = (window as any).SimilarImages
    await S.findDuplicates()
    return {
      rendered: document.querySelector('#similar-duplicates .empty-state')?.textContent ?? null,
      state: S.duplicateEmptyMessage,
    }
  })

  // The rendered empty-state text IS the reason-derived message (not the plain default).
  expect(insufficient.rendered).toBe(insufficient.state)
  expect(tooMany.rendered).toBe(tooMany.state)
  // The two reasons yield distinct, non-empty copy.
  expect(insufficient.state).toBeTruthy()
  expect(tooMany.state).toBeTruthy()
  expect(insufficient.state).not.toBe(tooMany.state)
})

// ---------------------------------------------------------------------------
// 11. searchByImage error branches — "no embedding" warning vs generic failure.
// ---------------------------------------------------------------------------

test('searchByImage shows the raw backend detail for a missing embedding and a generic failure message otherwise', async ({ page }) => {
  let errorResponse: { status: number; body: unknown } = { status: 500, body: {} }
  await page.route('**/api/similarity/search/**', (route) =>
    route.fulfill({ status: errorResponse.status, contentType: 'application/json', body: JSON.stringify(errorResponse.body) }))

  // "has no embedding yet" -> the empty-state shows the exact backend detail.
  errorResponse = { status: 400, body: { detail: 'Image 999 has no embedding yet' } }
  const noEmbedding = await page.evaluate(async () => {
    const S = (window as any).SimilarImages
    S.isEmbedding = false
    S.isCheckingEmbeddingStatus = false
    await S.searchByImage(999)
    return {
      rendered: document.querySelector('#similar-results .empty-state')?.textContent ?? null,
      state: S.searchEmptyMessage,
    }
  })
  expect(noEmbedding.rendered).toBe('Image 999 has no embedding yet')
  expect(noEmbedding.state).toBe('Image 999 has no embedding yet')

  // A generic (500) failure -> the "Search failed: <server message>" empty-state.
  errorResponse = { status: 500, body: {} }
  const generic = await page.evaluate(async () => {
    const S = (window as any).SimilarImages
    await S.searchByImage(5)
    return document.querySelector('#similar-results .empty-state')?.textContent ?? null
  })
  expect(generic).toContain('Server error')
})

// ---------------------------------------------------------------------------
// 12. refreshWorkflowStatus — the setup-state machine drives the workflow card.
// ---------------------------------------------------------------------------

test('refreshWorkflowStatus warns for missing-model + needs-index and marks synced when fully embedded', async ({ page }) => {
  const evalStatus = (available: boolean, total: number, embedded: number, pending: number) =>
    page.evaluate((args) => {
      const S = (window as any).SimilarImages
      S.isEmbedding = false
      S.isCheckingEmbeddingStatus = false
      S.embedProgress = {}
      S.searchResults = []
      S.duplicateResults = []
      S.currentSearchMode = null
      S.modelStatus = { available: args.available }
      S.stats = { total_images: args.total, embedded_count: args.embedded, pending_count: args.pending, unreadable_count: 0 }
      S.refreshWorkflowStatus()
      const card = document.getElementById('similar-workflow-status') as HTMLElement
      const badge = document.getElementById('similar-workflow-badge') as HTMLElement
      const cta = document.getElementById('btn-similar-status-embed') as HTMLButtonElement
      return {
        warning: card.classList.contains('is-warning'),
        synced: card.classList.contains('is-synced'),
        badge: badge.textContent ?? '',
        ctaHidden: cta.hidden,
        ctaDisabled: cta.disabled,
      }
    }, { available, total, embedded, pending })

  // CLIP model missing -> warning, indexing CTA hidden (the banner owns the next action).
  const modelMissing = await evalStatus(false, 10, 0, 10)
  expect(modelMissing.warning).toBe(true)
  expect(modelMissing.ctaHidden).toBe(true)

  // Model ready, nothing embedded yet -> warning + an enabled, visible Start Indexing CTA.
  const needsIndex = await evalStatus(true, 10, 0, 10)
  expect(needsIndex.warning).toBe(true)
  expect(needsIndex.ctaHidden).toBe(false)
  expect(needsIndex.ctaDisabled).toBe(false)

  // Fully embedded -> synced, CTA hidden.
  const ready = await evalStatus(true, 10, 10, 0)
  expect(ready.synced).toBe(true)
  expect(ready.warning).toBe(false)
  expect(ready.ctaHidden).toBe(true)

  // Each state uses a distinct, non-empty badge (locale-agnostic check).
  expect(modelMissing.badge).not.toBe('')
  expect(new Set([modelMissing.badge, needsIndex.badge, ready.badge]).size).toBe(3)
})

// ---------------------------------------------------------------------------
// 13. updateActionAvailability — embedded-count + model gates on the action buttons.
// ---------------------------------------------------------------------------

test('updateActionAvailability gates search on >=1 embedding, duplicates on >=2, and disables all when the model is missing', async ({ page }) => {
  const evalActions = (available: boolean, embedded: number) =>
    page.evaluate((args) => {
      const S = (window as any).SimilarImages
      S.isEmbedding = false
      S.isCheckingEmbeddingStatus = false
      S.modelStatus = { available: args.available }
      S.stats = { total_images: 100, embedded_count: args.embedded, pending_count: 0, unreadable_count: 0 }
      S.updateActionAvailability()
      const btn = (id: string) => document.getElementById(id) as HTMLButtonElement | HTMLInputElement | null
      return {
        search: btn('btn-similar-search')?.disabled,
        searchText: btn('btn-similar-search-text')?.disabled,
        duplicates: btn('btn-similar-duplicates')?.disabled,
        embed: btn('btn-similar-embed')?.disabled,
      }
    }, { available, embedded })

  // 0 embeddings: search + duplicates disabled, but Generate Embeddings stays enabled.
  const none = await evalActions(true, 0)
  expect(none.search).toBe(true)
  expect(none.searchText).toBe(true)
  expect(none.duplicates).toBe(true)
  expect(none.embed).toBe(false)

  // 1 embedding: search enabled, duplicates still disabled (needs >=2).
  const one = await evalActions(true, 1)
  expect(one.search).toBe(false)
  expect(one.duplicates).toBe(true)

  // 2 embeddings: both search and duplicates enabled.
  const two = await evalActions(true, 2)
  expect(two.search).toBe(false)
  expect(two.duplicates).toBe(false)

  // Model missing: everything disabled, including Generate Embeddings.
  const noModel = await evalActions(false, 50)
  expect(noModel.search).toBe(true)
  expect(noModel.duplicates).toBe(true)
  expect(noModel.embed).toBe(true)
})

// ---------------------------------------------------------------------------
// 14. bindEvents wiring — the in-view sub-tab click toggles the search/duplicate panels.
// ---------------------------------------------------------------------------

test('after init, clicking the Duplicates sub-tab toggles panels + active state (bindEvents wiring)', async ({ page }) => {
  await initSimilarView(page)

  const searchTab = page.locator('.similar-tab[data-target="panel-similar-search"]')
  const dupTab = page.locator('.similar-tab[data-target="panel-similar-duplicates"]')

  await dupTab.click()
  await expect(dupTab).toHaveClass(/active/)
  await expect(searchTab).not.toHaveClass(/active/)

  const afterDup = await page.evaluate(() => ({
    duplicates: (document.getElementById('panel-similar-duplicates') as HTMLElement).style.display,
    search: (document.getElementById('panel-similar-search') as HTMLElement).style.display,
  }))
  expect(afterDup.duplicates).toBe('block')
  expect(afterDup.search).toBe('none')

  // Switch back.
  await searchTab.click()
  await expect(searchTab).toHaveClass(/active/)
  const afterSearch = await page.evaluate(() => ({
    duplicates: (document.getElementById('panel-similar-duplicates') as HTMLElement).style.display,
    search: (document.getElementById('panel-similar-search') as HTMLElement).style.display,
  }))
  expect(afterSearch.search).toBe('block')
  expect(afterSearch.duplicates).toBe('none')
})
