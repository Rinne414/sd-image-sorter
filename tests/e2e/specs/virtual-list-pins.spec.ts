import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Characterization pins for frontend/js/modules/components/virtual-list.js
 * (1,123 lines) — "step 0" of a later VERBATIM decomposition, mirroring the
 * shipped censor-edit / dataset-maker / gallery.js splits.
 *
 * SHAPE (verified): the file is NOT an IIFE. It declares two top-level CLASSES
 * as classic-script globals — `VirtualList` (lines 15-823) and
 * `WaterfallVirtualList extends VirtualList` (829-1113) — with no `'use strict'`
 * (sloppy mode). It loads at index.html:7045, BEFORE lang/i18n/guide/stores/app/
 * gallery; its only external touch is a call-time `window.Logger` guard (line
 * 761). The tail (1116-1123) dual-publishes both classes on `window` AND via
 * CommonJS `module.exports`. The `extends` chain is TDZ-sensitive: the base
 * class MUST load before the subclass, and the export tail needs both in scope.
 *
 * The split therefore has three invariants this spec locks so it is provably
 * zero-behavior-change (MUST pass before AND after the refactor):
 *   1. Published surface: both constructors on `window`, the subclass chain,
 *      `VirtualList.DEFAULT_CONFIG`, and the public prototype method set.
 *   2. Component contract: threshold decision, DOM recycling, absolute-position
 *      layout math, key lookup, append, reconfigure, update/toggle, destroy.
 *   3. Waterfall masonry: shortest-column assignment + aspect-ratio clamp.
 *   4. Real-app wiring: the gallery grid actually routes into these classes.
 *
 * Scope note — deliberately AVOIDS what neighbors already cover:
 *   - thumbnail-size / sidebar-collapse reflow -> gallery-thumb-size-reflow.spec.ts
 *   - gallery public surface / prompt conversion -> gallery-core-pins.spec.ts
 *
 * Seeding is 100% in-page (no DB writes): direct-instance pins build their own
 * detached scroll container; real-app pins use `Gallery.setImages([...])`. This
 * dodges the `.tmp/e2e-data-<port>` cross-run pollution pitfall entirely.
 *
 * Desktop-only project: viewport pinned at 1440x900.
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 900 } })

type VlWindow = {
  VirtualList: any
  WaterfallVirtualList: any
  App: any
  Gallery: any
  __vlHarness: any
  __vl: any
  __vlScroll: any
}

/**
 * Installs an in-page factory that builds a live VirtualList/WaterfallVirtualList
 * against a detached, fixed-size scroll container. `overflow-y:scroll` keeps the
 * scrollbar (and thus clientWidth) stable so column math is deterministic. Reads
 * window.VirtualList lazily at make()-time, after the app scripts have loaded.
 */
function installVlHarness(): void {
  const w = window as unknown as VlWindow
  w.__vlHarness = {
    make(kind: string, items: any[], options: any = {}) {
      const scrollContainer = document.createElement('div')
      scrollContainer.setAttribute('data-vl-harness', 'scroll')
      scrollContainer.style.cssText = 'position:relative;width:400px;height:300px;overflow-y:scroll;'
      const container = document.createElement('div')
      scrollContainer.appendChild(container)
      document.body.appendChild(scrollContainer)

      const Cls = kind === 'waterfall' ? w.WaterfallVirtualList : w.VirtualList
      const base: any = {
        container,
        scrollContainer,
        renderItem: (index: number, data: any) => {
          const el = document.createElement('div')
          el.className = 'vl-item'
          el.dataset.pinIndex = String(index)
          el.dataset.pinId = String(data.id)
          el.title = data.title || ''
          return el
        },
        getItemKey: (index: number, data: any) => data.id,
      }
      const vl = new Cls(Object.assign(base, options))
      vl.init(items)
      w.__vl = vl
      w.__vlScroll = scrollContainer
      return vl
    },
    teardown() {
      try {
        if (w.__vl) w.__vl.destroy()
      } catch (e) {
        /* ignore */
      }
      if (w.__vlScroll) w.__vlScroll.remove()
      w.__vl = null
      w.__vlScroll = null
    },
  }
}

