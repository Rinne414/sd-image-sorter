import { expect, test, type Page } from '../fixtures/click-ledger'

test.describe.configure({ mode: 'serial' })

type IssueKind =
  | 'file_missing'
  | 'image_unreadable'
  | 'empty_caption'
  | 'small_image'
  | 'low_aesthetic'
  | 'duplicate_group'
  | 'rating_conflict'
  | 'low_tag_confidence'
  | 'metadata_provenance_risk'
  | 'sidecar_metadata_dependency'

type ReviewIssue = {
  issue_id: string
  kind: IssueKind
  severity: 'high' | 'medium' | 'low'
  title_en: string
  title_zh: string
  detail_en: string
  detail_zh: string
  subjects: Array<{ image_id: number; filename: string | null; source_path: string | null }>
  evidence: Array<{ label_en: string; label_zh: string; value_en: string; value_zh: string }>
  source_provider: 'database' | 'caption_states' | 'persisted_duplicates' | 'metadata_provenance'
  evidence_status: 'available' | 'partial' | 'not_available'
  heuristic: boolean
  action: {
    kind: 'open_image'
    availability: 'available' | 'not_available'
    reason_en: string
    reason_zh: string
  }
}

const ALL_KINDS: IssueKind[] = [
  'file_missing',
  'image_unreadable',
  'empty_caption',
  'small_image',
  'low_aesthetic',
  'duplicate_group',
  'rating_conflict',
  'low_tag_confidence',
  'metadata_provenance_risk',
  'sidecar_metadata_dependency',
]

const REVIEW_PROVIDERS = [
  'scope',
  'file_integrity',
  'caption_integrity',
  'dimensions',
  'aesthetic_scores',
  'persisted_duplicates',
  'tag_integrity',
  'metadata_provenance',
] as const

function issue(
  issueId: string,
  kind: IssueKind,
  imageId: number,
  title: string,
): ReviewIssue {
  return {
    issue_id: issueId,
    kind,
    severity: kind === 'file_missing' ? 'high' : 'medium',
    title_en: title,
    title_zh: `ZH ${title}`,
    detail_en: `${title} detail`,
    detail_zh: `ZH ${title} detail`,
    subjects: [{
      image_id: imageId,
      filename: imageId === 901 ? 'review-a.png' : 'review-b.png',
      source_path: `C:/source/review-${imageId}.png`,
    }],
    evidence: [{
      label_en: 'Observed',
      label_zh: '观察值',
      value_en: title,
      value_zh: `中文 ${title}`,
    }],
    source_provider: kind === 'empty_caption'
      ? 'caption_states'
      : kind === 'metadata_provenance_risk' || kind === 'sidecar_metadata_dependency'
        ? 'metadata_provenance'
        : 'database',
    evidence_status: 'available',
    heuristic: kind === 'rating_conflict' || kind === 'low_tag_confidence',
    action: {
      kind: 'open_image',
      availability: 'available',
      reason_en: '',
      reason_zh: '',
    },
  }
}

function response(
  issues: ReviewIssue[],
  total: number,
  nextCursor: string | null,
  providerStatus: 'available' | 'partial' | 'not_available' | 'not_requested' = 'available',
  tagIntegrityStatus: 'available' | 'not_requested' = 'available',
) {
  return {
    schema_version: 1,
    scope_fingerprint: 'a'.repeat(64),
    issues,
    total,
    has_more: nextCursor !== null,
    next_cursor: nextCursor,
    provider_states: REVIEW_PROVIDERS.map((provider) => ({
      provider,
      status: provider === 'caption_integrity'
        ? providerStatus
        : provider === 'tag_integrity'
          ? tagIntegrityStatus
          : 'available',
      reason_en: provider === 'caption_integrity' && providerStatus === 'partial'
        ? 'Local path items are not covered.'
        : provider === 'tag_integrity' && tagIntegrityStatus === 'not_requested'
          ? 'Rating-tag integrity was not requested.'
          : '',
      reason_zh: provider === 'caption_integrity' && providerStatus === 'partial'
        ? '本地路径项目未覆盖。'
        : provider === 'tag_integrity' && tagIntegrityStatus === 'not_requested'
          ? '未请求 Rating 标签完整性检查。'
          : '',
      observed_at: null,
    })),
  }
}

