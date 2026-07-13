import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Characterization pins for the queue-solitaire.js god-file (1,839 lines) —
 * "step 0" of a possible later decomposition (mirrors the shipped app.js /
 * gallery.js / censor / dataset / manual-sort / autosep / v321 / prompt-lab
 * splits).
 *
 * WHAT IT IS: the "Queue Manager Solitaire" — a multi-section sorting workspace
 * that REPLACES the censor workspace when active. It deals the CENSOR queue
 * (window.__CENSOR_STATE__ / CensorState.queue) from one "Unsorted" pile into
 * named, colour-coded sections (drag/drop, marquee, 1-9 keyboard move, Ctrl+Z
 * undo, Delete→unsorted), auto-sorts by rating/aesthetic/resolution or by saved
 * "auto-sort profiles" (filter-per-section, persisted to localStorage), batch-
 * renames per section, and on close writes the new section order back into
 * CensorState.queue and re-renders the normal queue.
 *
 * STRUCTURE — the headline that drives the split plan: queue-solitaire.js is a
 * single self-contained IIFE `(function(){ 'use strict'; ... })();`. Its `state`
 * object + ~80 functions are CLOSURE-PRIVATE — NOT window globals, NOT the
 * censor-family bare-globals model (censor/*.js are un-wrapped classic scripts
 * sharing one global lexical scope; this file is NOT). Its ENTIRE cross-module
 * contract is ONE publish:
 *       window.QueueSolitaire = { open, close, init, state };   (line 1832)
 * and its ONLY external consumer is censor/queue-render.js:180
 * (`if (window.QueueSolitaire) window.QueueSolitaire.open()`), the Censor view's
 * "Queue Manager" button. `close`/`init`/`state` are exported but externally
 * unused (init self-runs at DOMContentLoaded; close is internal via button +
 * keyboard; state is inspected by tests only).
 *
 * Because every helper is private, these pins CANNOT probe helpers directly (as
 * the autosep window-globals or prompt-lab object-methods pins do). They drive
 * the file THROUGH the 4-member surface: seed the censor queue + AppState.images
 * in-page, call `open()`, poke the exported (mutable) `state` + the real #qs-*
 * DOM / keyboard, then assert on `state` + rendered attributes. They MUST pass
 * before AND after ANY chosen split (single IIFE kept, un-wrapped to classic
 * globals, or ES modules) — they pin OBSERVABLE behavior, not the assembly.
 *
 * NOT duplicated here (already covered, with a seeded DB):
 *   - manual-regression.spec.ts (~1796-1842): open via #btn-open-queue-manager,
 *     quick-filter field counts, advanced toggle, gallery-filter summary, quick
 *     filter → filterMatches, add-section-via-modal → 2 sections, keyboard '2'
 *     move, #qs-btn-done → active gone + queue order synced to #censor-queue-list.
 *   - lazy-human.spec.ts (~152-164): open, quick filter apply → match-count text.
 * The gallery-filter BACKEND selection-token path + the escapeQueueHtml XSS
 * escaping are SOURCE-pinned in test_frontend_contract.py and not re-pinned here.
 *
 * The isolated e2e DB starts empty; the suite storageState seeds
 * aurora-entry-skip=1 so nav lands straight in the app. These pins never need
 * seeded DB rows — they seed the censor queue + AppState.images in the page.
 */

test.describe.configure({ mode: 'serial' })

type QueueSolitaireState = {
  active: boolean
  sections: Array<{ id: string; name: string; color: string; items: number[]; collapsed: boolean }>
  selected: Set<number>
  undoStack: unknown[]
  filterMatches: Set<number>
  appliedFilterMode: string
  autoSortProfiles: Array<{ id: string; name: string; sections: Array<{ id: string; name: string; color: string; filters: unknown }> }>
  detailCache: Map<number, unknown>
}

// The one cross-module surface + the runtime globals it leans on. `App` is the
// sealed app facade; `__CENSOR_STATE__` is the censor queue mirror published on
// localhost by censor/state.js; `renderQueue` is the censor re-render hook
// close() calls.
type QueueSolitaireWin = typeof window & {
  App: any
  QueueSolitaire?: {
    open: () => void
    close: () => void
    init: () => void
    state: QueueSolitaireState
  }
  __CENSOR_STATE__?: { queue: Array<Record<string, unknown>> }
  renderQueue?: () => void
}

/**
 * Boot the app on the isolated empty DB and wait for readiness. Per-test
 * localStorage seeds (the auto-sort-profiles pin) register before navigation via
 * addInitScript. Readiness = app boot flag + window.QueueSolitaire present (its
 * script tag parses at load) + the censor-state mirror present + App.switchView.
 */
async function bootApp(page: Page, seeds?: Record<string, string>): Promise<void> {
  if (seeds) {
    await page.addInitScript((entries: Record<string, string>) => {
      for (const [key, value] of Object.entries(entries)) {
        localStorage.setItem(key, value)
      }
    }, seeds)
  }
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => {
    const w = window as QueueSolitaireWin
    return (
      document.documentElement.dataset.appReady === '1' &&
      !!w.QueueSolitaire &&
      typeof w.QueueSolitaire.open === 'function' &&
      typeof w.App?.switchView === 'function' &&
      !!w.__CENSOR_STATE__
    )
  })
}