/** Deterministic grid config: 3-4 columns of 100px squares, tiny buffer so a
 *  large list clearly renders only a subset (recycling is observable). */
const GRID_CONFIG = {
  threshold: 10,
  bufferSize: 2,
  minColumnWidth: 100,
  columnGap: 0,
  rowGap: 0,
  estimatedItemHeight: 100,
  itemAspectRatio: 1,
  scrollThrottle: 0,
}

async function gotoApp(page: Page): Promise<void> {
  await page.addInitScript(installVlHarness)
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => {
    const w = window as unknown as VlWindow
    return typeof w.VirtualList === 'function'
      && typeof w.WaterfallVirtualList === 'function'
      && Boolean(w.__vlHarness)
  })
}

/** Full gallery boot (for the real-app wiring pins) — mirrors gallery-core-pins:
 *  wait for a settled boot, then land on the gallery view. */
async function activateGallery(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    typeof (window as unknown as VlWindow).Gallery?.setImages === 'function'
    && typeof (window as unknown as VlWindow).App?.switchView === 'function'
    && (window as unknown as VlWindow).App?.AppState?.isLoading === false)
  const loadSettled = page
    .waitForResponse((r) => r.url().includes('/api/images'), { timeout: 15000 })
    .catch(() => null)
  await page.evaluate(() => (window as unknown as VlWindow).App.switchView('gallery'))
  await Promise.race([loadSettled, page.waitForTimeout(1500)])
  await page.waitForFunction(() => (window as unknown as VlWindow).App?.AppState?.isLoading === false)
}

/** Seed `count` synthetic cards into the real gallery grid in `viewMode`. */
async function seedGallery(page: Page, count: number, viewMode: string): Promise<void> {
  await page.evaluate(({ n, mode }) => {
    const w = window as unknown as VlWindow
    const imgs = Array.from({ length: n }, (_v, i) => ({
      id: 6000 + i,
      filename: `vlpin-${6000 + i}.png`,
      generator: 'webui',
      width: 512,
      height: 512,
      file_size: 1000 + i,
    }))
    w.App.AppState.viewMode = mode
    w.App.AppState.images = imgs
    w.Gallery.setImages(imgs)
  }, { n: count, mode: viewMode })
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page)
})

// ---------------------------------------------------------------------------
// 1. Published surface: dual-class globals, subclass chain, static config,
//    public prototype method set. Locks exactly what the export tail + the
//    TDZ-sensitive `extends` ordering must reproduce after a split.
// ---------------------------------------------------------------------------
test('published surface: both classes, subclass chain, DEFAULT_CONFIG, prototype methods', async ({ page }) => {
  const surface = await page.evaluate(() => {
    const w = window as unknown as VlWindow
    const VL = w.VirtualList
    const WF = w.WaterfallVirtualList
    return {
      vlIsFn: typeof VL === 'function',
      wfIsFn: typeof WF === 'function',
      // extends chain (byte-fragile under a bad split order).
      wfProtoIsVl: Object.getPrototypeOf(WF) === VL,
      wfInstanceofVl: WF.prototype instanceof VL,
      defaultConfig: VL.DEFAULT_CONFIG,
      methods: [
        'init', 'setItems', 'appendItems', 'reconfigure', 'updateConfig',
        'refresh', 'destroy', 'scrollToItem', 'getItemAtScrollPosition',
        'getLayoutForIndex', 'getLayoutForKey', 'getIndexForKey',
        'getRenderedCount', 'isVirtual', 'updateItem', 'toggleItemClass',
      ].map((name) => typeof VL.prototype[name] === 'function'),
      // Waterfall overrides that must stay on the subclass.
      wfOwnRecalc: Object.prototype.hasOwnProperty.call(WF.prototype, '_recalculateLayout'),
      wfOwnUpdate: Object.prototype.hasOwnProperty.call(WF.prototype, '_updateVisibleItems'),
    }
  })

  expect(surface.vlIsFn).toBe(true)
  expect(surface.wfIsFn).toBe(true)
  expect(surface.wfProtoIsVl).toBe(true)
  expect(surface.wfInstanceofVl).toBe(true)
  expect(surface.methods.every(Boolean)).toBe(true)
  expect(surface.wfOwnRecalc).toBe(true)
  expect(surface.wfOwnUpdate).toBe(true)
  // Documented default configuration shape.
  expect(surface.defaultConfig).toMatchObject({
    bufferSize: 10,
    threshold: 240,
    forceVirtual: false,
    estimatedItemHeight: 200,
    itemAspectRatio: 1,
    rowGap: 16,
    columnGap: 16,
    minColumnWidth: 200,
    scrollThrottle: 'raf',
  })
})