async function boot(page: Page) {
  await page.route(/\/api\/images\/(?:901|902)(?:\?.*)?$/, (route) => {
    const imageId = Number(new URL(route.request().url()).pathname.split('/').pop())
    return route.fulfill({
      json: {
        id: imageId,
        filename: imageId === 901 ? 'review-a.png' : 'review-b.png',
        path: `C:/source/review-${imageId}.png`,
        width: 1024,
        height: 1024,
      },
    })
  })
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/tags/scores/stats', (route) => route.fulfill({
    json: {
      enabled: true,
      floor: 0.15,
      total_rows: 0,
      images_with_scores: 0,
      models: [],
      estimated_bytes: 0,
    },
  }))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => (
    typeof (window as any).DatasetMaker?._setActive === 'function'
    && !!(window as any).SeparationConsole
  ))
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [901, 902]
    dm.meta.set(901, { filename: 'review-a.png', abs_path: 'C:/source/review-901.png', width: 1024, height: 1024 })
    dm.meta.set(902, { filename: 'review-b.png', abs_path: 'C:/source/review-902.png', width: 1024, height: 1024 })
    dm.captions.set(901, '1girl, standing')
    dm.captions.set(902, '')
    ;(window as any).App.switchView('dataset')
    dm._setActive(901)
  })
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-separation-console summary').click()
}

async function openIssues(page: Page) {
  await page.getByTestId('review-cockpit-tab-issues').click()
  await expect(page.getByTestId('review-cockpit-issues')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('empty database scope fails explicitly in the active language', async ({ page }) => {
  await boot(page)
  await openIssues(page)
  await page.locator('#btn-language-toggle').click()
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = []
    dm.meta.clear()
    dm.captions.clear()
    window.dispatchEvent(new CustomEvent('dataset:changed'))
  })
  await page.getByTestId('review-cockpit-refresh').click()

  await expect(page.getByTestId('review-cockpit-error')).toContainText(
    '审阅驾驶舱至少需要一张已加载的数据库图片。',
  )

  await page.locator('#btn-language-toggle').click()
  await expect(page.getByTestId('review-cockpit-error')).toContainText(
    'Review Cockpit needs at least one loaded database image.',
  )
})

test('HTTP detail matching a local error code remains server text across languages', async ({ page }) => {
  await page.route('**/api/dataset/review-queue', (route) => route.fulfill({
    status: 503,
    json: { detail: 'empty_database_scope' },
  }))
  await boot(page)
  await openIssues(page)

  const message = page.locator('#sepcon-issues-error-message')
  await expect(message).toHaveText('empty_database_scope')
  await page.locator('#btn-language-toggle').click()
  await expect(message).toHaveText('empty_database_scope')
})

test('Issues posts the complete current-session evidence contract', async ({ page }) => {
  let capturedBody: Record<string, unknown> | null = null
  await page.route('**/api/dataset/review-queue', async (route) => {
    capturedBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      json: response([issue('issue-empty-902', 'empty_caption', 902, 'Empty caption')], 1, null),
    })
  })

  await boot(page)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.captions.set(901, '')
    dm.nlCaptions.set(901, 'A subject standing in soft light.')
    dm.captionType.set(901, 'nl')
    dm.captions.set(902, '')
    dm.nlCaptions.set(902, 'A second subject looking at the camera.')
    dm.captionType.set(902, 'both')
  })
  await openIssues(page)

  await expect(page.getByTestId('review-cockpit-tab-issues')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('review-cockpit-issue')).toHaveCount(1)
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Empty caption')
  await expect.poll(() => capturedBody).not.toBeNull()
  expect(capturedBody).toEqual({
    schema_version: 1,
    image_ids: [901, 902],
    caption_states: [
      { image_id: 901, has_content: true },
      { image_id: 902, has_content: true },
    ],
    logical_count: 2,
    local_path_count: 0,
    minimum_dimension: null,
    minimum_aesthetic: null,
    include_persisted_duplicates: true,
    issue_kinds: ALL_KINDS,
    cursor: null,
    limit: 25,
  })
})