type SeedImage = Record<string, unknown> & { id: number }

/**
 * Seed the censor queue (the pile open() deals from) + AppState.images (where
 * getImageMeta reads width/height/aesthetic_score/generator for auto-sort and
 * filtering). Both are runtime objects, seeded after boot via evaluate. Returns
 * the seeded image count so a caller can assert the seed actually stuck (AppState
 * is a plain mutable object; the app reassigns AppState.images on every load).
 */
async function seedQueue(page: Page, queueIds: number[], images: SeedImage[]): Promise<number> {
  return page.evaluate(
    ({ ids, imgs }) => {
      const w = window as QueueSolitaireWin
      w.__CENSOR_STATE__!.queue = ids.map((id) => ({ id, originalFilename: `img-${id}.png` }))
      w.App.AppState.images = imgs
      return (w.App.AppState.images as unknown[]).length
    },
    { ids: queueIds, imgs: images },
  )
}

async function openSolitaire(page: Page): Promise<void> {
  await page.evaluate(() => (window as QueueSolitaireWin).QueueSolitaire!.open())
}

// ---------------------------------------------------------------------------
// 1. The ENTIRE cross-module surface: window.QueueSolitaire = { open, close,
//    init, state }. censor/queue-render.js:180 depends on `.open`; a split must
//    keep exactly this object shape + the initial `state` field types. Unlike
//    autosep (function-decl globals) and prompt-lab (object methods), NOTHING
//    else escapes the IIFE, so this is the whole pin surface for the file.
// ---------------------------------------------------------------------------

test('queue-solitaire.js publishes exactly { open, close, init, state } with a typed initial state', async ({ page }) => {
  await bootApp(page)
  const probe = await page.evaluate(() => {
    const qs = (window as QueueSolitaireWin).QueueSolitaire as QueueSolitaireWin['QueueSolitaire']
    if (!qs) return null
    const s = qs.state
    return {
      keys: Object.keys(qs).sort(),
      open: typeof qs.open,
      close: typeof qs.close,
      init: typeof qs.init,
      stateIsObject: !!s && typeof s === 'object',
      stateIdentityStable: qs.state === qs.state,
      active: s.active,
      sectionsArray: Array.isArray(s.sections),
      selectedIsSet: s.selected instanceof Set,
      undoIsArray: Array.isArray(s.undoStack),
      filterMatchesIsSet: s.filterMatches instanceof Set,
      appliedFilterMode: s.appliedFilterMode,
      autoSortProfilesArray: Array.isArray(s.autoSortProfiles),
      detailCacheIsMap: s.detailCache instanceof Map,
    }
  })

  // The export object is EXACTLY these four members (queue-render.js reads .open).
  expect(probe).not.toBeNull()
  expect(probe!.keys).toEqual(['close', 'init', 'open', 'state'])
  expect(probe!.open).toBe('function')
  expect(probe!.close).toBe('function')
  expect(probe!.init).toBe('function')
  // Initial state shape a split must preserve (before any open()).
  expect(probe!.stateIsObject).toBe(true)
  expect(probe!.active).toBe(false)
  expect(probe!.sectionsArray).toBe(true)
  expect(probe!.selectedIsSet).toBe(true)
  expect(probe!.undoIsArray).toBe(true)
  expect(probe!.filterMatchesIsSet).toBe(true)
  expect(probe!.appliedFilterMode).toBe('none')
  expect(probe!.autoSortProfilesArray).toBe(true)
  expect(probe!.detailCacheIsMap).toBe(true)
})

// ---------------------------------------------------------------------------
// 2. open() deals the whole censor queue into ONE 'unsorted' section, resets the
//    session state, and activates the solitaire DOM (hiding the censor
//    workspace). This is the entry contract queue-render.js triggers.
// ---------------------------------------------------------------------------

