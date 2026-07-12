import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * FE-1 2b pin spec: the Dataset Maker editor-core side-effect chain.
 *
 * `_setActive`, `_buildQueueItem` and `_buildExportPayload` are (pre-refactor)
 * extended across dataset-maker-part2 / part3 / local-import /
 * confidence-pills / caption-split / separation-console via monkey-patch
 * chains. This spec pins the OBSERVABLE behavior of those chains so the
 * patch-chain dissolution (hooks/decorator registries) is provably
 * zero-behavior-change. It must pass BEFORE and AFTER the refactor.
 *
 * Notable edge cases pinned on purpose:
 *   - pending caption edits flush synchronously when switching gallery
 *     images, but NOT when re-activating the same image and NOT when
 *     switching to a local-source (negative-id) item;
 *   - the split-view refresh and caption-diff update are gallery-only
 *     side effects — the local-import branch never ran them;
 *   - the Separation Console seen-marking + token counter only attach
 *     after the console is first opened (lazy hook).
 *
 * All backend routes the chain touches are stubbed; DM state is seeded
 * in-page (pattern from sepcon-rethreshold.spec.ts).
 */

test.describe.configure({ mode: 'serial' })

const LOCAL_ID = -424242
const LOCAL_PATH = 'C:/fake/local/img_001.png'
const MANIFEST_LOCAL_ID = -424243
const MANIFEST_PATH = 'C:/fake/manifested/img_002.png'

async function seedDatasetQueue(page: Page) {
  await page.route('**/api/image-thumbnail/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/dataset/local-thumbnail**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // _captionTypeFor is defined by dataset-maker-caption-split.js — the LAST
  // script in the ordered DM module chain — so this waits for every DM
  // patch/hook layer to be installed, not just part2.
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [701, 702, 703, 704]
    dm.meta.set(701, { filename: 'core-a.png', width: 1024, height: 1024 })
    dm.meta.set(702, { filename: 'core-b.png', width: 1024, height: 1024 })
    dm.meta.set(703, { filename: 'core-c.png', width: 1024, height: 1024 })
    dm.meta.set(704, { filename: 'core-d.png', width: 1024, height: 1024 })
    dm.captions.set(701, '1girl, smile')
    dm.captions.set(702, '1girl, frown')
    dm.captions.set(703, '1girl, frown')
    // 703 carries a manual edit (adds "hat") so diff/status pins have data.
    dm.captionEdits.set(703, '1girl, frown, hat')
    // 704 stays untagged (no caption at all).
    ;(window as any).App.switchView('dataset')
    dm._setActive(701)
  })
}

async function seedLocalItem(page: Page) {
  await page.evaluate(({ localId, localPath }) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds.push(localId)
    dm.localItemPaths.set(localId, localPath)
    dm.localItemDsIds.set(localId, 'ds:feedbeef00000')
    dm.meta.set(localId, {
      source: 'local',
      abs_path: localPath,
      filename: 'img_001.png',
      width: 512,
      height: 512,
    })
    dm.captions.set(localId, 'local caption, tree')
  }, { localId: LOCAL_ID, localPath: LOCAL_PATH })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('_setActive fills the editor, highlights the queue item, and updates the diff', async ({ page }) => {
  await seedDatasetQueue(page)
  await page.locator('#dataset-tab-workbench').click()

  await expect(page.locator('#dataset-editor-textarea')).toHaveValue('1girl, smile')
  await expect(page.locator('#dataset-editor-filename')).toHaveText('core-a.png')
  // Base _setActive injects the full-res button bar exactly once.
  await expect(page.locator('#dataset-editor-image-wrap .dataset-fullres-bar .dataset-fullres-btn')).toHaveCount(2)
  // 701 has no manual edit — the diff indicator stays hidden.
  await expect(page.locator('#dataset-caption-diff')).toBeHidden()
  await expect(page.locator('#dataset-queue-list .dataset-queue-item.active')).toHaveAttribute('data-image-id', '701')

  // Switching to the edited image updates textarea, filename, diff, highlight.
  await page.evaluate(() => (window as any).DatasetMaker._setActive(703))
  await expect(page.locator('#dataset-editor-textarea')).toHaveValue('1girl, frown, hat')
  await expect(page.locator('#dataset-editor-filename')).toHaveText('core-c.png')
  await expect(page.locator('#dataset-caption-diff')).toContainText('+1 tag')
  await expect(page.locator('#dataset-queue-list .dataset-queue-item.active')).toHaveAttribute('data-image-id', '703')
})