test('caption edits invalidate the loaded issue queue before returning from Tags', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/api/dataset/review-queue', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    const captions = body.caption_states as Array<{ image_id: number; has_content: boolean }>
    const imageHasContent = captions.find((row) => row.image_id === 902)?.has_content === true
    await route.fulfill({
      json: imageHasContent
        ? response([], 0, null)
        : response([issue('issue-empty-902', 'empty_caption', 902, 'Empty caption')], 1, null),
    })
  })

  await boot(page)
  await openIssues(page)
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Empty caption')
  await page.getByTestId('review-cockpit-tab-tags').click()
  await page.evaluate(() => {
    ;(window as any).DatasetMaker.captionEdits.set(902, 'fixed caption')
  })
  await page.getByTestId('review-cockpit-tab-issues').click()

  await expect(page.getByTestId('review-cockpit-empty')).toBeVisible()
  expect(bodies).toHaveLength(2)
  expect((bodies[1].caption_states as Array<{ image_id: number; has_content: boolean }>)[1]).toEqual({
    image_id: 902,
    has_content: true,
  })

  await page.getByTestId('review-cockpit-tab-tags').click()
  await page.evaluate(() => {
    ;(window as any).DatasetMaker.captionEdits.delete(902)
  })
  await page.getByTestId('review-cockpit-tab-issues').click()
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Empty caption')
  expect(bodies).toHaveLength(3)

  await page.getByTestId('review-cockpit-tab-tags').click()
  await page.evaluate(() => {
    const edits = (window as any).DatasetMaker.captionEdits
    edits.set(902, 'temporary caption')
    edits.clear()
  })
  await page.getByTestId('review-cockpit-tab-issues').click()
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Empty caption')
  expect(bodies).toHaveLength(4)
})

test('base booru and NL caption maps invalidate evidence once per update batch', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/api/dataset/review-queue', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    const captions = body.caption_states as Array<{ image_id: number; has_content: boolean }>
    const imageHasContent = captions.find((row) => row.image_id === 902)?.has_content === true
    await route.fulfill({
      json: imageHasContent
        ? response([], 0, null)
        : response([issue('issue-empty-902', 'empty_caption', 902, 'Empty caption')], 1, null),
    })
  })

  await boot(page)
  await openIssues(page)
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Empty caption')

  await page.evaluate(() => {
    ;(window as any).DatasetMaker.captions.set(902, 'base booru caption')
  })
  await expect(page.getByTestId('review-cockpit-empty')).toBeVisible()
  await expect.poll(() => bodies.length).toBe(2)
  await page.waitForTimeout(550)
  expect(bodies).toHaveLength(2)

  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.captions.set(902, '')
    dm.nlCaptions.set(902, 'Natural language evidence for auto mode.')
    dm.captionType.delete(902)
  })
  await expect.poll(() => bodies.length).toBe(3)
  await expect(page.getByTestId('review-cockpit-empty')).toBeVisible()
  expect((bodies[2].caption_states as Array<{ image_id: number; has_content: boolean }>)[1]).toEqual({
    image_id: 902,
    has_content: true,
  })
  await page.waitForTimeout(550)
  expect(bodies).toHaveLength(3)

  await page.evaluate(() => {
    ;(window as any).DatasetMaker.nlCaptions.set(902, '')
  })
  await expect.poll(() => bodies.length).toBe(4)
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Empty caption')
})

test('an in-flight stale response cannot overwrite newer caption evidence', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = []
  let releaseFirstResponse = () => {}
  let markFirstCompleted = () => {}
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve
  })
  const firstResponseCompleted = new Promise<void>((resolve) => {
    markFirstCompleted = resolve
  })
  await page.route('**/api/dataset/review-queue', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    if (bodies.length === 1) {
      await firstResponseGate
      await route.fulfill({
        json: response([issue('stale-empty-902', 'empty_caption', 902, 'Stale empty caption')], 1, null),
      })
      markFirstCompleted()
      return
    }
    await route.fulfill({ json: response([], 0, null) })
  })

  await boot(page)
  await openIssues(page)
  await expect.poll(() => bodies.length).toBe(1)
  await page.evaluate(() => {
    ;(window as any).DatasetMaker.captionEdits.set(902, 'new caption evidence')
  })
  await expect.poll(() => bodies.length).toBe(2)
  await expect(page.getByTestId('review-cockpit-empty')).toBeVisible()
  releaseFirstResponse()
  await firstResponseCompleted

  await expect(page.getByTestId('review-cockpit-issue')).toHaveCount(0)
  await expect(page.getByTestId('review-cockpit-empty')).toBeVisible()
})