// ---------------------------------------------------------------------------
// 2. Below threshold -> non-virtual fallback: renders EVERY item, strips the
//    virtual-scroll class, and leaves items in normal flow (no absolute pos).
// ---------------------------------------------------------------------------
test('below threshold renders all items in non-virtual fallback', async ({ page }) => {
  const result = await page.evaluate((config) => {
    const w = window as unknown as VlWindow
    const items = Array.from({ length: 5 }, (_v, i) => ({ id: 100 + i }))
    const vl = w.__vlHarness.make('grid', items, { config })
    const container = w.__vlScroll.firstElementChild as HTMLElement
    const rendered = Array.from(container.querySelectorAll('.vl-item')) as HTMLElement[]
    const out = {
      isVirtual: vl.isVirtual(),
      hasVirtualClass: container.classList.contains('virtual-scroll'),
      renderedCount: rendered.length,
      indices: rendered.map((el) => Number(el.dataset.pinIndex)),
      anyAbsolute: rendered.some((el) => el.style.position === 'absolute'),
    }
    w.__vlHarness.teardown()
    return out
  }, GRID_CONFIG)

  expect(result.isVirtual).toBe(false)
  expect(result.hasVirtualClass).toBe(false)
  expect(result.renderedCount).toBe(5)
  expect(result.indices).toEqual([0, 1, 2, 3, 4])
  expect(result.anyAbsolute).toBe(false)
})

