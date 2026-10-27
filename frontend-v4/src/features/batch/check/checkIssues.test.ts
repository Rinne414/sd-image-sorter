import { describe, expect, it } from 'vitest'
import type { DatasetForm } from '../datasetSettings'
import type { Entry } from '../entries'
import { captionIssues, commonTagsIn, cooccurringPairs, estimateTokens, tagHolders, tokenBudget } from './captionChecks'
import {
  auditIssues,
  folderHealthIds,
  healthIssues,
  keyIndex,
  maskIssues,
  mergeIssues,
  projectIssues,
  purityIssues,
  qualityIssues,
  readAuditReport,
  reviewIssues,
  type AuditReport,
  type CheckIssue,
  type HealthReport,
  type QualityAnswer,
  type ReviewIssueRow,
} from './checkIssues'

const lib = (id: number, over: Partial<Entry> = {}): Entry => ({
  key: `lib:${id}`,
  ref: { kind: 'library', imageId: id },
  imageId: id,
  path: null,
  filename: `${id}.png`,
  width: 512,
  height: 512,
  status: 'ok',
  item: null,
  ...over,
})

const dir = (path: string, status: Entry['status'] = 'ok'): Entry => ({
  key: `dir:${path.replace(/\\/g, '/')}`,
  ref: { kind: 'folder', path },
  imageId: null,
  path,
  filename: path.split(/[\\/]/).pop() ?? path,
  width: null,
  height: null,
  status,
  item: null,
})

const entries = [lib(1), lib(2), lib(3), dir('C:\\ds\\a.png'), dir('C:\\ds\\b.png', 'changed'), dir('C:\\ds\\c.png', 'missing')]
const order = entries.map((e) => e.key)
const animaCount = (qwen: number, t5: number) => ({ counts: [{ label: 'Qwen3', tokens: qwen }, { label: 'T5', tokens: t5 }], tokens: Math.max(qwen, t5) })
const keys = keyIndex(entries)

const form = (over: Partial<DatasetForm> = {}): DatasetForm => ({
  trigger: 'mychar',
  targetModel: 'sdxl',
  purpose: 'character',
  removeCategories: [],
  commonTags: 'solo',
  blacklist: '',
  maxTags: 0,
  template: '',
  replaceRules: '',
  prefix: '',
  normalizeUnderscores: true,
  ...over,
})

const review = (kind: ReviewIssueRow['kind'], ids: number[], value = ''): ReviewIssueRow => ({
  issue_id: `${kind}:${ids.join('-')}`,
  kind,
  subjects: ids.map((image_id) => ({ image_id })),
  evidence: value ? [{ label_en: 'x', value_en: value }] : [],
})

const byKind = (list: readonly CheckIssue[], kind: CheckIssue['kind']) => list.filter((i) => i.kind === kind)