test('Retry remains loading across language changes without resurfacing the stale page', async ({ page }) => {
  let attempt = 0
  let releaseRetry = () => {}
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve
  })
  await page.route('**/api/dataset/review-queue', async (route) => {
    attempt += 1
    if (attempt === 1) {
      await route.fulfill({
        json: response([issue('stale-page-902', 'empty_caption', 902, 'Stale page issue')], 1, null),
      })
      return
    }
    if (attempt === 2) {
      await route.fulfill({ status: 503, json: { detail: 'Review provider offline.' } })
      return
    }
    await retryGate
    await route.fulfill({
      json: response([issue('current-page-902', 'empty_caption', 902, 'Current page issue')], 1, null),
    })
  })

  await boot(page)
  await openIssues(page)
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Stale page issue')
  await page.getByTestId('review-cockpit-refresh').click()
  await expect(page.getByTestId('review-cockpit-error')).toContainText('Review provider offline.')

  await page.getByTestId('review-cockpit-retry').click()
  await expect(page.getByTestId('review-cockpit-issues')).toHaveAttribute('aria-busy', 'true')
  await page.locator('#btn-language-toggle').click()
  await expect(page.getByTestId('review-cockpit-issues')).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByTestId('review-cockpit-issue')).toHaveCount(0)
  await expect(page.locator('#sepcon-issues-state')).toHaveText('正在载入问题...')

  releaseRetry()
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('ZH Current page issue')
  expect(attempt).toBe(3)
})

test('manifest previews are not double-counted as direct local paths', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/api/dataset/review-queue', async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ json: response([], 0, null, 'partial') })
  })

  await boot(page)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [901, -101, -202]
    dm.isLocalId = (imageId: number) => imageId < 0
    dm._localIdUsesManifest = (imageId: number) => imageId === -202
    dm._getLogicalDatasetCount = () => 102
  })
  await openIssues(page)

  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0].image_ids).toEqual([901])
  expect(bodies[0].logical_count).toBe(102)
  expect(bodies[0].local_path_count).toBe(1)
})

test('filtering resets the cursor, pagination has no repeated page, and Open selects the subject image', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = []
  const firstPageIssues = Array.from({ length: 25 }, (_, index) => (
    issue(`issue-missing-${index}`, 'file_missing', 901, `Missing file ${index + 1}`)
  ))
  await page.route('**/api/dataset/review-queue', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    if (body.cursor === 'cursor-page-2') {
      await route.fulfill({
        json: response([issue('issue-empty-902', 'empty_caption', 902, 'Empty caption')], 26, null),
      })
      return
    }
    const kinds = body.issue_kinds as IssueKind[]
    if (kinds.length === 1 && kinds[0] === 'empty_caption') {
      await route.fulfill({
        json: response([issue('issue-empty-filtered', 'empty_caption', 902, 'Filtered empty caption')], 1, null),
      })
      return
    }
    await route.fulfill({
      json: response(firstPageIssues, 26, 'cursor-page-2'),
    })
  })

  await boot(page)
  await openIssues(page)
  await expect(page.getByTestId('review-cockpit-issue').first()).toContainText('Missing file 1')
  await expect(page.getByTestId('review-cockpit-next')).toBeEnabled()
  await page.getByTestId('review-cockpit-next').click()
  await expect.poll(() => bodies.length).toBe(2)
  await expect(page.getByTestId('review-cockpit-issue').first()).toContainText('Empty caption')
  expect(bodies.at(-1)?.cursor).toBe('cursor-page-2')

  await page.getByTestId('review-cockpit-open-image').click()
  await expect.poll(() => page.evaluate(() => (window as any).DatasetMaker.activeId)).toBe(902)

  await page.evaluate(() => {
    const select = document.getElementById('sepcon-issue-filter') as HTMLSelectElement
    select.value = 'caption'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Filtered empty caption')
  expect(bodies.at(-1)?.cursor).toBeNull()
  expect(bodies.at(-1)?.issue_kinds).toEqual(['empty_caption'])
})

test('Tag integrity requests persisted rating conflicts and opens the affected image', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/api/dataset/review-queue', async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      json: response([
        issue('rating_conflict:901', 'rating_conflict', 901, 'Conflicting rating tags'),
      ], 1, null),
    })
  })

  await boot(page)
  await openIssues(page)
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Conflicting rating tags')
  expect(bodies[0].issue_kinds).toEqual(ALL_KINDS)

  const filter = page.locator('#sepcon-issue-filter')
  const filterDisplay = page.locator(
    '[data-select-id="sepcon-issue-filter"] .dataset-custom-dropdown-display',
  )
  await filter.selectOption('tag_integrity', { force: true })

  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[1].issue_kinds).toEqual(['rating_conflict'])
  await expect(filterDisplay).toHaveText('Tag integrity')
  await page.getByTestId('review-cockpit-open-image').click()
  await expect.poll(() => page.evaluate(() => (window as any).DatasetMaker.activeId)).toBe(901)

  await page.locator('#btn-language-toggle').click()
  await expect(filterDisplay).toHaveText('标签完整性')
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('ZH Conflicting rating tags')
})

