import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * v321-ui.js god-file — characterization pins (decomposition step 0).
 *
 * `frontend/js/v321-ui.js` is `const V321Integration = { ...~3150 lines... }`
 * (the gallery.js object-literal model, NOT the app.js top-level-function
 * model) published as `window.V321Integration` with a DOMContentLoaded
 * `init()` boot. It owns three live surfaces of the Tag + Batch-Export flow:
 *   (A) the tagger 3-tab redesign (Smart / Local / Natural-Language /
 *       Aesthetic / Color) inside #tag-modal,
 *   (B) the LoRA training-preset selector + template options in the batch
 *       export modal,
 *   (C) the live export preview / caption editor with per-image edit and the
 *       clipboard/download "combined export" dispatch.
 *
 * These pins lock the load-bearing behaviour that the FUTURE split must keep
 * byte-for-byte identical, and that is NOT already covered by:
 *   - caption-editor-merge.spec.ts (the two-box NL/Both merge + export-batch
 *     image_types/image_nl_overrides payload — real DB fixture),
 *   - tagger-training-filters.spec.ts (P2-19 purpose / P2-18 dedup / P1-17
 *     trait pruner through the real export engine),
 *   - smoke.spec.ts (the native #tag-model-select option catalog + the
 *     batch-export modal open / sidecar output).
 *
 * Determinism: every pin runs on the empty clean-DB e2e server with NO seeded
 * image rows. The tag modal opens with no selection (#btn-tag → showModal),
 * the batch modal is opened via window.showModal to bypass the selection
 * guard, and the tagger-dropdown pins self-seed synthetic <option>s into the
 * static #tag-model-select. Green on two consecutive clean DBs.
 */

const REQUIRED_METHODS = [
  'init',
  'setTaggerTab',
  'applyTaggerTab',
  'renderTaggerModelChoices',
  'syncVisibleTaggerCopy',
  'refreshVLMBannerStatus',
  'bindExportPresetUI',
  'renderPresetGrid',
  'collectTemplateOptions',
  'refreshPreview',
  'openCaptionEditor',
  'closeCaptionEditor',
  'collectEditedCaptionOverrides',
  'collectCaptionTransforms',
  'collectCaptionTypes',
  'collectNlOverrides',
  '_buildCombinedExportPayload',
  '_previewOptionsForContentMode',
  'interceptCombinedExportClick',
  '_getCaptionType',
] as const

/** goto '/', wait for App ready + the V321Integration boot to have run. */
async function openApp(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          Boolean(
            window.App &&
              typeof window.App.loadImages === 'function' &&
              window.App.AppState?.isLoading === false &&
              window.V321Integration &&
              typeof window.V321Integration === 'object',
          ),
      ),
    )
    .toBe(true)
}

/** Replace #tag-model-select options with the 3 archetypes the tab filter keys
 *  off: a local WD model, the cloud VLM sentinel, and a ToriiGate local VLM. */
async function seedTagModelOptions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const select = document.getElementById('tag-model-select') as HTMLSelectElement | null
    if (!select) throw new Error('#tag-model-select missing')
    select.replaceChildren()
    for (const value of ['wd-swinv2-tagger-v3', 'vlm', 'toriigate-0.5']) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value
      select.appendChild(option)
    }
  })
}