describe('each source says what it found, by entry key', () => {
  it('the project knows folder images whose file changed or went missing', () => {
    const found = projectIssues(entries)
    expect(byKind(found, 'file_changed')[0]?.keys).toEqual(['dir:C:/ds/b.png'])
    expect(byKind(found, 'file_missing')[0]?.keys).toEqual(['dir:C:/ds/c.png'])
  })

  it('a missing Library image is missing too', () => {
    const found = projectIssues([lib(7, { imageId: null, status: 'missing' })])
    expect(byKind(found, 'file_missing')[0]?.keys).toEqual(['lib:7'])
  })

  it('the review queue: small, missing, low aesthetic, saved duplicate groups', () => {
    const found = reviewIssues(
      [review('small_image', [1], '200x200'), review('file_missing', [2]), review('low_aesthetic', [3], '3.2'), review('duplicate_group', [1, 2])],
      keys,
    )
    expect(byKind(found, 'small')[0]).toMatchObject({ keys: ['lib:1'], notes: { 'lib:1': '200x200' } })
    expect(byKind(found, 'file_missing')[0]?.keys).toEqual(['lib:2'])
    expect(byKind(found, 'low_aesthetic')[0]?.notes).toEqual({ 'lib:3': '3.2' })
    expect(byKind(found, 'duplicates')[0]?.groups).toEqual([['lib:1', 'lib:2']])
  })

  it('the audit finds folder images by path, whatever the slashes or letter case', () => {
    const report: AuditReport = {
      items: [
        { image_id: 0, abs_path: 'c:\\DS\\a.png', width: 200, height: 300, flags: ['small'] },
        { image_id: 3, abs_path: 'D:\\lib\\3.png', width: 100, height: 100, flags: ['small'] },
      ],
      duplicate_groups: [{ image_ids: [3, 0], abs_paths: ['D:\\lib\\3.png', 'C:/ds/a.png'] }],
    }
    const found = auditIssues(report, keys)
    expect(byKind(found, 'small')[0]).toMatchObject({ keys: ['dir:C:/ds/a.png', 'lib:3'], notes: { 'dir:C:/ds/a.png': '200×300', 'lib:3': '100×100' } })
    expect(byKind(found, 'duplicates')[0]?.groups).toEqual([['lib:3', 'dir:C:/ds/a.png']])
  })

  it('folder images scored by the audit on request: low scores are low aesthetic', () => {
    const report: AuditReport = { items: [{ image_id: 0, abs_path: 'C:/ds/a.png', width: 9, height: 9, aesthetic_score: 3.14, flags: ['low_quality'] }], duplicate_groups: [] }
    expect(byKind(auditIssues(report, keys), 'low_aesthetic')[0]).toMatchObject({ keys: ['dir:C:/ds/a.png'], notes: { 'dir:C:/ds/a.png': '3.1' } })
  })

  it('health by purpose: trigger coverage and ratings name images; unknown findings keep their own words', () => {
    const report: HealthReport = {
      findings: [
        { id: 'trigger-coverage', severity: 'high', title_en: 't', title_zh: 't', detail_en: 'd', detail_zh: 'd', fix: { image_ids: [2, 3] }, data: {} },
        { id: 'rating-duplicates', severity: 'medium', title_en: 't', title_zh: 't', detail_en: 'd', detail_zh: 'd', fix: null, data: { image_ids: [1] } },
        { id: 'composition-fullbody', severity: 'medium', title_en: 't', title_zh: 't', detail_en: 'd', detail_zh: 'd', fix: null, data: { distribution: { 'full body': 1, 'wide shot': 0 } } },
        { id: 'something-new', severity: 'info', title_en: 'New', title_zh: '新', detail_en: 'More', detail_zh: '更多', fix: null, data: {} },
        { id: 'low-frequency-tags', severity: 'info', title_en: 't', title_zh: 't', detail_en: 'd', detail_zh: 'd', fix: null, data: { tags: ['x'] } },
      ],
      images: 3,
    }
    const found = healthIssues(report, keys, { ratingsInCaptions: true })
    expect(byKind(found, 'trigger_coverage')[0]?.keys).toEqual(['lib:2', 'lib:3'])
    expect(byKind(found, 'rating_conflict')[0]?.keys).toEqual(['lib:1'])
    expect(byKind(found, 'fullbody')[0]?.params).toEqual({ n: 1, total: 3 })
    expect(byKind(found, 'health_other')[0]?.text).toMatchObject({ en: 'New', zh: '新' })
    // tag-level findings come from the final captions instead (the backend reads Library tags)
    expect(byKind(found, 'rare_tags')).toEqual([])
    // rating tags left out of the captions by the settings: rating checks do not apply
    expect(byKind(healthIssues(report, keys, { ratingsInCaptions: false }), 'rating_conflict')).toEqual([])
  })

  it('picture quality hints: possibly blurry and very flat are separate hints, each with its number', () => {
    const answer: QualityAnswer = {
      total: 4,
      scored: 4,
      pending: 0,
      unreadable: 0,
      missing: 0,
      job_id: null,
      started: false,
      items: [
        { image_id: 1, abs_path: 'D:/lib/1.png', blur: 23.4, edge: 0.04, flat: 0.1, flags: ['blurry'] },
        { image_id: 0, abs_path: 'c:/DS/a.png', blur: 0, edge: 0, flat: 0.987, flags: ['flat'] },
        { image_id: 77, abs_path: 'D:/lib/gone.png', blur: 3, edge: 0, flat: 0.1, flags: ['blurry'] },
      ],
    }
    const found = qualityIssues(answer, keys)
    expect(byKind(found, 'blurry')[0]).toMatchObject({ severity: 'low', sources: ['quality'], keys: ['lib:1'], notes: { 'lib:1': '23' } })
    expect(byKind(found, 'flat')[0]).toMatchObject({ keys: ['dir:C:/ds/a.png'], notes: { 'dir:C:/ds/a.png': '99' } })
    expect(qualityIssues({ ...answer, items: [] }, keys)).toEqual([])
  })

  it('subject-count conflicts become one issue with the fix for each image, to preview and tick', () => {
    const finding = (fix: HealthReport['findings'][number]['fix']): HealthReport => ({
      images: 3,
      findings: [{ id: 'subject-count-conflict', severity: 'medium', title_en: 't', title_zh: 't', detail_en: 'd', detail_zh: 'd', fix, data: {} }],
    })
    const proposals = [
      { image_id: 2, keep: ['2girls'], drop: ['1girl', 'solo'] },
      { image_id: 99, keep: ['2girls'], drop: ['solo'] },
      { image_id: 3, keep: [], drop: [] },
    ]
    const found = byKind(healthIssues(finding({ proposals }), keys, { ratingsInCaptions: true }), 'subject_count')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ severity: 'medium', keys: ['lib:2'], subjectFixes: [{ key: 'lib:2', keep: ['2girls'], drop: ['1girl', 'solo'] }] })
    // nothing to propose for any image in the batch: no issue
    expect(byKind(healthIssues(finding({ proposals: proposals.slice(1) }), keys, { ratingsInCaptions: true }), 'subject_count')).toEqual([])
    expect(byKind(healthIssues(finding(null), keys, { ratingsInCaptions: true }), 'subject_count')).toEqual([])
  })

  it('names the common tags a subject fix would take off, as the settings write them', () => {
    const fixes = [
      { key: 'lib:1', keep: ['2girls'], drop: ['1girl', 'solo'] },
      { key: 'lib:2', keep: [], drop: ['Solo'] },
    ]
    expect(commonTagsIn(fixes, form({ commonTags: 'solo, masterpiece' }))).toEqual(['solo'])
    expect(commonTagsIn(fixes, form({ commonTags: 'masterpiece' }))).toEqual([])
  })

  it('a folder image goes to the health check with its own negative id and its findings come back to it', () => {
    // folderHealthIds: -1, -2, -3 for the three folder images, in batch order.
    expect([...folderHealthIds(entries)]).toEqual([
      ['dir:C:/ds/a.png', -1],
      ['dir:C:/ds/b.png', -2],
      ['dir:C:/ds/c.png', -3],
    ])
    const report: HealthReport = {
      images: 4,
      findings: [
        { id: 'subject-count-conflict', severity: 'medium', title_en: 't', title_zh: 't', detail_en: 'd', detail_zh: 'd', fix: { proposals: [{ image_id: -1, keep: ['2girls'], drop: ['solo'] }] }, data: {} },
        { id: 'trigger-coverage', severity: 'high', title_en: 't', title_zh: 't', detail_en: 'd', detail_zh: 'd', fix: { image_ids: [2, -1] }, data: {} },
      ],
    }
    const found = healthIssues(report, keys, { ratingsInCaptions: true })
    expect(byKind(found, 'subject_count')[0]).toMatchObject({ keys: ['dir:C:/ds/a.png'], subjectFixes: [{ key: 'dir:C:/ds/a.png', keep: ['2girls'], drop: ['solo'] }] })
    expect(byKind(found, 'trigger_coverage')[0]).toMatchObject({ keys: ['lib:2', 'dir:C:/ds/a.png'] })
    // A path still finds a folder image the usual way (the audit sends paths, never these ids).
    const audit: AuditReport = { items: [{ image_id: -1, abs_path: 'C:/ds/b.png', width: 9, height: 9, flags: ['small'] }], duplicate_groups: [] }
    expect(byKind(auditIssues(audit, keys), 'small')[0]?.keys).toEqual(['dir:C:/ds/b.png'])
  })

  it('subject-count fixes of images that left the batch are dropped when the issues merge', () => {
  it('a folder image goes to the health check with its own negative id and its findings come back to it', () => {
    // folderHealthIds: -1, -2, -3 for the three folder images, in batch order.
    expect([...folderHealthIds(entries)]).toEqual([
      ['dir:C:/ds/a.png', -1],
      ['dir:C:/ds/b.png', -2],
      ['dir:C:/ds/c.png', -3],
    ])
    const report: HealthReport = {
      images: 4,
      findings: [
        { id: 'subject-count-conflict', severity: 'medium', title_en: 't', title_zh: 't', detail_en: 'd', detail_zh: 'd', fix: { proposals: [{ image_id: -1, keep: ['2girls'], drop: ['solo'] }] }, data: {} },
        { id: 'trigger-coverage', severity: 'high', title_en: 't', title_zh: 't', detail_en: 'd', detail_zh: 'd', fix: { image_ids: [2, -1] }, data: {} },
      ],
    }
    const found = healthIssues(report, keys, { ratingsInCaptions: true })
    expect(byKind(found, 'subject_count')[0]).toMatchObject({ keys: ['dir:C:/ds/a.png'], subjectFixes: [{ key: 'dir:C:/ds/a.png', keep: ['2girls'], drop: ['solo'] }] })
    expect(byKind(found, 'trigger_coverage')[0]).toMatchObject({ keys: ['lib:2', 'dir:C:/ds/a.png'] })
    // A path still finds a folder image the usual way (the audit sends paths, never these ids).
    const audit: AuditReport = { items: [{ image_id: -1, abs_path: 'C:/ds/b.png', width: 9, height: 9, flags: ['small'] }], duplicate_groups: [] }
    expect(byKind(auditIssues(audit, keys), 'small')[0]?.keys).toEqual(['dir:C:/ds/b.png'])
  })

    const issue = {
      id: 'subject_count',
      kind: 'subject_count',
      severity: 'medium',
      keys: ['lib:3', 'lib:1', 'lib:gone'],
      sources: ['health'],
      subjectFixes: [
        { key: 'lib:3', keep: [], drop: ['solo'] },
        { key: 'lib:1', keep: [], drop: ['1girl'] },
        { key: 'lib:gone', keep: [], drop: ['solo'] },
      ],
    } as CheckIssue
    const [merged] = mergeIssues([[issue]], order)
    expect(merged?.keys).toEqual(['lib:1', 'lib:3'])
    expect(merged?.subjectFixes?.map((s) => s.key)).toEqual(['lib:1', 'lib:3'])
  })

  it('character purity names the outliers with their distance', () => {
    const found = purityIssues({ items: [{ image_id: 1, distance: 0.41, outlier: true }, { image_id: 2, distance: 0.05, outlier: false }] }, keys)
    expect(found[0]).toMatchObject({ kind: 'character_outlier', keys: ['lib:1'], notes: { 'lib:1': '0.41' } })
  })
})