test('Low tag confidence has an independent bilingual filter and keeps rating filtering unchanged', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/api/dataset/review-queue', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    const kinds = body.issue_kinds as IssueKind[]
    const filtered = kinds.length === 1 && kinds[0] === 'low_tag_confidence'
    await route.fulfill({
      json: response(filtered ? [
        issue('low_tag_confidence:902', 'low_tag_confidence', 902, 'Low-confidence tags'),
      ] : [], filtered ? 1 : 0, null),
    })
  })

  await boot(page)
  await openIssues(page)
  expect(bodies[0].issue_kinds).toEqual(ALL_KINDS)

  const filter = page.locator('#sepcon-issue-filter')
  const filterDisplay = page.locator(
    '[data-select-id="sepcon-issue-filter"] .dataset-custom-dropdown-display',
  )
  await filter.selectOption('low_tag_confidence', { force: true })

  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[1].issue_kinds).toEqual(['low_tag_confidence'])
  await expect(filterDisplay).toHaveText('Low tag confidence')
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Low-confidence tags')

  await page.getByTestId('review-cockpit-open-image').click()
  await expect.poll(() => page.evaluate(() => (window as any).DatasetMaker.activeId)).toBe(902)

  await page.locator('#btn-language-toggle').click()
  await expect(filterDisplay).toHaveText('低置信度标签')
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('ZH Low-confidence tags')

  await filter.selectOption('tag_integrity', { force: true })
  await expect.poll(() => bodies.length).toBe(3)
  expect(bodies[2].issue_kinds).toEqual(['rating_conflict'])
})

test('Metadata provenance has a dedicated strict bilingual filter', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/api/dataset/review-queue', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    const kinds = body.issue_kinds as IssueKind[]
    const filtered = kinds.length === 1 && kinds[0] === 'metadata_provenance_risk'
    const metadataIssue = issue(
      'metadata_provenance_risk:902',
      'metadata_provenance_risk',
      902,
      'Persisted provenance needs review',
    )
    metadataIssue.evidence = [{
      label_en: 'Tag writer identity',
      label_zh: '标签写入器身份',
      value_en: 'huggingface / SmilingWolf/wd-swinv2-tagger-v3; runtime=CPUExecutionProvider; revision=sha256:abc123',
      value_zh: 'huggingface / SmilingWolf/wd-swinv2-tagger-v3；运行时=CPUExecutionProvider；版本=sha256:abc123',
    }]
    const payload = response(filtered ? [metadataIssue] : [], filtered ? 1 : 0, null)
    payload.provider_states = payload.provider_states.map((provider) => (
      provider.provider === 'metadata_provenance'
        ? {
            ...provider,
            reason_en: 'WD14 writer provenance is available for 1 image. Identity: huggingface/SmilingWolf/wd-swinv2-tagger-v3.',
            reason_zh: 'WD14 写入器来源已覆盖 1 张图片。身份：huggingface/SmilingWolf/wd-swinv2-tagger-v3。',
          }
        : provider
    ))
    await route.fulfill({
      json: payload,
    })
  })

  await boot(page)
  await openIssues(page)
  expect(bodies[0].issue_kinds).toEqual(ALL_KINDS)
  await expect(page.getByTestId('review-cockpit-filter-metadata-provenance')).toHaveAttribute(
    'value',
    'metadata_provenance',
  )

  const filter = page.locator('#sepcon-issue-filter')
  const filterDisplay = page.locator(
    '[data-select-id="sepcon-issue-filter"] .dataset-custom-dropdown-display',
  )
  await filter.selectOption('metadata_provenance', { force: true })

  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[1].issue_kinds).toEqual(['metadata_provenance_risk'])
  await expect(filterDisplay).toHaveText('Metadata provenance')
  await expect(page.getByTestId('review-cockpit-issue')).toContainText(
    'Persisted provenance needs review',
  )
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Tag writer identity')
  await expect(page.getByTestId('review-cockpit-issue')).toContainText(
    'SmilingWolf/wd-swinv2-tagger-v3',
  )
  await expect(page.getByTestId('review-cockpit-provider-state').filter({
    hasText: 'Metadata provenance',
  })).toContainText('WD14 writer provenance is available for 1 image')
  await expect(page.locator('.sepcon-issue-source')).toHaveText(
    'Metadata provenance · Available',
  )

  await page.locator('#btn-language-toggle').click()
  await expect(filterDisplay).toHaveText('元数据来源')
  await expect(page.getByTestId('review-cockpit-issue')).toContainText(
    'ZH Persisted provenance needs review',
  )
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('标签写入器身份')
  await expect(page.getByTestId('review-cockpit-provider-state').filter({
    hasText: '元数据来源',
  })).toContainText('WD14 写入器来源已覆盖 1 张图片')
  await expect(page.locator('.sepcon-issue-source')).toHaveText('元数据来源 · 可用')
})