/** Read the [hidden] state of each seeded option (true = visible). */
async function optionVisibility(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => {
    const visible = (value: string) => {
      const opt = document.querySelector(
        `#tag-model-select option[value="${CSS.escape(value)}"]`,
      ) as HTMLOptionElement | null
      return Boolean(opt) && !opt!.hidden
    }
    return {
      wd: visible('wd-swinv2-tagger-v3'),
      vlm: visible('vlm'),
      torii: visible('toriigate-0.5'),
    }
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

// (1) Object-literal public surface — the contract the split must preserve.
// The future split reassembles `V321Integration` via Object.assign mixins over
// a shared base object (gallery.js precedent); every consumer name must stay
// attached to the one `window.V321Integration`. v321-ui.js:8, :3164.
test('window.V321Integration exposes the object-literal surface consumers depend on', async ({ page }) => {
  await openApp(page)

  const surface = await page.evaluate((methods) => {
    const V = window.V321Integration
    return {
      isObject: Boolean(V) && typeof V === 'object',
      selfSame: V === window.V321Integration,
      missing: methods.filter((name: string) => typeof V?.[name] !== 'function'),
      editedCaptionsIsMap: V?.editedCaptions instanceof Map,
      nlCacheIsMap: V?.nlCache instanceof Map,
      queueImageIdsIsArray: Array.isArray(V?.queueImageIds),
      activeTaggerTabIsString: typeof V?.activeTaggerTab === 'string',
      captionTransformsIsObject: Boolean(V?.captionTransforms) && typeof V?.captionTransforms === 'object',
    }
  }, REQUIRED_METHODS as unknown as string[])

  expect(surface.isObject).toBe(true)
  expect(surface.selfSame).toBe(true)
  expect(surface.missing).toEqual([])
  expect(surface.editedCaptionsIsMap).toBe(true)
  expect(surface.nlCacheIsMap).toBe(true)
  expect(surface.queueImageIdsIsArray).toBe(true)
  expect(surface.activeTaggerTabIsString).toBe(true)
  expect(surface.captionTransformsIsObject).toBe(true)
})

// (2) Tagger tab default + switch. Init lands on 'local' (the familiar WD14
// config, documented at v321-ui.js:213-216); clicking the NL tab flips the
// active state + toggles the vlmActive flag + swaps the description key.
test('tagger tabs: init defaults to local, NL tab activates and sets vlmActive', async ({ page }) => {
  await openApp(page)

  await page.locator('#btn-tag').click()
  await expect(page.locator('#tag-modal.visible')).toBeVisible()

  // Default open state = local.
  await expect
    .poll(async () => page.evaluate(() => window.V321Integration.activeTaggerTab))
    .toBe('local')
  await expect(page.locator('#tag-modal .tagger-tab[data-tagger-tab="local"]')).toHaveClass(/active/)
  await expect(page.locator('#tag-modal .tagger-tab[data-tagger-tab="local"]')).toHaveAttribute(
    'aria-selected',
    'true',
  )
  expect(await page.evaluate(() => window.V321Integration.vlmActive)).toBe(false)

  // Click Natural Language.
  await page.locator('#tag-modal .tagger-tab[data-tagger-tab="nl"]').click()
  await expect(page.locator('#tag-modal .tagger-tab[data-tagger-tab="nl"]')).toHaveClass(/active/)
  await expect(page.locator('#tag-modal .tagger-tab[data-tagger-tab="nl"]')).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.locator('#tag-modal .tagger-tab[data-tagger-tab="local"]')).not.toHaveClass(/active/)
  await expect(page.locator('#tagger-tab-description')).toHaveAttribute('data-i18n', 'tagger.tabNlDesc')
  expect(await page.evaluate(() => window.V321Integration.activeTaggerTab)).toBe('nl')
  expect(await page.evaluate(() => window.V321Integration.vlmActive)).toBe(true)

  // Back to Local clears vlmActive (only NL sets it).
  await page.locator('#tag-modal .tagger-tab[data-tagger-tab="local"]').click()
  expect(await page.evaluate(() => window.V321Integration.vlmActive)).toBe(false)
})

// (3) Unknown tab id normalizes to 'smart' (v321-ui.js:258-261). A real
// runtime decision, not a hardcode — proven by (2) honoring real ids.
test('setTaggerTab normalizes an unknown tab id to smart', async ({ page }) => {
  await openApp(page)

  const result = await page.evaluate(() => {
    window.V321Integration.setTaggerTab('not-a-real-tab')
    const smartBtn = document.querySelector('#tag-modal .tagger-tab[data-tagger-tab="smart"]')
    return {
      activeTab: window.V321Integration.activeTaggerTab,
      vlmActive: window.V321Integration.vlmActive,
      smartSelected: smartBtn?.getAttribute('aria-selected') || null,
    }
  })

  expect(result.activeTab).toBe('smart')
  expect(result.vlmActive).toBe(false)
  expect(result.smartSelected).toBe('true')
})

// (4) applyTaggerTab filters the model dropdown by tab (v321-ui.js:454-489):
// local hides the VLM + ToriiGate rows; NL shows ONLY those two; aesthetic /
// color / smart allow none. This is the tab → native-select contract other
// modules (folder-browser, app.js) read select.value from.
test('applyTaggerTab filters #tag-model-select options per tab', async ({ page }) => {
  await openApp(page)
  await seedTagModelOptions(page)

  await page.evaluate(() => window.V321Integration.applyTaggerTab('local'))
  expect(await optionVisibility(page)).toEqual({ wd: true, vlm: false, torii: false })

  await page.evaluate(() => window.V321Integration.applyTaggerTab('nl'))
  expect(await optionVisibility(page)).toEqual({ wd: false, vlm: true, torii: true })

  await page.evaluate(() => window.V321Integration.applyTaggerTab('aesthetic'))
  expect(await optionVisibility(page)).toEqual({ wd: false, vlm: false, torii: false })
})

// (5) renderTaggerModelChoices mirrors the visible (non-hidden) options as the
// dark in-app cards in #tag-model-choice-list (v321-ui.js:519-559). The native
// select stays the value owner; users click these cards. In NL, exactly the
// VLM + ToriiGate rows render.
test('renderTaggerModelChoices renders one card per visible option in NL', async ({ page }) => {
  await openApp(page)
  await seedTagModelOptions(page)

  await page.evaluate(() => window.V321Integration.setTaggerTab('nl'))

  const cards = page.locator('#tag-model-choice-list .tagger-model-choice')
  await expect.poll(async () => cards.count()).toBe(2)
  const values = await cards.evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-model-value')),
  )
  expect(new Set(values)).toEqual(new Set(['vlm', 'toriigate-0.5']))
})