describe('training masks', () => {
  it('images without a mask are named once masks are in use: some image has one, or the export writes them', () => {
    expect(maskIssues(new Set(), [1, 2, 3], keys, false)).toEqual([])
    expect(maskIssues(new Set([2]), [1, 2, 3], keys, false)[0]).toMatchObject({ kind: 'no_mask', severity: 'low', keys: ['lib:1', 'lib:3'] })
    expect(maskIssues(new Set(), [1, 2], keys, true)[0]?.keys).toEqual(['lib:1', 'lib:2'])
    expect(maskIssues(new Set([1, 2]), [1, 2], keys, true)).toEqual([])
  })
})

describe('the final captions', () => {
  const finals = new Map([
    ['lib:1', 'mychar, solo'],
    ['lib:2', 'mychar, solo, red hair, smile, hat'],
    ['lib:3', 'mychar, solo, red hair, smile'],
    ['dir:C:/ds/a.png', 'mychar, solo, red hair, smile, hat'],
  ])

  it('a caption with only what the batch rules put there is empty', () => {
    expect(byKind(captionIssues(finals, form()), 'empty_caption')[0]?.keys).toEqual(['lib:1'])
  })

  it('estimates CLIP tokens and warns over the base model budget', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('long_hair, smile')).toBe(5)
    expect(tokenBudget('sdxl')).toBe(75)
    expect(tokenBudget('')).toBe(75)
    expect(tokenBudget('flux')).toBe(512)
    const long = Array.from({ length: 40 }, (_, i) => `tag number ${i}`).join(', ')
    const withLong = new Map([...finals, ['lib:3', long]])
    const over = byKind(captionIssues(withLong, form()), 'too_long')[0]
    expect(over?.keys).toEqual(['lib:3'])
    expect(Number(over?.notes?.['lib:3'])).toBeGreaterThan(75)
    expect(byKind(captionIssues(withLong, form({ targetModel: 'flux' })), 'too_long')).toEqual([])
  })

  it('Anima: exact Qwen3 and T5 counts replace the estimate, and either one over 512 is too long', () => {
    const anima = form({ targetModel: 'anima' })
    const caption = 'mychar, solo, red hair'
    const captions = new Map([
      ['lib:1', caption],
      ['lib:2', caption],
      ['lib:3', caption],
    ])
    const exact = new Map([
      ['lib:1', animaCount(300, 510)],
      ['lib:2', animaCount(520, 100)],
      ['lib:3', animaCount(512, 513)],
    ])
    const over = byKind(captionIssues(captions, anima, exact), 'too_long')[0]
    expect(over?.keys).toEqual(['lib:2', 'lib:3'])
    expect(over?.notes).toEqual({ 'lib:2': 'Qwen3 520 · T5 100', 'lib:3': 'Qwen3 512 · T5 513' })
    expect(over?.params).toEqual({ budget: 512, exact: 1 })
    // the estimate of this short caption is far under the budget: the exact counts are what flagged it
    expect(estimateTokens(caption)).toBeLessThan(512)
  })

  it('Anima: a caption the exact counts do not cover keeps the estimate, and the issue says so', () => {
    const anima = form({ targetModel: 'anima' })
    const long = Array.from({ length: 200 }, (_, i) => `tag number ${i}`).join(', ')
    const captions = new Map([
      ['lib:1', 'mychar, solo'],
      ['lib:2', long],
    ])
    const over = byKind(captionIssues(captions, anima, new Map([['lib:1', animaCount(4, 5)]])), 'too_long')[0]
    expect(over?.keys).toEqual(['lib:2'])
    expect(Number(over?.notes?.['lib:2'])).toBeGreaterThan(512)
    expect(over?.params?.exact).toBe(0)
    // no exact counts at all (not downloaded yet): the estimate, flagged as not exact
    expect(byKind(captionIssues(captions, anima, null), 'too_long')[0]?.params?.exact).toBe(0)
  })

  it('every base model uses its exact counts against its own budget (Krea 2 keeps 507)', () => {
    const captions = new Map([['lib:1', 'mychar, solo'], ['lib:2', 'mychar, solo']])
    const clip = (n: number) => ({ counts: [{ label: 'CLIP', tokens: n }], tokens: n })
    const qwen = (n: number) => ({ counts: [{ label: 'Qwen3', tokens: n }], tokens: n })
    const sdxl = byKind(captionIssues(captions, form({ targetModel: 'sdxl' }), new Map([['lib:1', clip(75)], ['lib:2', clip(76)]])), 'too_long')[0]
    expect(sdxl).toMatchObject({ keys: ['lib:2'], notes: { 'lib:2': 'CLIP 76' }, params: { budget: 75, exact: 1 } })
    const krea = byKind(captionIssues(captions, form({ targetModel: 'krea2' }), new Map([['lib:1', qwen(507)], ['lib:2', qwen(508)]])), 'too_long')[0]
    expect(krea).toMatchObject({ keys: ['lib:2'], params: { budget: 507, exact: 1 } })
    expect(tokenBudget('')).toBe(75)
  })

  it('tags that always go together are paired; the rule tags are left out', () => {
    const pairs = cooccurringPairs(finals.values(), new Set(['mychar', 'solo']))
    expect(pairs).toEqual([{ a: 'red hair', b: 'smile', together: 3, ratio: 1 }])
    const issue = byKind(captionIssues(finals, form()), 'cooccur')[0]
    expect(issue?.pairs).toEqual(pairs)
  })

  it('tags on one caption only are named once there are ten captions', () => {
    const ten = new Map(Array.from({ length: 10 }, (_, i) => [`lib:${i}`, i === 4 ? 'mychar, solo, smile, odd_tag, A girl stands in a field. She waves' : 'mychar, solo, smile']))
    expect(byKind(captionIssues(ten, form()), 'rare_tags')[0]?.tags).toEqual(['odd tag'])
    expect(byKind(captionIssues(new Map([...ten].slice(0, 9)), form()), 'rare_tags')).toEqual([])
  })

  it('finds the images whose caption has a tag, by any spelling', () => {
    expect(tagHolders(finals, 'Red_Hair')).toEqual(['lib:2', 'lib:3', 'dir:C:/ds/a.png'])
  })
})