test('Sidecar fallback has an independent bilingual evidence filter', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/api/dataset/review-queue', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    const kinds = body.issue_kinds as IssueKind[]
    const filtered = kinds.length === 1 && kinds[0] === 'sidecar_metadata_dependency'
    const sidecarIssue = issue(
      'sidecar_metadata_dependency:902',
      'sidecar_metadata_dependency',
      902,
      'Metadata depends on a sidecar fallback',
    )
    sidecarIssue.evidence = [
      {
        label_en: 'Sidecar carrier',
        label_zh: 'Sidecar 载体',
        value_en: 'JSON',
        value_zh: 'JSON',
      },
      {
        label_en: 'Affected fields',
        label_zh: '受影响字段',
        value_en: 'prompt, checkpoint',
        value_zh: 'prompt、checkpoint',
      },
      {
        label_en: 'Parser version',
        label_zh: '解析器版本',
        value_en: '7',
        value_zh: '7',
      },
    ]
    const payload = response(filtered ? [sidecarIssue] : [], filtered ? 1 : 0, null)
    payload.provider_states = payload.provider_states.map((provider) => (
      provider.provider === 'metadata_provenance'
        ? {
            ...provider,
            status: 'partial',
            reason_en: 'Sidecar fallback evidence is unevaluated for 1 image.',
            reason_zh: '1 张图片尚未评估 Sidecar 回退来源。',
          }
        : provider
    ))
    await route.fulfill({ json: payload })
  })

  await boot(page)
  await openIssues(page)
  expect(bodies[0].issue_kinds).toEqual(ALL_KINDS)
  await expect(page.getByTestId('review-cockpit-filter-sidecar-fallback')).toHaveAttribute(
    'value',
    'sidecar_fallback',
  )

  const filter = page.locator('#sepcon-issue-filter')
  const filterDisplay = page.locator(
    '[data-select-id="sepcon-issue-filter"] .dataset-custom-dropdown-display',
  )
  await filter.selectOption('sidecar_fallback', { force: true })

  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[1].issue_kinds).toEqual(['sidecar_metadata_dependency'])
  await expect(filterDisplay).toHaveText('Sidecar fallback')
  const issueRow = page.getByTestId('review-cockpit-issue')
  await expect(issueRow).toContainText('Metadata depends on a sidecar fallback')
  await expect(issueRow).toContainText('JSON')
  await expect(issueRow).toContainText('prompt, checkpoint')
  await expect(issueRow).toContainText('Parser version')
  await expect(page.getByTestId('review-cockpit-provider-state').filter({
    hasText: 'Metadata provenance',
  })).toContainText('Sidecar fallback evidence is unevaluated for 1 image.')

  await page.getByTestId('review-cockpit-open-image').click()
  await expect.poll(() => page.evaluate(() => (window as any).DatasetMaker.activeId)).toBe(902)

  await page.locator('#btn-language-toggle').click()
  await expect(filterDisplay).toHaveText('Sidecar 回退')
  await expect(issueRow).toContainText('ZH Metadata depends on a sidecar fallback')
  await expect(issueRow).toContainText('受影响字段')
  await expect(page.getByTestId('review-cockpit-provider-state').filter({
    hasText: '元数据来源',
  })).toContainText('1 张图片尚未评估 Sidecar 回退来源。')
})