// ---------------------------------------------------------------------------
// 3. Above threshold -> virtual scrolling: only a viewport+buffer SUBSET is in
//    the DOM (recycling), items are absolutely positioned, onItemsRendered
//    fires, and scrolling shifts the rendered window forward (recycle path).
// ---------------------------------------------------------------------------
test('above threshold recycles the DOM, positions absolutely, and shifts on scroll', async ({ page }) => {
  const result = await page.evaluate((config) => {
    const w = window as unknown as VlWindow
    const items = Array.from({ length: 500 }, (_v, i) => ({ id: 100 + i }))
    let renderedCallbackTotal = 0
    const vl = w.__vlHarness.make('grid', items, {
      config,
      onItemsRendered: (els: HTMLElement[]) => { renderedCallbackTotal += els.length },
    })
    const container = w.__vlScroll.firstElementChild as HTMLElement

    const readIndices = () =>
      (Array.from(container.querySelectorAll('.vl-item')) as HTMLElement[])
        .map((el) => Number(el.dataset.pinIndex))

    const initialIndices = readIndices()
    const sample = container.querySelector('.vl-item') as HTMLElement
    const initial = {
      isVirtual: vl.isVirtual(),
      hasVirtualClass: container.classList.contains('virtual-scroll'),
      containerPosition: container.style.position,
      minHeightPx: parseFloat(container.style.minHeight) || 0,
      renderedCount: initialIndices.length,
      total: items.length,
      renderedCountApi: vl.getRenderedCount(),
      callbackTotal: renderedCallbackTotal,
      sampleAbsolute: sample?.style.position === 'absolute',
      sampleHasGeometry: Boolean(sample && sample.style.top !== '' && sample.style.width !== ''),
      sampleHasVirtualIndex: sample?.dataset.virtualIndex !== undefined,
      minIndex: Math.min(...initialIndices),
    }

    // Scroll far down and fire the listener (scrollThrottle:0 -> synchronous).
    w.__vlScroll.scrollTop = 6000
    w.__vlScroll.dispatchEvent(new Event('scroll'))
    const scrolledIndices = readIndices()
    const scrolled = {
      minIndex: Math.min(...scrolledIndices),
      renderedCount: scrolledIndices.length,
    }

    w.__vlHarness.teardown()
    return { initial, scrolled }
  }, GRID_CONFIG)

  // Virtual mode engaged with the container set up for absolute children.
  expect(result.initial.isVirtual).toBe(true)
  expect(result.initial.hasVirtualClass).toBe(true)
  expect(result.initial.containerPosition).toBe('relative')
  expect(result.initial.minHeightPx).toBeGreaterThan(1000)
  // Recycling: far fewer than 500 nodes exist, but the window is non-empty.
  expect(result.initial.renderedCount).toBeGreaterThan(0)
  expect(result.initial.renderedCount).toBeLessThan(120)
  expect(result.initial.renderedCountApi).toBe(result.initial.renderedCount)
  expect(result.initial.callbackTotal).toBe(result.initial.renderedCount)
  // Absolute positioning + virtual index stamping.
  expect(result.initial.sampleAbsolute).toBe(true)
  expect(result.initial.sampleHasGeometry).toBe(true)
  expect(result.initial.sampleHasVirtualIndex).toBe(true)
  expect(result.initial.minIndex).toBe(0)
  // After scrolling far down, the rendered window moved forward.
  expect(result.scrolled.minIndex).toBeGreaterThan(result.initial.minIndex)
  expect(result.scrolled.renderedCount).toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// 4. Grid layout math: row/col mapping, scrollToItem, getItemAtScrollPosition.
//    Asserted against the instance's OWN reported columns/dimensions so it is
//    independent of the exact pixel width the scrollbar leaves.
// ---------------------------------------------------------------------------
test('grid layout math maps index<->row/col and drives scrollToItem', async ({ page }) => {
  const result = await page.evaluate((config) => {
    const w = window as unknown as VlWindow
    const items = Array.from({ length: 200 }, (_v, i) => ({ id: 100 + i }))
    const vl = w.__vlHarness.make('grid', items, { config })

    const columns = vl.columns
    const rowStride = vl.itemHeight + vl.config.rowGap
    const colStride = vl.itemWidth + vl.config.columnGap

    const first = vl.getLayoutForIndex(0)
    const secondCol = vl.getLayoutForIndex(1)
    const secondRow = vl.getLayoutForIndex(columns)

    // scrollToItem sets scrollTop to that item's layout top.
    const targetIndex = columns * 4
    vl.scrollToItem(targetIndex)
    const scrollTopAfter = w.__vlScroll.scrollTop
    const targetTop = vl.getLayoutForIndex(targetIndex).top

    // getItemAtScrollPosition maps a scroll offset back to the row's first idx.
    const atRow3 = vl.getItemAtScrollPosition(rowStride * 3)

    const out = {
      columns,
      firstTop: first.top,
      firstLeft: first.left,
      firstRowCol: [first.row, first.col],
      secondColLeft: secondCol.left,
      secondColRowCol: [secondCol.row, secondCol.col],
      secondRowTop: secondRow.top,
      secondRowRowCol: [secondRow.row, secondRow.col],
      colStride,
      rowStride,
      scrollMatches: Math.abs(scrollTopAfter - targetTop) < 0.5,
      atRow3,
      expectedAtRow3: 3 * columns,
    }
    w.__vlHarness.teardown()
    return out
  }, GRID_CONFIG)

  expect(result.columns).toBeGreaterThan(1)
  expect(result.firstTop).toBe(0)
  expect(result.firstLeft).toBe(0)
  expect(result.firstRowCol).toEqual([0, 0])
  // index 1 -> row 0, col 1 (one column stride to the right).
  expect(result.secondColRowCol).toEqual([0, 1])
  expect(result.secondColLeft).toBeCloseTo(result.colStride, 1)
  // index === columns -> row 1, col 0 (one row stride down).
  expect(result.secondRowRowCol).toEqual([1, 0])
  expect(result.secondRowTop).toBeCloseTo(result.rowStride, 1)
  expect(result.scrollMatches).toBe(true)
  expect(result.atRow3).toBe(result.expectedAtRow3)
})

// ---------------------------------------------------------------------------
// 5. Key lookup: getIndexForKey / getLayoutForKey resolve via the configured
//    getItemKey, and miss cleanly (-1 / null).
// ---------------------------------------------------------------------------
test('key lookup resolves index and layout, misses cleanly', async ({ page }) => {
  const result = await page.evaluate((config) => {
    const w = window as unknown as VlWindow
    const items = Array.from({ length: 50 }, (_v, i) => ({ id: 100 + i }))
    const vl = w.__vlHarness.make('grid', items, { config })

    const idxForKey = vl.getIndexForKey(103)
    const layoutForKey = vl.getLayoutForKey(103)
    const layoutForIndex = vl.getLayoutForIndex(3)
    const out = {
      idxForKey,
      keyLayoutMatchesIndexLayout:
        layoutForKey && layoutForIndex
        && layoutForKey.top === layoutForIndex.top
        && layoutForKey.left === layoutForIndex.left,
      missIndex: vl.getIndexForKey(999999),
      missLayout: vl.getLayoutForKey(999999),
    }
    w.__vlHarness.teardown()
    return out
  }, GRID_CONFIG)

  expect(result.idxForKey).toBe(3)
  expect(result.keyLayoutMatchesIndexLayout).toBe(true)
  expect(result.missIndex).toBe(-1)
  expect(result.missLayout).toBeNull()
})

// ---------------------------------------------------------------------------
// 6. appendItems: grows a virtual list (more content, still recycling) AND
//    promotes a below-threshold list into virtual mode when it crosses over.
// ---------------------------------------------------------------------------
test('appendItems grows virtual content and promotes across the threshold', async ({ page }) => {
  const result = await page.evaluate((config) => {
    const w = window as unknown as VlWindow

    // (a) already-virtual list grows.
    const startItems = Array.from({ length: 100 }, (_v, i) => ({ id: 100 + i }))
    const vl = w.__vlHarness.make('grid', startItems, { config })
    const container = w.__vlScroll.firstElementChild as HTMLElement
    const heightBefore = parseFloat(container.style.minHeight) || 0
    vl.appendItems(Array.from({ length: 100 }, (_v, i) => ({ id: 300 + i })))
    const grew = {
      length: vl.items.length,
      heightGrew: (parseFloat(container.style.minHeight) || 0) > heightBefore,
      stillVirtual: vl.isVirtual(),
      renderedSubset: vl.getRenderedCount() < vl.items.length,
    }
    w.__vlHarness.teardown()

    // (b) below-threshold list promoted by an append that crosses threshold=10.
    const smallItems = Array.from({ length: 5 }, (_v, i) => ({ id: 700 + i }))
    const vl2 = w.__vlHarness.make('grid', smallItems, { config })
    const wasVirtual = vl2.isVirtual()
    vl2.appendItems(Array.from({ length: 20 }, (_v, i) => ({ id: 900 + i })))
    const promoted = {
      wasVirtual,
      nowVirtual: vl2.isVirtual(),
      length: vl2.items.length,
    }
    w.__vlHarness.teardown()

    return { grew, promoted }
  }, GRID_CONFIG)

  expect(result.grew.length).toBe(200)
  expect(result.grew.heightGrew).toBe(true)
  expect(result.grew.stillVirtual).toBe(true)
  expect(result.grew.renderedSubset).toBe(true)

  expect(result.promoted.wasVirtual).toBe(false)
  expect(result.promoted.nowVirtual).toBe(true)
  expect(result.promoted.length).toBe(25)
})

// ---------------------------------------------------------------------------
// 7. reconfigure: swaps the renderItem WITHOUT tearing down observers/listeners
//    (reuse across view changes). New render marker appears; instance stays
//    virtual; the scroll listener + resize observer survive.
// ---------------------------------------------------------------------------
test('reconfigure swaps the renderer and keeps observers alive', async ({ page }) => {
  const result = await page.evaluate((config) => {
    const w = window as unknown as VlWindow
    const items = Array.from({ length: 200 }, (_v, i) => ({ id: 100 + i }))
    const vl = w.__vlHarness.make('grid', items, { config })
    const container = w.__vlScroll.firstElementChild as HTMLElement

    const before = {
      reconfiguredNodes: container.querySelectorAll('.reconfigured').length,
      hasScrollHandler: Boolean(vl.scrollHandler),
      hasResizeObserver: Boolean(vl.resizeObserver),
    }

    vl.reconfigure({
      renderItem: (index: number, data: any) => {
        const el = document.createElement('div')
        el.className = 'vl-item reconfigured'
        el.dataset.pinId = String(data.id)
        return el
      },
    })

    const after = {
      reconfiguredNodes: container.querySelectorAll('.reconfigured').length,
      stillVirtual: vl.isVirtual(),
      renderedCount: vl.getRenderedCount(),
      // Observers/listeners must NOT have been destroyed by reconfigure.
      hasScrollHandler: Boolean(vl.scrollHandler),
      hasResizeObserver: Boolean(vl.resizeObserver),
    }
    w.__vlHarness.teardown()
    return { before, after }
  }, GRID_CONFIG)

  expect(result.before.reconfiguredNodes).toBe(0)
  expect(result.before.hasScrollHandler).toBe(true)
  expect(result.before.hasResizeObserver).toBe(true)

  expect(result.after.reconfiguredNodes).toBeGreaterThan(0)
  expect(result.after.stillVirtual).toBe(true)
  expect(result.after.renderedCount).toBeGreaterThan(0)
  expect(result.after.hasScrollHandler).toBe(true)
  expect(result.after.hasResizeObserver).toBe(true)
})

// ---------------------------------------------------------------------------
// 8. updateItem replaces a rendered element in place; toggleItemClass flips a
//    class and mirrors 'selected' into aria-selected.
// ---------------------------------------------------------------------------
test('updateItem replaces an element and toggleItemClass mirrors aria-selected', async ({ page }) => {
  const result = await page.evaluate((config) => {
    const w = window as unknown as VlWindow
    const items = Array.from({ length: 30 }, (_v, i) => ({ id: 100 + i }))
    const vl = w.__vlHarness.make('grid', items, { config })
    const container = w.__vlScroll.firstElementChild as HTMLElement

    const key = 100 // id of index 0, in the visible window.
    const findEl = () => container.querySelector('[data-pin-id="100"]') as HTMLElement | null

    const beforeTitle = findEl()?.title

    // toggleItemClass add -> class + aria-selected true.
    const addOk = vl.toggleItemClass(key, 'selected', true)
    const afterAdd = {
      hasSelected: findEl()?.classList.contains('selected'),
      aria: findEl()?.getAttribute('aria-selected'),
    }
    // toggleItemClass remove -> aria-selected false.
    vl.toggleItemClass(key, 'selected', false)
    const afterRemove = {
      hasSelected: findEl()?.classList.contains('selected'),
      aria: findEl()?.getAttribute('aria-selected'),
    }

    // updateItem swaps in a freshly rendered element (new title).
    const updateOk = vl.updateItem(key, { id: 100, title: 'updated-marker' })
    const afterUpdate = findEl()?.title

    const miss = vl.updateItem(999999, { id: 999999 })

    w.__vlHarness.teardown()
    return { beforeTitle, addOk, afterAdd, afterRemove, updateOk, afterUpdate, miss }
  }, GRID_CONFIG)

  expect(result.addOk).toBe(true)
  expect(result.afterAdd.hasSelected).toBe(true)
  expect(result.afterAdd.aria).toBe('true')
  expect(result.afterRemove.hasSelected).toBe(false)
  expect(result.afterRemove.aria).toBe('false')
  expect(result.updateOk).toBe(true)
  expect(result.beforeTitle).not.toBe('updated-marker')
  expect(result.afterUpdate).toBe('updated-marker')
  expect(result.miss).toBe(false)
})

// ---------------------------------------------------------------------------
// 9. destroy: empties the container, strips the virtual-scroll class + inline
//    layout styles, and resets state (not virtual, zero rendered).
// ---------------------------------------------------------------------------
test('destroy clears the container and resets state', async ({ page }) => {
  const result = await page.evaluate((config) => {
    const w = window as unknown as VlWindow
    const items = Array.from({ length: 300 }, (_v, i) => ({ id: 100 + i }))
    const vl = w.__vlHarness.make('grid', items, { config })
    const container = w.__vlScroll.firstElementChild as HTMLElement

    const before = {
      childCount: container.children.length,
      hasVirtualClass: container.classList.contains('virtual-scroll'),
    }
    vl.destroy()
    const after = {
      childCount: container.children.length,
      hasVirtualClass: container.classList.contains('virtual-scroll'),
      position: container.style.position,
      minHeight: container.style.minHeight,
      isVirtual: vl.isVirtual(),
      renderedCount: vl.getRenderedCount(),
    }
    // teardown() calls destroy() again — must be idempotent (no throw).
    w.__vlHarness.teardown()
    return { before, after }
  }, GRID_CONFIG)

  expect(result.before.childCount).toBeGreaterThan(0)
  expect(result.before.hasVirtualClass).toBe(true)
  expect(result.after.childCount).toBe(0)
  expect(result.after.hasVirtualClass).toBe(false)
  expect(result.after.position).toBe('')
  expect(result.after.minHeight).toBe('')
  expect(result.after.isVirtual).toBe(false)
  expect(result.after.renderedCount).toBe(0)
})

// ---------------------------------------------------------------------------
// 10. Waterfall masonry: items go to the then-shortest column (first N items
//     seed columns 0..N-1 at top 0), height derives from aspect ratio clamped
//     to [minHeight,maxHeight], and rendered cards are absolutely positioned
//     with aspect-ratio:auto.
// ---------------------------------------------------------------------------
test('waterfall assigns shortest column, clamps aspect height, positions absolutely', async ({ page }) => {
  const result = await page.evaluate(() => {
    const w = window as unknown as VlWindow
    // Mixed aspect ratios incl. extremes that must clamp.
    const items = Array.from({ length: 60 }, (_v, i) => {
      if (i === 0) return { id: 5000, width: 100, height: 100000 } // -> clamps to maxHeight
      if (i === 1) return { id: 5001, width: 100000, height: 100 } // -> clamps to minHeight
      return { id: 5000 + i, width: 100, height: 100 + (i % 5) * 40 }
    })
    const vl = w.__vlHarness.make('waterfall', items, {
      columnWidth: 100,
      minHeight: 50,
      maxHeight: 300,
      estimatedHeight: 150,
      config: {
        forceVirtual: true,
        minColumnWidth: 100,
        columnGap: 0,
        rowGap: 0,
        estimatedItemHeight: 150,
        bufferSize: 2,
      },
    })
    const container = w.__vlScroll.firstElementChild as HTMLElement
    const columns = vl.columns

    // First `columns` items fill distinct columns, all at top 0.
    const seedRow = Array.from({ length: columns }, (_v, i) => vl.getLayoutForIndex(i))
    const seededColumns = seedRow.map((p: any) => p.column)
    const seededTops = seedRow.map((p: any) => p.top)
    const distinctLefts = new Set(seedRow.map((p: any) => p.left)).size

    // Aspect clamp on the two extreme items.
    const tallClamped = vl.getLayoutForIndex(0).height
    const shortClamped = vl.getLayoutForIndex(1).height

    const sample = container.querySelector('.vl-item') as HTMLElement
    const out = {
      columns,
      seededColumns,
      seededTopsAllZero: seededTops.every((t: number) => t === 0),
      distinctLefts,
      tallClamped,
      shortClamped,
      sampleAbsolute: sample?.style.position === 'absolute',
      sampleAspectAuto: sample?.style.aspectRatio === 'auto',
      sampleHasVirtualIndex: sample?.dataset.virtualIndex !== undefined,
      renderedSubset: vl.getRenderedCount() < items.length,
    }
    w.__vlHarness.teardown()
    return out
  })

  expect(result.columns).toBeGreaterThan(1)
  // columns 0..N-1 each seeded exactly once, all at top 0.
  expect(result.seededColumns).toEqual(Array.from({ length: result.columns }, (_v, i) => i))
  expect(result.seededTopsAllZero).toBe(true)
  expect(result.distinctLefts).toBe(result.columns)
  // Extreme aspect ratios clamp to the configured bounds.
  expect(result.tallClamped).toBe(300)
  expect(result.shortClamped).toBe(50)
  expect(result.sampleAbsolute).toBe(true)
  expect(result.sampleAspectAuto).toBe(true)
  expect(result.sampleHasVirtualIndex).toBe(true)
  expect(result.renderedSubset).toBe(true)
})

// ---------------------------------------------------------------------------
// 11. Real-app wiring: the gallery grid actually constructs these classes.
//     Grid mode (>= threshold 96) engages VirtualList with recycling; waterfall
//     engages WaterfallVirtualList with absolute, multi-column masonry.
// ---------------------------------------------------------------------------
test('real gallery grid + waterfall route into the virtual-list classes', async ({ page }) => {
  await activateGallery(page)

  // --- grid: virtual engages, only a subset of 200 cards is in the DOM ---
  await seedGallery(page, 200, 'grid')
  await expect
    .poll(() => page.locator('#gallery-grid.virtual-scroll .gallery-item').count(), { timeout: 8000 })
    .toBeGreaterThan(0)
  await expect(page.locator('#gallery-grid')).toHaveClass(/virtual-scroll/)
  const gridRendered = await page.locator('#gallery-grid .gallery-item').count()
  expect(gridRendered).toBeGreaterThan(0)
  expect(gridRendered).toBeLessThan(200)

  const gridWiring = await page.evaluate(() => {
    const w = window as unknown as VlWindow
    return {
      isVirtual: Boolean(w.Gallery.useVirtualScroll && w.Gallery.virtualList),
      isWaterfall: w.Gallery.virtualList instanceof w.WaterfallVirtualList,
    }
  })
  expect(gridWiring.isVirtual).toBe(true)
  expect(gridWiring.isWaterfall).toBe(false)

  // --- waterfall: WaterfallVirtualList, absolute cards across >1 column ---
  await seedGallery(page, 200, 'waterfall')
  await expect
    .poll(() => page.locator('#gallery-grid.virtual-scroll .gallery-item').count(), { timeout: 8000 })
    .toBeGreaterThan(0)

  const waterfall = await page.evaluate(() => {
    const w = window as unknown as VlWindow
    const grid = document.getElementById('gallery-grid') as HTMLElement
    const items = Array.from(grid.querySelectorAll('.gallery-item')) as HTMLElement[]
    const lefts = new Set(items.map((el) => Math.round(el.getBoundingClientRect().left)))
    const sample = items[0]
    return {
      isWaterfall: w.Gallery.virtualList instanceof w.WaterfallVirtualList,
      distinctColumns: lefts.size,
      sampleAbsolute: sample ? getComputedStyle(sample).position === 'absolute' : false,
      renderedCount: items.length,
    }
  })
  expect(waterfall.isWaterfall).toBe(true)
  expect(waterfall.distinctColumns).toBeGreaterThan(1)
  expect(waterfall.sampleAbsolute).toBe(true)
  expect(waterfall.renderedCount).toBeGreaterThan(0)
})