describe('merging the sources', () => {
  it('one issue per kind: images from every source once, in batch order, the highest severity, every source named', () => {
    const merged = mergeIssues(
      [
        projectIssues(entries),
        reviewIssues([review('file_missing', [2]), review('small_image', [3], '10x10')], keys),
        auditIssues({ items: [{ image_id: 0, abs_path: 'C:\\ds\\c.png', width: null, height: null, flags: ['missing'] }, { image_id: 1, abs_path: '', width: 64, height: 64, flags: ['small'] }], duplicate_groups: [] }, keys),
      ],
      order,
    )
    const missing = byKind(merged, 'file_missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.keys).toEqual(['lib:2', 'dir:C:/ds/c.png'])
    expect(missing[0]?.sources).toEqual(['project', 'review', 'audit'])
    expect(byKind(merged, 'small')[0]).toMatchObject({ keys: ['lib:1', 'lib:3'], notes: { 'lib:1': '64×64', 'lib:3': '10x10' } })
  })

  it('duplicate groups that share an image become one group', () => {
    const merged = mergeIssues(
      [
        reviewIssues([review('duplicate_group', [1, 2])], keys),
        auditIssues({ items: [], duplicate_groups: [{ image_ids: [2, 0], abs_paths: ['', 'C:/ds/a.png'] }, { image_ids: [3, 3], abs_paths: [] }] }, keys),
      ],
      order,
    )
    const dupes = byKind(merged, 'duplicates')
    expect(dupes).toHaveLength(1)
    expect(dupes[0]?.groups).toEqual([['lib:1', 'lib:2', 'dir:C:/ds/a.png']])
    expect(dupes[0]?.keys).toEqual(['lib:1', 'lib:2', 'dir:C:/ds/a.png'])
  })

  it('rating conflicts from health and the review queue are one issue', () => {
    const merged = mergeIssues(
      [
        reviewIssues([review('rating_conflict', [1])], keys),
        healthIssues({ images: 3, findings: [{ id: 'rating-duplicates', severity: 'medium', title_en: '', title_zh: '', detail_en: '', detail_zh: '', fix: null, data: { image_ids: [1, 2] } }] }, keys, { ratingsInCaptions: true }),
      ],
      order,
    )
    expect(byKind(merged, 'rating_conflict')).toEqual([expect.objectContaining({ keys: ['lib:1', 'lib:2'] })])
  })

  it('images no longer in the batch are dropped, and an image issue left with none goes', () => {
    const merged = mergeIssues([reviewIssues([review('small_image', [99]), review('low_aesthetic', [1, 99])], keys)], order)
    expect(byKind(merged, 'small')).toEqual([])
    expect(byKind(merged, 'low_aesthetic')[0]?.keys).toEqual(['lib:1'])
  })

  it('high first, then medium, then low; a finding about the whole set stays without images', () => {
    const merged = mergeIssues(
      [
        reviewIssues([review('small_image', [1])], keys),
        projectIssues(entries),
        healthIssues({ images: 3, findings: [{ id: 'trigger-missing', severity: 'high', title_en: '', title_zh: '', detail_en: '', detail_zh: '', fix: null, data: {} }] }, keys, { ratingsInCaptions: true }),
      ],
      order,
    )
    const severities = merged.map((i) => i.severity)
    expect(severities).toEqual([...severities].sort((a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b)))
    expect(byKind(merged, 'trigger_missing')[0]?.keys).toEqual([])
  })
})

describe('an audit answer that is empty or not what the audit sends', () => {
  it('is refused with a reason (the step shows it with Retry), never read as "no issues"', () => {
    for (const raw of [undefined, null, {}, { items: 'x' }, { items: null }, 'text']) {
      expect(() => readAuditReport(raw, 'the answer was incomplete'), JSON.stringify(raw)).toThrow('the answer was incomplete')
    }
  })

  it('keeps a proper answer, and a missing duplicate list reads as none', () => {
    const ok = readAuditReport<{ summary: unknown }>({ items: [{ image_id: 1, abs_path: '', width: 10, height: 10, flags: [] }], summary: { near_duplicate_failed: 0 } }, 'x')
    expect(ok.items).toHaveLength(1)
    expect(ok.duplicate_groups).toEqual([])
    expect(ok.summary).toEqual({ near_duplicate_failed: 0 })
  })

  it('auditIssues itself does not throw on a report without items', () => {
    expect(auditIssues({} as unknown as AuditReport, keyIndex([]))).toEqual([])
  })
})