test('provider limitations are explicit and Tags preserves the existing console surface', async ({ page }) => {
  await page.route('**/api/dataset/review-queue', (route) => route.fulfill({
    json: response([], 0, null, 'partial'),
  }))
  await boot(page)
  await openIssues(page)

  await expect(page.getByTestId('review-cockpit-provider-state')).toContainText('Local path items are not covered.')
  await expect(page.getByTestId('review-cockpit-empty')).toBeVisible()

  await page.getByTestId('review-cockpit-tab-tags').click()
  await expect(page.getByTestId('review-cockpit-tab-tags')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#sepcon-tags-panel')).toBeVisible()
  await expect(page.locator('#sepcon-rows .sepcon-row')).toHaveCount(2)
})

test('loaded issues and provider evidence relocalize when the language changes', async ({ page }) => {
  await page.route('**/api/dataset/review-queue', (route) => route.fulfill({
    json: response(
      [issue('issue-empty-902', 'empty_caption', 902, 'Empty caption')],
      1,
      null,
      'partial',
      'not_requested',
    ),
  }))
  await boot(page)
  await openIssues(page)
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Empty caption')
  await expect(page.getByTestId('review-cockpit-provider-state').filter({
    hasText: 'Caption integrity',
  })).toHaveText('Caption integrity · Partial · Local path items are not covered.')
  await expect(page.getByTestId('review-cockpit-provider-state').filter({
    hasText: 'Tag integrity',
  })).toHaveText('Tag integrity · Not requested · Rating-tag integrity was not requested.')
  const issueKind = page.locator('#sepcon-issue-filter')
  const issueKindDisplay = page.locator(
    '[data-select-id="sepcon-issue-filter"] .dataset-custom-dropdown-display',
  )
  await issueKind.selectOption('caption', { force: true })
  await expect(issueKindDisplay).toHaveText('Captions')

  await page.locator('#btn-language-toggle').click()

  await expect(issueKind).toHaveValue('caption')
  await expect(issueKindDisplay).toHaveText('Caption')
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('ZH Empty caption')
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('观察值')
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('中文 Empty caption')
  await expect(page.locator('.sepcon-issue-severity')).toHaveText('中')
  await expect(page.locator('.sepcon-issue-source')).toHaveText('当前 Caption · 可用')
  await expect(page.getByTestId('review-cockpit-provider-state').filter({
    hasText: 'Caption 完整性',
  })).toHaveText('Caption 完整性 · 部分可用 · 本地路径项目未覆盖。')
  await expect(page.getByTestId('review-cockpit-provider-state').filter({
    hasText: '标签完整性',
  })).toHaveText('标签完整性 · 未请求 · 未请求 Rating 标签完整性检查。')
  await expect(page.locator('#sepcon-issues-page')).toHaveText('第 1 页')
})

test('Review Cockpit tabs use roving keyboard focus and keep Refresh outside the tablist', async ({ page }) => {
  await page.route('**/api/dataset/review-queue', (route) => route.fulfill({
    json: response([], 0, null),
  }))
  await boot(page)
  const issuesTab = page.getByTestId('review-cockpit-tab-issues')
  const tagsTab = page.getByTestId('review-cockpit-tab-tags')
  await expect(tagsTab).toHaveAttribute('tabindex', '0')
  await expect(issuesTab).toHaveAttribute('tabindex', '-1')
  await expect(page.locator('.sepcon-view-tabs').getByTestId('review-cockpit-refresh')).toHaveCount(0)

  await tagsTab.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(issuesTab).toBeFocused()
  await expect(issuesTab).toHaveAttribute('aria-selected', 'true')
  await expect(issuesTab).toHaveAttribute('tabindex', '0')
  await expect(tagsTab).toHaveAttribute('tabindex', '-1')

  await page.keyboard.press('End')
  await expect(tagsTab).toBeFocused()
  await expect(tagsTab).toHaveAttribute('aria-selected', 'true')
})

test('HTTP and malformed responses fail closed and Retry re-runs the first page', async ({ page }) => {
  let attempt = 0
  await page.route('**/api/dataset/review-queue', async (route) => {
    attempt += 1
    if (attempt === 1) {
      await route.fulfill({ status: 503, json: { detail: 'Review provider offline.' } })
      return
    }
    if (attempt === 2) {
      await route.fulfill({ json: { ...response([], 0, null), schema_version: 99 } })
      return
    }
    await route.fulfill({
      json: response([issue('issue-empty-902', 'empty_caption', 902, 'Recovered issue')], 1, null),
    })
  })
  await boot(page)
  await openIssues(page)

  await expect(page.getByTestId('review-cockpit-error')).toContainText('Review provider offline.')
  await page.getByTestId('review-cockpit-retry').click()
  await expect(page.getByTestId('review-cockpit-error')).toContainText('invalid')
  await page.getByTestId('review-cockpit-retry').click()
  await expect(page.getByTestId('review-cockpit-issue')).toContainText('Recovered issue')
  expect(attempt).toBe(3)
})

test('response parsing rejects duplicate providers, empty evidence, and empty positive totals', async ({ page }) => {
  let attempt = 0
  await page.route('**/api/dataset/review-queue', async (route) => {
    attempt += 1
    if (attempt === 1) {
      const invalidProviders = response([], 0, null)
      invalidProviders.provider_states[5] = { ...invalidProviders.provider_states[0] }
      await route.fulfill({ json: invalidProviders })
      return
    }
    if (attempt === 2) {
      const invalidIssue = issue('issue-empty-902', 'empty_caption', 902, 'Empty caption')
      invalidIssue.evidence = []
      await route.fulfill({ json: response([invalidIssue], 1, null) })
      return
    }
    if (attempt === 3) {
      const duplicateIssue = issue('duplicate-id', 'empty_caption', 902, 'Duplicate issue')
      await route.fulfill({ json: response([duplicateIssue, { ...duplicateIssue }], 2, null) })
      return
    }
    if (attempt === 4) {
      await route.fulfill({
        json: response([issue('issue-empty-902', 'empty_caption', 902, 'Empty caption')], 2, null),
      })
      return
    }
    await route.fulfill({ json: response([], 0, null) })
  })

  await boot(page)
  await openIssues(page)
  await expect(page.getByTestId('review-cockpit-error')).toContainText('provider')
  await page.getByTestId('review-cockpit-retry').click()
  await expect(page.getByTestId('review-cockpit-error')).toContainText('evidence')
  await page.getByTestId('review-cockpit-retry').click()
  await expect(page.getByTestId('review-cockpit-error')).toContainText('issue_id')
  await page.getByTestId('review-cockpit-retry').click()
  await expect(page.getByTestId('review-cockpit-error')).toContainText('terminal page')
  await page.getByTestId('review-cockpit-retry').click()
  await expect(page.getByTestId('review-cockpit-empty')).toBeVisible()
  expect(attempt).toBe(5)
})

test('Review Cockpit stays unclipped and overlap-free at supported desktop widths', async ({ page }) => {
  const consoleErrors: string[] = []
  const httpErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`)
  })
  await page.route('**/api/dataset/review-queue', (route) => route.fulfill({
    json: response([issue('issue-empty-902', 'empty_caption', 902, 'Empty caption')], 1, null, 'partial'),
  }))
  await boot(page)
  await openIssues(page)

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport)
    await expect(page.getByTestId('review-cockpit-issues')).toBeVisible()
    const layout = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="review-cockpit-issues"]')
      const details = document.getElementById('dataset-separation-console')
      const controls = document.getElementById('sepcon-issue-controls')
      const rows = document.getElementById('sepcon-issue-rows')
      const refresh = document.getElementById('sepcon-issues-refresh')
      const checkbox = document.getElementById('sepcon-include-duplicates')
      if (!panel || !details || !controls || !rows || !refresh || !checkbox) {
        throw new Error('Review Cockpit layout nodes are missing')
      }
      const panelRect = panel.getBoundingClientRect()
      const detailsRect = details.getBoundingClientRect()
      const controlsRect = controls.getBoundingClientRect()
      const rowsRect = rows.getBoundingClientRect()
      const refreshRect = refresh.getBoundingClientRect()
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        panelClipped: panelRect.right > window.innerWidth + 1,
        controlsOverlapRows: controlsRect.bottom > rowsRect.top + 1,
        refreshClippedAtTop: refreshRect.bottom > detailsRect.bottom + 1
          || refreshRect.bottom > window.innerHeight + 1,
        nativeCheckboxVisible: getComputedStyle(checkbox).opacity !== '0',
        nestedRowsScroll: getComputedStyle(rows).overflowY !== 'visible',
      }
    })
    expect(layout).toEqual({
      documentOverflow: false,
      panelClipped: false,
      controlsOverlapRows: false,
      refreshClippedAtTop: false,
      nativeCheckboxVisible: false,
      nestedRowsScroll: false,
    })
  }
  expect(consoleErrors).toEqual([])
  expect(httpErrors).toEqual([])
})
