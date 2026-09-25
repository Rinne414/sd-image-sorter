import { describe, expect, test } from 'vitest'
import { bulkRequest, parseTagList, summarize, type BulkForm } from './bulkTags'

const form = (patch: Partial<BulkForm>): BulkForm => ({
  op: 'add',
  tags: '',
  find: '',
  replace: '',
  caseSensitive: false,
  regex: false,
  minConfidence: 0.2,
  dedupe: true,
  ...patch,
})

describe('parseTagList', () => {
  test('commas (either width) and new lines split; blanks and repeats go', () => {
    expect(parseTagList(' smile, long hair，smile\n\n blush ')).toEqual(['smile', 'long hair', 'blush'])
  })
})

describe('bulkRequest', () => {
  test('each operation goes to its endpoint with the picks as the scope', () => {
    expect(bulkRequest(form({ op: 'add', tags: 'a, b' }), [1, 2], true)).toEqual({
      path: '/api/tags/bulk/add',
      body: { image_ids: [1, 2], tags: ['a', 'b'], dry_run: true },
    })
    expect(bulkRequest(form({ op: 'remove', tags: 'a', caseSensitive: true }), [3], false)).toEqual({
      path: '/api/tags/bulk/remove',
      body: { image_ids: [3], tags: ['a'], case_sensitive: true, dry_run: false },
    })
    expect(bulkRequest(form({ op: 'replace', find: ' old ', replace: 'new', regex: true }), [4], true)).toEqual({
      path: '/api/tags/bulk/find-replace',
      body: { image_ids: [4], find: 'old', replace: 'new', case_sensitive: false, regex: true, dry_run: true },
    })
    expect(bulkRequest(form({ op: 'cleanup', minConfidence: 0.3, dedupe: false }), [5], true)).toEqual({
      path: '/api/tags/bulk/cleanup',
      body: { image_ids: [5], min_confidence: 0.3, dedupe: false, dry_run: true },
    })
  })

  test('nothing to do is said, not sent', () => {
    expect(bulkRequest(form({ op: 'add', tags: ' , ' }), [1], true)).toBeNull()
    expect(bulkRequest(form({ op: 'replace', find: '  ' }), [1], true)).toBeNull()
    expect(bulkRequest(form({ op: 'add', tags: 'a' }), [], true)).toBeNull()
  })
})

describe('summarize', () => {
  test('find-replace: what each sample loses and gains', () => {
    const s = summarize('replace', {
      affected_images: 2,
      affected_tags: 3,
      sample_changes: [{ image_id: 9, before: ['a', 'old', 'b'], after: ['a', 'b', 'new'] }],
    })
    expect(s).toEqual({ images: 2, tags: 3, samples: [{ imageId: 9, removed: ['old'], added: ['new'], note: null }] })
  })

  test('add, remove and cleanup samples', () => {
    expect(summarize('add', { affected_images: 1, total_tags_added: 2, sample_changes: [{ image_id: 1, added: ['x', 'y'] }] }).samples).toEqual([
      { imageId: 1, removed: [], added: ['x', 'y'], note: null },
    ])
    expect(summarize('remove', { affected_images: 1, total_tags_removed: 1, sample_changes: [{ image_id: 2, removed: ['x'] }] })).toMatchObject({
      tags: 1,
      samples: [{ imageId: 2, removed: ['x'], added: [] }],
    })
    expect(
      summarize('cleanup', {
        affected_images: 1,
        total_low_conf_removed: 4,
        total_duplicates_removed: 1,
        sample_changes: [{ image_id: 3, removed_low_conf: 4, removed_dupes: 1 }],
      }),
    ).toEqual({ images: 1, tags: 5, samples: [{ imageId: 3, removed: [], added: [], note: { lowConf: 4, dupes: 1 } }] })
  })

  test('a malformed answer is zero, not a crash', () => {
    expect(summarize('add', null)).toEqual({ images: 0, tags: 0, samples: [] })
  })
})