test('open() seeds a single Unsorted section from CensorState.queue and activates the DOM', async ({ page }) => {
  await bootApp(page)
  await seedQueue(page, [11, 22, 33], [])
  await openSolitaire(page)

  const probe = await page.evaluate(() => {
    const qs = (window as QueueSolitaireWin).QueueSolitaire!
    const s = qs.state
    const sectionEl = document.getElementById('queue-solitaire')
    const filterBar = document.getElementById('qs-filter-bar')
    // .every on an empty NodeList is true, so this is meaningful iff the censor
    // workspace nodes exist, and harmless otherwise.
    const censorChildrenHidden = Array.from(
      document.querySelectorAll<HTMLElement>('.censor-sidebar-v2, .censor-main-v2'),
    ).every((el) => el.style.display === 'none')
    return {
      sectionCount: s.sections.length,
      firstId: s.sections[0]?.id,
      firstName: s.sections[0]?.name,
      firstColor: s.sections[0]?.color,
      firstItems: s.sections[0]?.items,
      active: s.active,
      appliedFilterMode: s.appliedFilterMode,
      selectedSize: s.selected.size,
      undoLength: s.undoStack.length,
      domActive: !!sectionEl?.classList.contains('active'),
      filterBarActive: !!filterBar?.classList.contains('active'),
      filterBarDisplay: filterBar?.style.display,
      censorChildrenHidden,
    }
  })

  expect(probe.sectionCount).toBe(1)
  expect(probe.firstId).toBe('unsorted')
  expect(probe.firstName).toBe('Unsorted')
  expect(probe.firstColor).toBe('gray')
  expect(probe.firstItems).toEqual([11, 22, 33])
  expect(probe.active).toBe(true)
  expect(probe.appliedFilterMode).toBe('none')
  expect(probe.selectedSize).toBe(0)
  expect(probe.undoLength).toBe(0)
  expect(probe.domActive).toBe(true)
  expect(probe.filterBarActive).toBe(true)
  expect(probe.filterBarDisplay).toBe('flex')
  expect(probe.censorChildrenHidden).toBe(true)
})

// ---------------------------------------------------------------------------
// 3. Auto-sort by RESOLUTION partitions on max(width,height): >=1920 → HD (gold),
//    else → SD (blue), 0 → Unknown (reuses the 'unsorted' section id). Pure
//    getImageMeta bucketing a split most endangers (helper moves file).
// ---------------------------------------------------------------------------

test('auto-sort by resolution buckets HD / SD / Unknown from AppState.images', async ({ page }) => {
  await bootApp(page)
  const seeded = await seedQueue(page, [1, 2, 3, 4], [
    { id: 1, width: 2000, height: 1000 }, // max 2000 >= 1920 → HD
    { id: 2, width: 1000, height: 1000 }, // max 1000 → SD
    { id: 3, width: 0, height: 0 },       // max 0 → Unknown
    { id: 4, width: 1920, height: 100 },  // max 1920 >= 1920 → HD
  ])
  expect(seeded).toBe(4) // AppState.images seed stuck
  await openSolitaire(page)
  await page.evaluate(() => document.getElementById('qs-sort-resolution')?.click())

  const sections = await page.evaluate(() =>
    (window as QueueSolitaireWin).QueueSolitaire!.state.sections.map((s) => ({
      id: s.id,
      color: s.color,
      items: s.items,
    })),
  )

  expect(sections.length).toBe(3)
  expect(sections[0].color).toBe('gold') // HD
  expect(sections[0].items).toEqual([1, 4])
  expect(sections[1].color).toBe('blue') // SD
  expect(sections[1].items).toEqual([2])
  expect(sections[2].id).toBe('unsorted') // Unknown reuses the unsorted id
  expect(sections[2].color).toBe('gray')
  expect(sections[2].items).toEqual([3])
})

// ---------------------------------------------------------------------------
// 4. Auto-sort by AESTHETIC partitions on aesthetic_score: >=7 Great (gold),
//    >=5 Good (green), <5 Low (red), null/absent → Unscored (reuses 'unsorted').
// ---------------------------------------------------------------------------