test('_setActive flushes a pending caption edit when switching, not when re-activating', async ({ page }) => {
  await seedDatasetQueue(page)
  await page.locator('#dataset-tab-workbench').click()

  const result = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    const ta = document.getElementById('dataset-editor-textarea') as HTMLTextAreaElement
    // Simulate typing on 701; the 200ms debounce has NOT fired yet.
    ta.value = '1girl, smile, hat'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    // Switching images must flush the pending edit synchronously.
    dm._setActive(702)
    const flushedOnSwitch = dm.captionEdits.get(701)
    const taAfterSwitch = ta.value

    // Re-activating the SAME image does not flush.
    ta.value = '1girl, frown, x'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    dm._setActive(702)
    const flushedOnSameId = dm.captionEdits.has(702)
    return { flushedOnSwitch, taAfterSwitch, flushedOnSameId, activeId: dm.activeId }
  })

  expect(result.flushedOnSwitch).toBe('1girl, smile, hat')
  expect(result.taAfterSwitch).toBe('1girl, frown')
  expect(result.flushedOnSameId).toBe(false)
  expect(result.activeId).toBe(702)
})

test('split view refreshes on gallery image change, never for local items', async ({ page }) => {
  await seedDatasetQueue(page)
  await page.locator('#dataset-tab-workbench').click()

  await page.locator('#btn-dataset-split-view').click()
  const cards = page.locator('#dataset-split-panel .dataset-split-card')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toHaveAttribute('data-image-id', '701')
  await expect(cards.nth(1)).toHaveAttribute('data-image-id', '702')

  await page.evaluate(() => (window as any).DatasetMaker._setActive(702))
  await expect(cards.nth(0)).toHaveAttribute('data-image-id', '702')
  await expect(cards.nth(1)).toHaveAttribute('data-image-id', '703')

  // Gallery-only side effect: switching to a local-source item leaves the
  // split panel untouched (the local branch never re-rendered it).
  await seedLocalItem(page)
  await page.evaluate((id) => (window as any).DatasetMaker._setActive(id), LOCAL_ID)
  await expect(cards.nth(0)).toHaveAttribute('data-image-id', '702')
  await expect(cards.nth(1)).toHaveAttribute('data-image-id', '703')
})

test('Separation Console hooks lazily: seen-marking + token counter after open', async ({ page }) => {
  await page.route('**/api/tags/scores/stats', async (route) => {
    await route.fulfill({
      json: { enabled: true, floor: 0.15, total_rows: 0, images_with_scores: 0, models: [], estimated_bytes: 0 },
    })
  })
  await seedDatasetQueue(page)
  await page.locator('#dataset-tab-workbench').click()

  // Before the console opens, _setActive marks nothing as seen.
  await page.evaluate(() => (window as any).DatasetMaker._setActive(703))
  const seenBefore = await page.evaluate(() => localStorage.getItem('sd-image-sorter-dataset-seen'))
  expect(seenBefore).toBeNull()

  await page.locator('#dataset-separation-console summary').click()
  await expect(page.locator('#sepcon-rows')).toBeVisible()

  await page.evaluate(() => (window as any).DatasetMaker._setActive(702))
  const seen = await page.evaluate(() => JSON.parse(localStorage.getItem('sd-image-sorter-dataset-seen') || '{}'))
  expect(seen['702']).toBe(true)
  // The token counter is created next to the booru box and reflects 702's
  // caption: "1girl, frown" = 2 tags, ceil(5/4)+ceil(5/4)+1 comma = 5 tokens.
  await expect(page.locator('#dataset-token-counter')).toHaveText('2 tags · ≈5 tokens')
})

test('confidence pills refresh on _setActive; hidden again for local items', async ({ page }) => {
  await page.route('**/api/images/701', async (route) => {
    await route.fulfill({
      json: {
        tags: [
          { tag: '1girl', confidence: 0.95, category: 'general' },
          { tag: 'smile', confidence: 0.42, category: 'general' },
        ],
      },
    })
  })
  await seedDatasetQueue(page)

  const pills = page.locator('#dataset-confidence-pills .dataset-confidence-pill')
  await expect(pills).toHaveCount(2)
  await expect(pills.nth(0)).toHaveClass(/conf-high/)
  await expect(pills.nth(1)).toHaveClass(/conf-low/)
  expect(await page.evaluate(() => (document.getElementById('dataset-confidence-panel') as HTMLElement).hidden)).toBe(false)

  // Local items have no DB confidence — the panel hides again.
  await seedLocalItem(page)
  await page.evaluate((id) => (window as any).DatasetMaker._setActive(id), LOCAL_ID)
  await expect.poll(() => page.evaluate(() => (document.getElementById('dataset-confidence-panel') as HTMLElement).hidden)).toBe(true)
})

