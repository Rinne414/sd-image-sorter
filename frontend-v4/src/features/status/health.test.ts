import { describe, expect, test } from 'vitest'
import type { HealthSample, LibraryHealth } from '../../api/types'
import { issueRows, nextSteps, readErrorsOnly, sampleReason, shouldOfferTextRecovery, verdict } from './health'

const sample = (patch: Partial<HealthSample>): HealthSample => ({
  id: 1,
  filename: 'a.png',
  path: 'D:/x/a.png',
  generator: 'nai',
  metadata_status: 'complete',
  read_error: null,
  prompt: '1girl',
  sidecar_caption: null,
  checkpoint_normalized: 'model',
  width: 512,
  height: 768,
  tagged_at: '2026-01-01',
  ...patch,
})

const report = (counts: Record<string, number>, rest: Partial<LibraryHealth> = {}): LibraryHealth => ({
  summary: { total_images: 100, readable_images: 100, tagged_percent: 90, actionable_count: 5 },
  issue_counts: counts,
  ...rest,
})

describe('the verdict over the score', () => {
  test('an empty library, then risk / watch / good at the same cut-offs as V3.5', () => {
    expect(verdict({ total_images: 0, quality_score: 100 })).toBe('empty')
    expect(verdict({ total_images: 5, quality_score: 59.9 })).toBe('risk')
    expect(verdict({ total_images: 5, quality_score: 60 })).toBe('watch')
    expect(verdict({ total_images: 5, quality_score: 81.9 })).toBe('watch')
    expect(verdict({ total_images: 5, quality_score: 82 })).toBe('good')
  })

  test('no score published (an older backend) says nothing rather than "good"', () => {
    expect(verdict({ total_images: 5 })).toBe('unknown')
  })
})

describe('why a listed file needs attention', () => {
  test('the first defect on the ladder wins', () => {
    expect(sampleReason(sample({ metadata_status: 'error', prompt: null, tagged_at: null }))).toEqual({ kind: 'metadata_error' })
    expect(sampleReason(sample({ metadata_status: 'pending' }))).toEqual({ kind: 'metadata_pending' })
    expect(sampleReason(sample({ prompt: null, sidecar_caption: null, tagged_at: null }))).toEqual({ kind: 'missing_text' })
    expect(sampleReason(sample({ width: 0 }))).toEqual({ kind: 'missing_dimensions' })
    expect(sampleReason(sample({ tagged_at: null }))).toEqual({ kind: 'untagged' })
  })

  test('a caption-only row is not "no text"; an unattributed row is not "no checkpoint"', () => {
    expect(sampleReason(sample({ prompt: null, sidecar_caption: 'a cat', tagged_at: null }))).toEqual({ kind: 'untagged' })
    expect(sampleReason(sample({ generator: 'unknown', checkpoint_normalized: null, prompt: null, sidecar_caption: 'x' }))).toEqual({ kind: 'unnamed' })
    expect(sampleReason(sample({ checkpoint_normalized: null }))).toEqual({ kind: 'sd_missing_checkpoint' })
    expect(sampleReason(sample({ generator: '', checkpoint_normalized: 'm' }))).toEqual({ kind: 'unattributed_sd_metadata' })
  })

  test('an unreadable row shows its own error, with paths cut to the file name', () => {
    const r = sampleReason(sample({ read_error: "cannot identify image file 'D:\\art\\set 1\\a.png'" }))
    expect(r).toEqual({ kind: 'unreadable', text: "cannot identify image file 'a.png'" })
    expect(sampleReason(sample({ read_error: 'No such file: /home/me/pics/b.webp' }))).toEqual({ kind: 'unreadable', text: 'No such file: b.webp' })
  })
})

describe('the issue list', () => {
  test('only what is there, in order; coverage rows stay even at zero', () => {
    const rows = issueRows({ untagged: 3, unreadable: 2, missing_text: 0, missing_embedding: 0, missing_aesthetic: 4 })
    expect(rows.map((r) => r.key)).toEqual(['unreadable', 'untagged', 'missing_embedding', 'missing_aesthetic'])
    expect(rows.find((r) => r.key === 'missing_embedding')?.coverage).toBe(true)
  })
})

describe('details that failed to read, apart from the missing files', () => {
  test('the union the report publishes minus the unreadable rows', () => {
    const r = report({ unreadable: 3, metadata_error: 5 }, { recommendations: [{ kind: 'reparse_or_reconnect', severity: 'warning', count: 6 }] })
    expect(readErrorsOnly(r)).toBe(3)
  })

  test('without the union (a stubbed or older report) it falls back to the difference', () => {
    expect(readErrorsOnly(report({ unreadable: 3, metadata_error: 5 }))).toBe(2)
    expect(readErrorsOnly(report({ unreadable: 4, metadata_error: 1 }))).toBe(0)
  })
})

describe('what to do next', () => {
  test('one step per remedy, in the backend order; re-parse-or-reconnect becomes its two fixes', () => {
    const r = report(
      { unreadable: 2, metadata_error: 3, untagged: 7 },
      {
        recommendations: [
          { kind: 'metadata_pending', severity: 'info', count: 4 },
          { kind: 'reparse_or_reconnect', severity: 'warning', count: 3 },
          { kind: 'missing_text', severity: 'warning', count: 9 },
          { kind: 'untagged', severity: 'info', count: 7 },
          { kind: 'duplicate_filenames', severity: 'info', count: 2 },
          { kind: 'something_new', severity: 'info', count: 1 },
        ],
      },
    )
    expect(nextSteps(r, 2)).toEqual([
      { kind: 'pending', n: 4, warn: false },
      { kind: 'missing', n: 2, warn: true },
      { kind: 'readErrors', n: 1, warn: true },
      { kind: 'missingText', n: 9, warn: true },
      { kind: 'untagged', n: 7, warn: false },
      { kind: 'duplicates', n: 2, warn: false },
    ])
  })

  test('files that went missing since the report still get their step', () => {
    expect(nextSteps(report({}, { recommendations: [] }), 3)).toEqual([{ kind: 'missing', n: 3, warn: true }])
  })

  test('a report without remedies falls back to the counts', () => {
    expect(nextSteps(report({ untagged: 2, metadata_error: 1, missing_text: 5 }), 0).map((s) => s.kind)).toEqual(['readErrors', 'missingText', 'untagged'])
  })
})

describe('offering "recover missing text" in the rail', () => {
  test('offered until a run has tried; again only when more images lack text', () => {
    expect(shouldOfferTextRecovery(0, undefined)).toBe(false)
    expect(shouldOfferTextRecovery(40, undefined)).toBe(true)
    expect(shouldOfferTextRecovery(40, 40)).toBe(false)
    expect(shouldOfferTextRecovery(12, 40)).toBe(false)
    expect(shouldOfferTextRecovery(41, 40)).toBe(true)
  })
})