test('auto-sort by aesthetic buckets Great / Good / Low / Unscored', async ({ page }) => {
  await bootApp(page)
  await seedQueue(page, [1, 2, 3, 4], [
    { id: 1, aesthetic_score: 8.2 }, // >= 7 Great
    { id: 2, aesthetic_score: 6.0 }, // >= 5 Good
    { id: 3, aesthetic_score: 3.0 }, // < 5 Low
    { id: 4 },                       // no score → Unscored
  ])
  await openSolitaire(page)
  await page.evaluate(() => document.getElementById('qs-sort-aesthetic')?.click())

  const sections = await page.evaluate(() =>
    (window as QueueSolitaireWin).QueueSolitaire!.state.sections.map((s) => ({
      id: s.id,
      color: s.color,
      items: s.items,
    })),
  )

  expect(sections.length).toBe(4)
  expect(sections[0].color).toBe('gold') // Great
  expect(sections[0].items).toEqual([1])
  expect(sections[1].color).toBe('green') // Good
  expect(sections[1].items).toEqual([2])
  expect(sections[2].color).toBe('red') // Low
  expect(sections[2].items).toEqual([3])
  expect(sections[3].id).toBe('unsorted') // Unscored reuses the unsorted id
  expect(sections[3].color).toBe('gray')
  expect(sections[3].items).toEqual([4])
})

// ---------------------------------------------------------------------------
// 5. Auto-sort PROFILES load from localStorage (queue_solitaire_auto_sort_
//    profiles_v1) with normalization: an out-of-range section color falls back
//    to the SECTION_COLORS palette (bad → 'gray' at index 0), a VALID color is
//    preserved, a missing profile/section name gets a default, and the profile
//    menu renders one button per profile. The persistence + normalize seam.
// ---------------------------------------------------------------------------

test('auto-sort profiles load + normalize from localStorage and render one button per profile', async ({ page }) => {
  await bootApp(page, {
    queue_solitaire_auto_sort_profiles_v1: JSON.stringify([
      {
        id: 'p1',
        // name intentionally omitted → default; s1 bad color → fallback, s2 valid → preserved
        sections: [
          { id: 's1', color: 'bogus-color', filters: {} },
          { id: 's2', color: 'blue', filters: {} },
        ],
      },
    ]),
  })
  await openSolitaire(page)

  const probe = await page.evaluate(() => {
    const qs = (window as QueueSolitaireWin).QueueSolitaire!
    const p = qs.state.autoSortProfiles
    const menu = document.getElementById('qs-auto-sort-profiles')
    return {
      count: p.length,
      nameNonEmpty: typeof p[0]?.name === 'string' && p[0].name.length > 0,
      s0Color: p[0]?.sections?.[0]?.color,
      s1Color: p[0]?.sections?.[1]?.color,
      s0NameNonEmpty: typeof p[0]?.sections?.[0]?.name === 'string' && p[0].sections[0].name.length > 0,
      buttonCount: menu ? menu.querySelectorAll('.qs-auto-sort-profile-btn').length : -1,
    }
  })

  expect(probe.count).toBe(1)
  expect(probe.nameNonEmpty).toBe(true) // missing profile name → default
  expect(probe.s0Color).toBe('gray') // bad color → SECTION_COLORS[0]
  expect(probe.s1Color).toBe('blue') // valid color preserved
  expect(probe.s0NameNonEmpty).toBe(true) // missing section name → default
  expect(probe.buttonCount).toBe(1) // one profile button rendered
})

// ---------------------------------------------------------------------------
// 6. Keyboard: Delete moves the selection to the 'unsorted' section (via
//    moveItems + a pushUndo snapshot), and Ctrl+Z restores the prior section
//    layout from the undo stack. The undo journal is otherwise unpinned.
//    (manual-regression pins the '1-9' move; this pins Delete + Ctrl+Z undo.)
// ---------------------------------------------------------------------------

test('Delete moves selection to Unsorted and Ctrl+Z restores the prior layout', async ({ page }) => {
  await bootApp(page)
  await seedQueue(page, [1, 2], [])
  await openSolitaire(page)

  // Arrange a 2-section layout with image 1 selected in the non-unsorted section.
  // `state` is the exported, mutable object the module reads internally.
  await page.evaluate(() => {
    const s = (window as QueueSolitaireWin).QueueSolitaire!.state
    s.sections = [
      { id: 'sec-a', name: 'A', color: 'gold', items: [1, 2], collapsed: false },
      { id: 'unsorted', name: 'Unsorted', color: 'gray', items: [], collapsed: false },
    ]
    s.selected = new Set([1])
  })

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })),
  )
  const afterDelete = await page.evaluate(() => {
    const s = (window as QueueSolitaireWin).QueueSolitaire!.state
    return { a: s.sections[0].items, unsorted: s.sections[1].items, selected: s.selected.size, undo: s.undoStack.length }
  })
  expect(afterDelete.a).toEqual([2])
  expect(afterDelete.unsorted).toEqual([1])
  expect(afterDelete.selected).toBe(0)
  expect(afterDelete.undo).toBe(1)

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })),
  )
  const afterUndo = await page.evaluate(() => {
    const s = (window as QueueSolitaireWin).QueueSolitaire!.state
    return { a: s.sections[0].items, unsorted: s.sections[1].items }
  })
  expect(afterUndo.a).toEqual([1, 2]) // layout restored from the snapshot
  expect(afterUndo.unsorted).toEqual([])
})