test('caption-split: NL box + per-image type follow the active image', async ({ page }) => {
  await seedDatasetQueue(page)
  await page.locator('#dataset-tab-workbench').click()

  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.nlCaptions.set(702, 'a girl frowning at the camera')
    dm._setActive(702)
  })
  await expect(page.locator('#dataset-editor-nl')).toBeVisible()
  await expect(page.locator('#dataset-editor-nl')).toHaveValue('a girl frowning at the camera')
  await expect(page.locator('#dataset-caption-type')).toBeVisible()
  // Auto type: an image WITH an NL sentence defaults to "both".
  await expect(page.locator('#dataset-caption-type .dataset-caption-type-btn.is-active')).toHaveAttribute('data-caption-type', 'both')
  await expect(page.locator('#dataset-editor-textarea')).toBeVisible()

  // An image without NL defaults back to booru-only: the NL box hides.
  await page.evaluate(() => (window as any).DatasetMaker._setActive(701))
  await expect(page.locator('#dataset-editor-nl')).toBeHidden()
  await expect(page.locator('#dataset-caption-type .dataset-caption-type-btn.is-active')).toHaveAttribute('data-caption-type', 'booru')
})

test('_buildQueueItem DOM contract: statuses, badges, order, caption-type chips', async ({ page }) => {
  await seedDatasetQueue(page)

  const snap = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.captionType.set(702, 'nl')
    dm.captionType.set(703, 'both')
    const pick = (id: number, orderIndex: number) => {
      const node = dm._buildQueueItem(id, orderIndex) as HTMLElement
      return {
        className: node.className,
        imageId: node.dataset.imageId,
        queueOrder: node.dataset.queueOrder,
        role: node.getAttribute('role'),
        filename: node.querySelector('.dataset-queue-filename')?.textContent ?? null,
        idLabel: node.querySelector('.dataset-queue-id')?.textContent ?? null,
        orderBadge: node.querySelector('.dataset-queue-order')?.textContent ?? null,
        badgeClass: node.querySelector('.dataset-queue-badge')?.className ?? null,
        hasSelectToggle: !!node.querySelector('.dataset-queue-select-toggle[role="checkbox"]'),
        hasThumb: !!node.querySelector('img.dataset-queue-thumb'),
        chip: node.querySelector('.dataset-queue-captype')?.textContent ?? null,
        chipClass: node.querySelector('.dataset-queue-captype')?.className ?? null,
        chipInMeta: !!node.querySelector('.dataset-queue-meta .dataset-queue-captype'),
      }
    }
    return { a: pick(701, 0), nl: pick(702, 1), edited: pick(703, 2), untagged: pick(704, 3) }
  })

  expect(snap.a.className).toContain('dataset-queue-item')
  expect(snap.a.className).toContain('status-tagged')
  expect(snap.a.imageId).toBe('701')
  expect(snap.a.queueOrder).toBe('1')
  expect(snap.a.orderBadge).toBe('1')
  expect(snap.a.role).toBe('button')
  expect(snap.a.filename).toBe('core-a.png')
  expect(snap.a.idLabel).toBe('#701')
  expect(snap.a.hasSelectToggle).toBe(true)
  expect(snap.a.hasThumb).toBe(true)
  expect(snap.a.badgeClass).toContain('dataset-queue-badge-tagged')
  // booru-typed images get NO caption-type chip.
  expect(snap.a.chip).toBeNull()

  expect(snap.nl.chip).toBe('NL')
  expect(snap.nl.chipClass).toContain('dataset-queue-captype-nl')
  expect(snap.nl.chipInMeta).toBe(true)

  expect(snap.edited.className).toContain('status-edited')
  expect(snap.edited.badgeClass).toContain('dataset-queue-badge-edited')
  expect(snap.edited.chip).toBe('B+N')
  expect(snap.edited.chipClass).toContain('dataset-queue-captype-both')

  expect(snap.untagged.className).toContain('status-untagged')
  expect(snap.untagged.badgeClass).toContain('dataset-queue-badge-untagged')
})