// (6) _buildCombinedExportPayload shape (v321-ui.js:3121-3158). This builds the
// /api/tags/export-combined body for the clipboard/download destinations; its
// name is contract-pinned in test_frontend_contract.py. With explicit queue
// ids and no filtered selection it takes the image_ids path (not
// selection_token) and always emits output_mode:'folder'.
test('_buildCombinedExportPayload emits the image_ids export-combined body', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as unknown as { showModal: (id: string) => void }).showModal('batch-export-modal'))
  await page.locator('#batch-export-content-mode').selectOption('tags')

  const payload = await page.evaluate(() => {
    const V = window.V321Integration
    V.queueImageIds = [101, 102]
    V.queueSelectionToken = null
    return V._buildCombinedExportPayload()
  })

  expect(payload.content_mode).toBe('tags')
  expect(payload.image_ids).toEqual([101, 102])
  expect('selection_token' in payload).toBe(false)
  expect(payload.output_mode).toBe('folder')
  expect(typeof payload.overwrite_policy).toBe('string')
  expect(Array.isArray(payload.blacklist)).toBe(true)
  expect(typeof payload.prefix).toBe('string')
})

// (7) Output-destination dispatch (v321-ui.js:3017-3045). The capture-phase
// interceptor on #btn-start-batch-export short-circuits clipboard/download to
// /api/tags/export-combined (stopImmediatePropagation, so app.js's
// executeBatchExport / export-batch is NOT reached). Sidecar modes fall
// through to app.js untouched.
test('clipboard output routes Start to export-combined, not export-batch', async ({ page }) => {
  await openApp(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}))

  let combinedBody: Record<string, unknown> | null = null
  let batchStartCalls = 0
  await page.route('**/api/tags/export-combined', async (route) => {
    combinedBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ json: { download_url: '/e2e/v321-combined.txt', filename: 'combined.txt' } })
  })
  await page.route('**/e2e/v321-combined.txt', async (route) => {
    await route.fulfill({ contentType: 'text/plain; charset=utf-8', body: 'alpha, beta' })
  })
  await page.route('**/api/tags/export-batch/**', async (route) => {
    batchStartCalls += 1
    await route.fulfill({ json: { status: 'started' } })
  })

  await page.evaluate(() => (window as unknown as { showModal: (id: string) => void }).showModal('batch-export-modal'))
  await page.locator('#batch-export-content-mode').selectOption('tags')
  await page.locator('input[name="batch-export-output-mode"][value="clipboard"]').check({ force: true })
  await page.evaluate(() => {
    const V = window.V321Integration
    V.queueImageIds = [101, 102]
    V.queueSelectionToken = null
    const start = document.getElementById('btn-start-batch-export') as HTMLButtonElement | null
    if (start) start.disabled = false
  })

  await page.locator('#btn-start-batch-export').click()

  await expect.poll(() => combinedBody !== null).toBe(true)
  const body = combinedBody as unknown as { content_mode?: string; image_ids?: number[] }
  expect(body.content_mode).toBe('tags')
  expect(body.image_ids).toEqual([101, 102])
  expect(batchStartCalls).toBe(0)
  // Success path closes the modal after the combined text lands on the clipboard.
  await expect(page.locator('#batch-export-modal')).toBeHidden()
})

