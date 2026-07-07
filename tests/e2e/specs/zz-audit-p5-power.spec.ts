import fsSync from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

/**
 * TEMPORARY AUDIT SPEC (persona 5 — power user, port 19509).
 * Deleted after the audit. Screenshots land in artifacts/v350-audit/p5-power.
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1920, height: 1080 } })

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const SHOT_DIR = path.join(repoRoot, 'artifacts', 'v350-audit', 'p5-power')
const LIBRARY = 'L:\\Pictures\\AAA Reference\\AAAwith prompt'
const PUB_OUT = path.join(repoRoot, '.tmp', 'audit-p5-power-out')

function shot(name: string): string {
  return path.join(SHOT_DIR, name)
}

async function openGallery(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const w = window as any
      return Boolean(w.App && typeof w.App.loadImages === 'function' && w.App.AppState?.isLoading === false)
    })
  }, { timeout: 30000 }).toBe(true)
}

async function filterState(page: Page): Promise<any> {
  return await page.evaluate(() => (window as any).App.AppState.filters)
}

async function galleryItemCount(page: Page): Promise<number> {
  return await page.locator('#gallery-grid .gallery-item').count()
}

async function enterSelectionMode(page: Page) {
  const already = await page.evaluate(() => Boolean((window as any).App.AppState.selectionMode))
  if (!already) {
    await page.locator('#btn-toggle-select').click()
    await expect.poll(async () => await page.evaluate(() => Boolean((window as any).App.AppState.selectionMode))).toBe(true)
  }
}

async function selectFirstN(page: Page, n: number) {
  await enterSelectionMode(page)
  for (let i = 0; i < n; i += 1) {
    await page.locator('#gallery-grid .gallery-item').nth(i).click()
  }
}

test.beforeAll(() => {
  fsSync.mkdirSync(SHOT_DIR, { recursive: true })
})

// ---------------------------------------------------------------------------
// 00 — scan the read-only reference library (620 images) if not already done
// ---------------------------------------------------------------------------
test('00 scan reference library', async ({ page, request }) => {
  test.setTimeout(600000)

  const existing = await (await request.get('/api/images?limit=1')).json()
  const alreadyScanned = Array.isArray(existing.images) && existing.images.length > 0
    && (existing.total >= 500 || existing.total === -1)

  await openGallery(page)

  if (!alreadyScanned) {
    await page.locator('#btn-scan').click()
    await expect(page.locator('#scan-modal.visible')).toBeVisible()
    await page.locator('#scan-folder-path').fill(LIBRARY)

    const autoTag = page.locator('#scan-auto-tag')
    if (await autoTag.isChecked().catch(() => false)) {
      await page.locator('label:has(#scan-auto-tag) .checkbox-custom').click()
      await expect(autoTag).not.toBeChecked()
    }
    const quickImport = page.locator('#scan-quick-import')
    if (!(await quickImport.isChecked().catch(() => false))) {
      await quickImport.check({ force: true }).catch(() => {})
    }
    await page.screenshot({ path: shot('00a-scan-modal.png') })
    await page.locator('#btn-start-scan').click()

    let done = false
    for (let i = 0; i < 1100; i += 1) {
      const progress = await (await request.get('/api/scan/progress')).json()
      if (progress.status === 'done') { done = true; break }
      if (progress.status === 'error') throw new Error(`scan error: ${JSON.stringify(progress)}`)
      await page.waitForTimeout(500)
    }
    expect(done).toBe(true)
  }

  await openGallery(page)
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible({ timeout: 60000 })
  const countAll = await page.locator('#count-all').textContent()
  await page.screenshot({ path: shot('00b-gallery-after-scan.png') })
  console.log(`[audit] gen-tab ALL count after scan: ${countAll}`)
  expect(Number((countAll || '0').replace(/\D/g, ''))).toBeGreaterThanOrEqual(500)
})

// ---------------------------------------------------------------------------
// 01 — fake-tag everything (SD_IMAGE_SORTER_E2E_FAKE_TAGGER=1) so tag flows work
// ---------------------------------------------------------------------------
test('01 tag all images with the (fake) tagger via UI', async ({ page, request }) => {
  test.setTimeout(600000)
  await openGallery(page)

  const tagsBefore = await (await request.get('/api/tags/library?limit=5')).json().catch(() => null)
  const alreadyTagged = Array.isArray(tagsBefore?.tags) && tagsBefore.tags.length > 0

  if (!alreadyTagged) {
    // Power-user observation: with a token selection ("select all matching")
    // the batch Tag button is disabled by design; global AI Tag is the path.
    await page.locator('#btn-tag').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()
    await page.locator('#tag-model-select').selectOption('wd-swinv2-tagger-v3').catch(() => {})
    await page.screenshot({ path: shot('01b-tag-modal.png') })
    await page.locator('#btn-start-tag').click()

    let done = false
    for (let i = 0; i < 1100; i += 1) {
      const progress = await (await request.get('/api/tag/progress')).json()
      if (progress.status === 'done' || progress.status === 'completed') { done = true; break }
      if (progress.status === 'error') throw new Error(`tag error: ${JSON.stringify(progress)}`)
      await page.waitForTimeout(500)
    }
    expect(done).toBe(true)
    await page.keyboard.press('Escape')
  }

  // Poll rather than a single read: the tag worker commits in a child process,
  // and /api/tag/progress can flip to "done" a beat before those rows are visible
  // to a fresh /api/tags/library connection. The single read was flaky under
  // full-suite load (passed in isolation); polling absorbs the commit race.
  await expect
    .poll(
      async () => {
        const r = await request.get('/api/tags/library?limit=5')
        const j = await r.json().catch(() => null)
        return Array.isArray(j?.tags) ? j.tags.length : 0
      },
      { timeout: 15000, message: 'tag library should surface tags after the tag job reports done' },
    )
    .toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// 02 — Search v2 query language
// ---------------------------------------------------------------------------
test('02 search v2: operators, zh key, negation, illegal value, help, filter btn', async ({ page }) => {
  test.setTimeout(180000)
  await openGallery(page)
  const input = page.locator('#gallery-search-input')

  // -- score>=7 (no aesthetic scores in this DB -> 0 results is legitimate,
  //    but the filter must actually apply)
  await input.fill('score>=7')
  await expect(page.locator('#gallery-search-preview')).toBeVisible()
  await page.screenshot({ path: shot('02a-score-preview.png') })
  await input.press('Enter')
  await expect.poll(async () => (await filterState(page)).minAesthetic).toBe(7)

  // -- range + zh key + negation compound
  await input.fill('宽>=1024 rating:e -tag:blurry')
  await input.press('Enter')
  await expect.poll(async () => (await filterState(page)).minWidth).toBe(1024)
  const st = await filterState(page)
  expect(st.excludeTags).toContain('blurry')
  expect(st.ratings).toEqual(['explicit'])
  // Instrument: does the sidebar summary reflect the box-applied filters,
  // immediately and after a settle window (i18n refresh clobber check)?
  const summaryNow = await page.evaluate(() => (document.getElementById('summary-ratings') || {}).textContent)
  await page.waitForTimeout(1500)
  const summaryLater = await page.evaluate(() => (document.getElementById('summary-ratings') || {}).textContent)
  console.log(`[audit] summary-ratings immediately='${summaryNow}' after1.5s='${summaryLater}' (filters.ratings=explicit)`)
  await page.screenshot({ path: shot('02b-compound-applied.png') })

  // -- illegal value -> warning chip listing legal values
  await page.locator('#gallery-search-clear').click()
  await input.fill('color:sparkly')
  const warn = page.locator('#gallery-search-preview .gsq-chip-warn')
  await expect(warn).toBeVisible()
  const warnText = await warn.textContent()
  console.log(`[audit] warn chip text: ${warnText}`)
  await page.screenshot({ path: shot('02c-illegal-value-warn.png') })

  // -- help modal
  await page.locator('#btn-search-help').click()
  await expect(page.locator('#search-help-modal')).toBeVisible()
  await page.screenshot({ path: shot('02d-help-modal.png') })
  await page.locator('#btn-close-search-help').click()

  // -- filter button beside the box
  await page.locator('#btn-toolbar-filters').click()
  await expect(page.locator('#filter-modal')).toBeVisible()
  await page.screenshot({ path: shot('02e-filter-modal.png') })
  await page.locator('#btn-close-filter-modal').click()

  // -- danbooru-style autocomplete
  await input.fill('')
  await input.click()
  await input.pressSequentially('tag:1gir', { delay: 30 })
  const suggest = page.locator('#gallery-search-suggest')
  await expect(suggest).toBeVisible({ timeout: 5000 })
  await page.screenshot({ path: shot('02f-autocomplete.png') })
  const firstSuggestion = await suggest.locator('.gsq-suggest-item').first().textContent()
  console.log(`[audit] first suggestion for tag:1gir -> ${firstSuggestion}`)
  await input.press('Escape')
  await page.locator('#gallery-search-clear').click()
})

// ---------------------------------------------------------------------------
// 03 — filter sidebar: generator tabs, ratings, resolution, combinations
// ---------------------------------------------------------------------------
test('03 filter sidebar and filter modal combinations', async ({ page }) => {
  test.setTimeout(180000)
  await openGallery(page)

  // Generator tabs: click NAI, count must match the tab badge.
  const naiBadge = Number(((await page.locator('#count-nai').textContent()) || '0').replace(/\D/g, ''))
  const comfyBadge = Number(((await page.locator('#count-comfyui').textContent()) || '0').replace(/\D/g, ''))
  console.log(`[audit] gen badges nai=${naiBadge} comfyui=${comfyBadge}`)
  await page.locator('.gen-tab[data-gen="nai"]').click()
  await expect.poll(async () => (await filterState(page)).generators).toEqual(['nai'])
  await page.waitForTimeout(1500)
  await page.screenshot({ path: shot('03a-gen-nai.png') })

  // Filter modal: resolution >= 1024 wide + rating restriction on top of NAI.
  await page.locator('#btn-toolbar-filters').click()
  await expect(page.locator('#filter-modal')).toBeVisible()
  await page.locator('#filter-min-width').fill('1024')
  await page.screenshot({ path: shot('03b-filter-modal-res.png') })
  await page.locator('#btn-apply-modal-filters').click()
  await expect.poll(async () => (await filterState(page)).minWidth).toBe(1024)
  await page.waitForTimeout(1000)
  await page.screenshot({ path: shot('03c-nai-plus-width.png') })

  // Sidebar summary rows single-line check (§filter-sidebar).
  const rows = await page.evaluate(() => {
    const out: Array<{ id: string; height: number; lineHeight: number; text: string }> = []
    document.querySelectorAll('#sidebar-body-filters .summary-value').forEach((el) => {
      const cs = getComputedStyle(el as HTMLElement)
      const lh = parseFloat(cs.lineHeight) || 18
      out.push({
        id: (el as HTMLElement).id || '(anon)',
        height: (el as HTMLElement).getBoundingClientRect().height,
        lineHeight: lh,
        text: ((el as HTMLElement).textContent || '').slice(0, 40),
      })
    })
    return out
  })
  console.log(`[audit] summary rows: ${JSON.stringify(rows)}`)
  const multiline = rows.filter((r) => r.height > r.lineHeight * 1.9)
  expect(multiline, `multi-line summary rows: ${JSON.stringify(multiline)}`).toEqual([])

  // Reset via gen tab ALL + clearing width in the modal.
  await page.locator('.gen-tab[data-gen="all"]').click()
  await page.locator('#btn-toolbar-filters').click()
  await page.locator('#filter-min-width').fill('')
  await page.locator('#btn-apply-modal-filters').click()
})

// ---------------------------------------------------------------------------
// 04 — filter presets: save -> reload -> apply
// ---------------------------------------------------------------------------
test('04 filter presets survive a reload', async ({ page }) => {
  test.setTimeout(180000)
  await openGallery(page)

  // Arm a distinctive combination via the search box, then save it as preset.
  const input = page.locator('#gallery-search-input')
  await input.fill('gen:nai rating:e')
  await input.press('Enter')
  await expect.poll(async () => (await filterState(page)).generators).toEqual(['nai'])

  await page.locator('#btn-toolbar-filters').click()
  await expect(page.locator('#filter-modal')).toBeVisible()
  await page.locator('#filter-preset-name').fill('audit-p5-preset')
  await page.locator('#btn-save-filter-preset').click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: shot('04a-preset-saved.png') })
  await page.locator('#btn-close-filter-modal').click()

  // Reload — filters persist by design; clear them, then re-apply via preset.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openGallery(page)
  await page.locator('#btn-clear-filters').click()
  await expect.poll(async () => (await filterState(page)).generators.length).toBeGreaterThan(1)

  await page.locator('#btn-toolbar-filters').click()
  await expect(page.locator('#filter-modal')).toBeVisible()
  const presetChip = page.locator('#filter-presets-list', { hasText: 'audit-p5-preset' })
  await expect(presetChip).toBeVisible()
  await page.screenshot({ path: shot('04b-preset-after-reload.png') })
  await page.locator('#filter-presets-list [data-preset-action="load"][data-preset-name="audit-p5-preset"]').click()
  await page.waitForTimeout(500)
  const applied = await filterState(page)
  console.log(`[audit] preset applied -> generators=${JSON.stringify(applied.generators)} ratings=${JSON.stringify(applied.ratings)}`)
  expect(applied.generators).toEqual(['nai'])
  expect(applied.ratings).toEqual(['explicit'])
  // Loading a preset closes the modal on its own; close only if still open.
  if (await page.locator('#filter-modal.visible').isVisible().catch(() => false)) {
    await page.locator('#btn-close-filter-modal').click()
  }
  await page.screenshot({ path: shot('04c-preset-applied.png') })

  // cleanup filters
  await page.locator('.gen-tab[data-gen="all"]').click()
  await page.locator('#gallery-search-clear').click().catch(() => {})
})

// ---------------------------------------------------------------------------
// 05 — collections: create, bulk add, browse, delete
// ---------------------------------------------------------------------------
test('05 collections lifecycle', async ({ page, request }) => {
  test.setTimeout(180000)
  await openGallery(page)

  // Create via sidebar + input modal.
  await page.locator('#btn-new-collection').click()
  await expect(page.locator('#input-modal.visible, #input-modal:visible').first()).toBeVisible()
  await page.locator('#input-modal-field').fill('audit-p5-col')
  await page.screenshot({ path: shot('05a-new-collection-modal.png') })
  await page.locator('#input-modal .btn-primary, #btn-input-ok').first().click()
  await expect(page.locator('#collections-list .collection-row-name', { hasText: 'audit-p5-col' })).toBeVisible()

  // Bulk-add 3 selected images.
  await selectFirstN(page, 3)
  await expect(page.locator('#gallery-action-bar')).toBeVisible()
  await page.locator('#btn-add-selected-to-collection').click()
  const picker = page.locator('.collections-picker-menu')
  await expect(picker).toBeVisible()
  await page.screenshot({ path: shot('05b-collection-picker.png') })
  await picker.locator('button', { hasText: 'audit-p5-col' }).first().click()
  await page.waitForTimeout(800)
  // Exit selection mode so later clicks behave normally.
  await page.locator('#btn-toggle-select').click()
  await expect.poll(async () => await page.evaluate(() => Boolean((window as any).App.AppState.selectionMode))).toBe(false)

  // Sidebar count = 3 and browsing shows exactly 3 items.
  const row = page.locator('#collections-list .collection-row', { hasText: 'audit-p5-col' })
  await expect(row.locator('.collection-row-count')).toHaveText('3')
  await row.locator('.collection-row-open').click()
  await expect.poll(async () => (await filterState(page)).collectionId).not.toBe(null)
  await page.waitForTimeout(1200)
  const shown = await galleryItemCount(page)
  console.log(`[audit] collection browse shows ${shown} items`)
  await page.screenshot({ path: shot('05c-collection-browse.png') })
  expect(shown).toBe(3)

  // Remove one image from the collection (context menu while browsing).
  await page.locator('#gallery-grid .gallery-item').first().click({ button: 'right' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: shot('05d-context-menu-in-collection.png') })
  const ctxRemove = page.locator('.gallery-context-menu button', { hasText: /collection|收藏|合集/i })
  const ctxCount = await ctxRemove.count()
  console.log(`[audit] context menu collection-related entries: ${ctxCount}`)
  const ctxAll = await page.locator('.gallery-context-menu button').allTextContents().catch(() => [])
  console.log(`[audit] context entries: ${JSON.stringify(ctxAll)}`)
  await page.keyboard.press('Escape')

  // Stop browsing, delete the collection.
  await page.locator('#collections-clear-browse').click().catch(() => {})
  await page.waitForTimeout(500)
  await row.locator('[data-action="delete"]').click()
  await expect(page.locator('#confirm-modal.visible, #confirm-modal:visible').first()).toBeVisible()
  await page.screenshot({ path: shot('05e-delete-confirm.png') })
  await page.locator('#btn-confirm-ok').click()
  await expect(page.locator('#collections-list .collection-row-name', { hasText: 'audit-p5-col' })).toHaveCount(0)

  // clear selection leftovers
  await page.locator('#btn-clear-selection').click().catch(() => {})
})

// ---------------------------------------------------------------------------
// 06 — star ratings: set in detail modal, filter by min-star
// ---------------------------------------------------------------------------
test('06 star rating set + min-star filter', async ({ page, request }) => {
  test.setTimeout(180000)
  await openGallery(page)

  // Open first image detail modal.
  const firstCard = page.locator('#gallery-grid .gallery-item').first()
  const imageId = await firstCard.getAttribute('data-image-id')
  await firstCard.click()
  await expect(page.locator('#image-modal.visible, #image-modal:visible').first()).toBeVisible()
  const ratingGroup = page.locator('#modal-user-rating')
  await expect(ratingGroup).toBeVisible()
  await page.screenshot({ path: shot('06a-detail-modal-stars.png') })

  // Click the 4th star.
  const stars = ratingGroup.locator('button, [role="radio"], .star')
  const starCount = await stars.count()
  console.log(`[audit] star elements in radiogroup: ${starCount}`)
  await stars.nth(3).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: shot('06b-stars-set.png') })
  await page.keyboard.press('Escape')

  // Verify persisted via API.
  if (imageId) {
    const detail = await (await request.get(`/api/images/${imageId}`)).json().catch(() => null)
    console.log(`[audit] image ${imageId} user_rating after click: ${detail?.user_rating ?? detail?.image?.user_rating}`)
  }

  // Filter by min-star via the filter modal.
  await page.locator('#btn-toolbar-filters').click()
  await expect(page.locator('#filter-modal')).toBeVisible()
  await page.locator('#filter-user-rating-min').selectOption('4')
  await page.locator('#btn-apply-modal-filters').click()
  await expect.poll(async () => (await filterState(page)).minUserRating).toBe(4)
  await page.waitForTimeout(1200)
  const shown = await galleryItemCount(page)
  console.log(`[audit] min-star=4 gallery shows ${shown}`)
  await page.screenshot({ path: shot('06c-min-star-filter.png') })
  expect(shown).toBe(1)

  // reset (option value for "Any" may be '' or '0')
  await page.locator('#btn-toolbar-filters').click()
  const anyValue = await page.evaluate(() => {
    const sel = document.getElementById('filter-user-rating-min') as HTMLSelectElement | null
    return sel ? sel.options[0].value : ''
  })
  await page.locator('#filter-user-rating-min').selectOption(anyValue)
  await page.locator('#btn-apply-modal-filters').click()
})

// ---------------------------------------------------------------------------
// 07 — publish set (成套发布) via gallery batch bar; export to .tmp only
// ---------------------------------------------------------------------------
test('07 publish set export writes real files', async ({ page }) => {
  test.setTimeout(180000)
  await openGallery(page)
  fsSync.rmSync(PUB_OUT, { recursive: true, force: true })

  // More menu must NOT have it (removed by design) — the batch bar has it.
  await page.locator('#nav-tools-toggle').click()
  const moreHas = await page.locator('#nav-tools-publish-set').count()
  console.log(`[audit] publish-set in More menu (expected 0): ${moreHas}`)
  await page.keyboard.press('Escape')

  await selectFirstN(page, 3)
  await expect(page.locator('#gallery-action-bar')).toBeVisible()
  await page.locator('#btn-gallery-action-more').click()
  await expect(page.locator('#gallery-action-more-menu')).toBeVisible()
  await page.screenshot({ path: shot('07a-action-more-menu.png') })
  await page.locator('#btn-publish-selected').click()
  await expect(page.locator('#publish-set-modal.visible')).toBeVisible()
  await expect(page.locator('.pub-item')).toHaveCount(3)
  await page.screenshot({ path: shot('07b-publish-workbench.png') })

  await page.locator('#pub-folder').fill(PUB_OUT)
  await page.locator('#pub-caption').fill('audit p5 caption')
  await page.locator('#btn-pub-export').click()
  await expect(page.locator('.pub-result-line.pub-result-ok')).toBeVisible({ timeout: 30000 })
  await page.screenshot({ path: shot('07c-publish-result.png') })

  await expect.poll(() => fsSync.existsSync(path.join(PUB_OUT, '01.png'))
    || fsSync.existsSync(path.join(PUB_OUT, '01.jpg'))
    || fsSync.existsSync(path.join(PUB_OUT, '01.jpeg'))
    || fsSync.existsSync(path.join(PUB_OUT, '01.webp'))).toBe(true)
  const outFiles = fsSync.readdirSync(PUB_OUT)
  console.log(`[audit] publish out files: ${JSON.stringify(outFiles)}`)
  expect(outFiles.some((f) => f.startsWith('caption'))).toBe(true)
  expect(outFiles.length).toBeGreaterThanOrEqual(4)

  await page.keyboard.press('Escape')
  await page.locator('#btn-clear-selection').click().catch(() => {})
})

// ---------------------------------------------------------------------------
// 08 — Prompt Lab build: caret-aware insert + copy
// ---------------------------------------------------------------------------
test('08 prompt lab build insert mode', async ({ page }) => {
  test.setTimeout(180000)
  await openGallery(page)
  if (await page.locator('#nav-tab-promptlab').isVisible().catch(() => false)) {
    await page.locator('#nav-tab-promptlab').click()
  } else {
    await page.locator('#nav-tools-toggle').click()
    await page.locator('#nav-tools-promptlab').click()
  }
  await expect(page.locator('#view-promptlab')).toBeVisible()
  await page.locator('.promptlab-tab[data-mode="build"]').click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: shot('08a-promptlab-build.png') })

  // Manually seed the textarea (editor may be hidden until a source loads).
  const editorVisible = await page.locator('#pl-build-editor').isVisible()
  console.log(`[audit] pl-build-editor visible before source pick: ${editorVisible}`)
  if (!editorVisible) {
    // pick the first available source from the dropdown if any
    const options = await page.locator('#pl-build-source option').count()
    console.log(`[audit] pl-build-source options: ${options}`)
    if (options > 1) {
      const value = await page.locator('#pl-build-source option').nth(1).getAttribute('value')
      if (value) await page.locator('#pl-build-source').selectOption(value)
      await page.waitForTimeout(1000)
    }
  }
  const editorNow = await page.locator('#pl-build-editor').isVisible()
  await page.screenshot({ path: shot('08b-promptlab-editor.png') })

  if (editorNow) {
    const ta = page.locator('#pl-build-prompt')
    await ta.fill('solo, (long hair:1.2), blue')
    // caret at very end; type a partial tag and accept the first suggestion
    await ta.click()
    await ta.press('End')
    await ta.pressSequentially(', 1gir', { delay: 40 })
    await page.waitForTimeout(1200)
    await page.screenshot({ path: shot('08c-promptlab-autocomplete.png') })
    const dropdown = page.locator('.caption-autocomplete-dropdown')
    const hasDropdown = await dropdown.isVisible().catch(() => false)
    console.log(`[audit] promptlab autocomplete dropdown visible: ${hasDropdown}`)
    if (hasDropdown) {
      const items = await dropdown.locator('*').allTextContents().catch(() => [])
      console.log(`[audit] dropdown items: ${JSON.stringify(items.slice(0, 6))}`)
      await ta.press('Enter')
      const value = await ta.inputValue()
      console.log(`[audit] textarea after accept: ${value}`)
      // weight syntax must remain intact
      expect(value).toContain('(long hair:1.2)')
    }
    // copy
    await page.locator('#pl-build-copy').click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: shot('08d-promptlab-copy.png') })
  }
})

// ---------------------------------------------------------------------------
// 09 — similarity search without CLIP model: must be honest
// ---------------------------------------------------------------------------
test('09 similarity view honesty without CLIP', async ({ page }) => {
  test.setTimeout(180000)
  await openGallery(page)
  await page.locator('#nav-tab-similar').click()
  await expect(page.locator('#view-similar')).toBeVisible()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: shot('09a-similar-view.png') })

  const embedBtn = page.locator('#btn-similar-embed')
  if (await embedBtn.isVisible().catch(() => false)) {
    await embedBtn.click()
    await page.waitForTimeout(4000)
    await page.screenshot({ path: shot('09b-similar-embed-clicked.png') })
    const text = await page.locator('#similar-embed-text').textContent().catch(() => '')
    console.log(`[audit] embed status text: ${text}`)
    const toasts = await page.locator('.toast').allTextContents().catch(() => [])
    console.log(`[audit] toasts: ${JSON.stringify(toasts)}`)
  } else {
    console.log('[audit] embed button not visible; capturing view state')
  }
  await page.waitForTimeout(4000)
  await page.screenshot({ path: shot('09c-similar-after-wait.png') })
})

// ---------------------------------------------------------------------------
// 10 — duplicate cleanup preview honesty (STOP before any delete)
// ---------------------------------------------------------------------------
test('10 duplicate cleanup preview', async ({ page }) => {
  test.setTimeout(180000)
  await openGallery(page)
  await page.locator('#nav-tools-toggle').click()
  await expect(page.locator('#nav-tools-menu')).toBeVisible()
  await page.locator('#nav-tools-dup-cleaner').click()
  await expect(page.locator('#dup-cleaner-modal.visible, #dup-cleaner-modal:visible').first()).toBeVisible()
  await page.screenshot({ path: shot('10a-dup-modal.png') })

  await page.locator('#btn-dup-scan').click()
  await page.waitForTimeout(3000)
  await page.screenshot({ path: shot('10b-dup-scan-running.png') })
  // wait up to 60s for scan to settle
  for (let i = 0; i < 60; i += 1) {
    const progressHidden = await page.locator('#dup-scan-progress').isHidden().catch(() => true)
    const summaryVisible = await page.locator('#dup-summary').isVisible().catch(() => false)
    const emptyVisible = await page.locator('#dup-empty').isVisible().catch(() => false)
    if ((progressHidden && (summaryVisible || emptyVisible)) || summaryVisible) break
    await page.waitForTimeout(1000)
  }
  await page.screenshot({ path: shot('10c-dup-scan-done.png') })
  const summary = await page.locator('#dup-summary-text').textContent().catch(() => '')
  const empty = await page.locator('#dup-empty').textContent().catch(() => '')
  const toasts = await page.locator('.toast').allTextContents().catch(() => [])
  console.log(`[audit] dup summary: ${summary} | empty: ${(empty || '').trim().slice(0, 120)} | toasts: ${JSON.stringify(toasts)}`)
  // STOP HERE — never touch apply/delete buttons.
  await page.keyboard.press('Escape')
})

// ---------------------------------------------------------------------------
// 11 — tags & prompts library modal: tabs populated, click-to-filter
// ---------------------------------------------------------------------------
test('11 library modal tabs + click filters gallery', async ({ page }) => {
  test.setTimeout(180000)
  await openGallery(page)
  await page.locator('#btn-tags-library').click()
  await expect(page.locator('#tags-library-modal.visible, #tags-library-modal:visible').first()).toBeVisible()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: shot('11a-library-tags.png') })
  const tagsContent = ((await page.locator('#library-content').textContent()) || '').trim()
  console.log(`[audit] library tags tab first 120 chars: ${tagsContent.slice(0, 120)}`)

  await page.locator('#library-tab-loras').click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: shot('11b-library-loras.png') })
  const loraCount = await page.locator('#library-content .library-tag').count()
  console.log(`[audit] lora entries rendered: ${loraCount}`)

  await page.locator('#library-tab-checkpoints').click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: shot('11c-library-checkpoints.png') })
  const ckptEntries = page.locator('#library-content .library-tag')
  const ckptCount = await ckptEntries.count()
  console.log(`[audit] checkpoint entries rendered: ${ckptCount}`)

  if (ckptCount > 0) {
    await ckptEntries.first().click()
    await page.waitForTimeout(1500)
    const modalStillOpen = await page.locator('#tags-library-modal.visible').isVisible().catch(() => false)
    const st = await filterState(page)
    console.log(`[audit] after checkpoint click: modalOpen=${modalStillOpen} checkpoints=${JSON.stringify(st.checkpoints)} tags=${JSON.stringify(st.tags)}`)
    await page.screenshot({ path: shot('11d-library-after-click.png') })
    if (modalStillOpen) {
      await page.locator('#btn-close-tags-library').click()
    }
    await page.waitForTimeout(1200)
    const shown = await galleryItemCount(page)
    console.log(`[audit] gallery items after checkpoint filter: ${shown}`)
    await page.screenshot({ path: shot('11e-gallery-after-library-click.png') })
    expect(st.checkpoints.length).toBeGreaterThan(0)
  }
})