// ---------------------------------------------------------------------------
// 7. close() writes the flattened section order back into CensorState.queue
//    (mapping ids → the original queue items), deactivates the solitaire DOM,
//    and fires the censor renderQueue re-render hook. This round-trip is the
//    whole point of the workspace; manual-regression pins the downstream DOM,
//    this pins the direct CensorState.queue contract.
// ---------------------------------------------------------------------------

test('close() flattens section order back into CensorState.queue and re-renders', async ({ page }) => {
  await bootApp(page)
  await seedQueue(page, [1, 2, 3], [])
  await openSolitaire(page)

  const probe = await page.evaluate(() => {
    const w = window as QueueSolitaireWin
    const qs = w.QueueSolitaire!
    // Simulate the user having moved items across two sections.
    qs.state.sections = [
      { id: 'sec-a', name: 'A', color: 'gold', items: [3, 1], collapsed: false },
      { id: 'unsorted', name: 'Unsorted', color: 'gray', items: [2], collapsed: false },
    ]
    // Spy on the censor re-render hook close() calls.
    let renderCalled = false
    const orig = w.renderQueue
    w.renderQueue = () => {
      renderCalled = true
    }
    qs.close()
    w.renderQueue = orig
    const sectionEl = document.getElementById('queue-solitaire')
    return {
      queueOrder: (w.__CENSOR_STATE__!.queue as Array<{ id: number }>).map((q) => q.id),
      active: qs.state.active,
      domActive: !!sectionEl?.classList.contains('active'),
      renderCalled,
    }
  })

  expect(probe.queueOrder).toEqual([3, 1, 2]) // flatMap(sections → items), items re-mapped by id
  expect(probe.active).toBe(false)
  expect(probe.domActive).toBe(false)
  expect(probe.renderCalled).toBe(true)
})

// ---------------------------------------------------------------------------
// 8. Filter summary i18n guard: with no queue filters the summary carries the
//    data-i18n idle key (so I18n.applyToDOM keeps localizing it); once a quick
//    filter is applied the summary text is written and its data-i18n is STRIPPED
//    so a later languageChanged can't reset the live summary. Mirrors autosep's
//    summary data-i18n strip. (The match COUNT is covered by lazy-human /
//    manual-regression; this pins only the synchronous summary/mode transition.)
// ---------------------------------------------------------------------------

test('filter summary keeps the idle data-i18n key, then strips it once a quick filter is applied', async ({ page }) => {
  await bootApp(page)
  await seedQueue(page, [1, 2], [
    { id: 1, generator: 'comfyui' },
    { id: 2, generator: 'nai' },
  ])
  await openSolitaire(page)

  const idle = await page.evaluate(() => {
    const el = document.getElementById('qs-filter-summary')
    return { i18n: el?.getAttribute('data-i18n'), hasText: (el?.textContent || '').trim().length > 0 }
  })
  expect(idle.i18n).toBe('queueSolitaire.filterSummaryIdle') // idle keeps the i18n key
  expect(idle.hasText).toBe(true)

  // Type a quick keyword and apply (programmatic click fires the bound handler;
  // the summary/mode transition runs synchronously before the async match scan).
  await page.evaluate(() => {
    const input = document.getElementById('qs-filter-tag') as HTMLInputElement | null
    if (input) input.value = 'comfyui'
    document.getElementById('qs-filter-apply')?.click()
  })

  await expect
    .poll(async () =>
      page.evaluate(() => (window as QueueSolitaireWin).QueueSolitaire!.state.appliedFilterMode),
    )
    .toBe('quick')

  const applied = await page.evaluate(() => {
    const el = document.getElementById('qs-filter-summary')
    return {
      i18n: el?.getAttribute('data-i18n'),
      text: (el?.textContent || '').toLowerCase(),
    }
  })
  expect(applied.i18n).toBeNull() // data-i18n stripped so I18n can't reset the live summary
  expect(applied.text).toContain('comfyui') // the active quick keyword is reflected
})