// (8) LoRA preset selector (v321-ui.js:965-1103). bindExportPresetUI fetches
// /api/tags/export-presets at init and renders the chips; collectTemplateOptions
// serializes the LoRA config into the template_options object the export sends.
test('export presets render chips and collectTemplateOptions returns the LoRA shape', async ({ page }) => {
  await openApp(page)

  const chips = page.locator('#lora-preset-grid .lora-preset-chip')
  await expect.poll(async () => chips.count()).toBeGreaterThan(0)

  const opts = await page.evaluate(() => window.V321Integration.collectTemplateOptions())
  expect(typeof opts.preset_id).toBe('string')
  expect(opts.preset_id.length).toBeGreaterThan(0)
  expect(typeof opts.trigger).toBe('string')
  expect(Array.isArray(opts.blacklist)).toBe(true)
  expect(Array.isArray(opts.append)).toBe(true)
  expect(typeof opts.replace_rules).toBe('object')
  expect(typeof opts.max_tags).toBe('number')
  expect('template_override' in opts).toBe(true)
})

// (9) Per-image caption type — the auto-both rule (v321-ui.js:1703-1715),
// unified with the Dataset Maker through window.CaptionCore. An image with a
// stored/edited NL sentence defaults to 'both'; without one, 'booru'; an
// explicit user choice always wins.
test('_getCaptionType applies the CaptionCore auto-both rule', async ({ page }) => {
  await openApp(page)

  const result = await page.evaluate(() => {
    const V = window.V321Integration
    const id = 987654
    V.nlCache.delete(id)
    V.editedNl.delete(id)
    V.captionTypes.delete(id)
    const withoutNl = V._getCaptionType(id)
    V.nlCache.set(id, 'a soft-lit portrait sentence')
    const withNl = V._getCaptionType(id)
    V._setCaptionType(id, 'nl')
    const explicit = V._getCaptionType(id)
    V.captionTypes.delete(id)
    V.nlCache.delete(id)
    return { captionCoreLoaded: Boolean(window.CaptionCore), withoutNl, withNl, explicit }
  })

  expect(result.captionCoreLoaded).toBe(true)
  expect(result.withoutNl).toBe('booru')
  expect(result.withNl).toBe('both')
  expect(result.explicit).toBe('nl')
})

// (10) _previewOptionsForContentMode WYSIWYG seam (v321-ui.js:1486-1526). The
// template branch delegates to collectTemplateOptions (preset-driven, no
// content_mode); every other mode sends the real content_mode so the preview
// renders through the exact backend engine the export writes with.
test('_previewOptionsForContentMode branches template vs real content_mode', async ({ page }) => {
  await openApp(page)

  const nonTemplate = await page.evaluate(() =>
    window.V321Integration._previewOptionsForContentMode('tags'),
  )
  expect(nonTemplate.content_mode).toBe('tags')
  expect(Array.isArray(nonTemplate.blacklist)).toBe(true)
  expect(typeof nonTemplate.normalize_tag_underscores).toBe('boolean')
  expect('preset_id' in nonTemplate).toBe(false)

  const template = await page.evaluate(() =>
    window.V321Integration._previewOptionsForContentMode('template'),
  )
  expect(typeof template.preset_id).toBe('string')
  expect('content_mode' in template).toBe(false)
})