test('local items: queue decoration + local _setActive branch (no flush, no diff)', async ({ page }) => {
  await seedDatasetQueue(page)
  await seedLocalItem(page)
  await page.locator('#dataset-tab-workbench').click()

  const item = await page.evaluate((id) => {
    const dm = (window as any).DatasetMaker
    const node = dm._buildQueueItem(id, 4) as HTMLElement
    return {
      className: node.className,
      idLabel: node.querySelector('.dataset-queue-id')?.textContent ?? null,
    }
  }, LOCAL_ID)
  expect(item.className).toContain('source-local')
  expect(item.idLabel).toBe('📁 img_001.png')

  // Make the caption diff visible from the edited gallery image first.
  await page.evaluate(() => (window as any).DatasetMaker._setActive(703))
  await expect(page.locator('#dataset-caption-diff')).toContainText('+1 tag')

  const res = await page.evaluate((id) => {
    const dm = (window as any).DatasetMaker
    const ta = document.getElementById('dataset-editor-textarea') as HTMLTextAreaElement
    // Pending (un-debounced) edit on 703, then switch to the LOCAL item.
    ta.value = '1girl, frown, hat, bow'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    dm._setActive(id)
    return {
      activeId: dm.activeId,
      // The local branch never flushed pending gallery edits synchronously
      // (the debounce timer still commits later on its own).
      captionEditNow: dm.captionEdits.get(703),
      taValue: ta.value,
      filename: document.getElementById('dataset-editor-filename')?.textContent ?? null,
      diffHidden: (document.getElementById('dataset-caption-diff') as HTMLElement).hidden,
    }
  }, LOCAL_ID)

  expect(res.activeId).toBe(LOCAL_ID)
  expect(res.captionEditNow).toBe('1girl, frown, hat')
  expect(res.taValue).toBe('local caption, tree')
  expect(res.filename).toBe('📁 img_001.png')
  // Gallery-only hook: the diff indicator is untouched by a local switch.
  expect(res.diffHidden).toBe(false)
})

test('_buildExportPayload splits gallery ids, local paths, and manifest tokens', async ({ page }) => {
  await seedDatasetQueue(page)
  await seedLocalItem(page)

  const payload = await page.evaluate(({ manifestId, manifestPath, localId, localPath }) => {
    const dm = (window as any).DatasetMaker
    // A manifest-tracked local item exports via its scan token, not image_paths.
    dm.imageIds.push(manifestId)
    dm.localItemPaths.set(manifestId, manifestPath)
    dm.meta.set(manifestId, {
      source: 'local',
      abs_path: manifestPath,
      filename: 'img_002.png',
      folder_scan_token: 'tok-1',
    })
    dm.localManifestTokens.set('tok-1', {
      scan_token: 'tok-1',
      folder_path: 'C:/fake/manifested',
      total: 5,
      excludedPaths: new Set(['C:/fake/manifested/skip.png']),
    })
    dm.captionEdits.set(701, 'edited-a')
    dm.captionEdits.set(localId, 'edited-local')
    dm.captionType.set(702, 'nl')
    dm.captionType.set(localId, 'both')
    dm.nlEdits.set(702, 'nl sentence for b')
    dm.nlEdits.set(localId, 'nl sentence for local')
    return dm._buildExportPayload()
  }, { manifestId: MANIFEST_LOCAL_ID, manifestPath: MANIFEST_PATH, localId: LOCAL_ID, localPath: LOCAL_PATH })

  expect(payload.image_ids).toEqual([701, 702, 703, 704])
  expect(payload.image_paths).toEqual([LOCAL_PATH])
  expect(payload.dataset_scan_tokens).toEqual([
    { scan_token: 'tok-1', exclude_paths: ['C:/fake/manifested/skip.png'] },
  ])
  // Dual-key overrides: str(image_id) for gallery rows, abs path for local.
  expect(payload.image_overrides).toEqual({
    '701': 'edited-a',
    '703': '1girl, frown, hat',
    [LOCAL_PATH]: 'edited-local',
  })
  expect(payload.image_types).toEqual({ '702': 'nl', [LOCAL_PATH]: 'both' })
  expect(payload.image_nl_overrides).toEqual({
    '702': 'nl sentence for b',
    [LOCAL_PATH]: 'nl sentence for local',
  })
})
