import { describe, expect, it } from 'vitest'
import { allPicks, canPick, downloadSize, initialPicks, pickedBytes, pickedTargets, recommendedPicks } from './bulkPlan'
import type { BulkItem } from './types'

const MB = 1024 * 1024
const GB = 1024 * MB

// The shape of GET /api/models/bulk-bundle (routers/models.py BULK_MODEL_BUNDLE).
const ITEMS: BulkItem[] = [
  { id: 'wd14', label: 'WD14', size_bytes: 446 * MB, status: 'ready', variant: 'wd-swinv2-tagger-v3', recommended: true, default_selected: true },
  { id: 'censor-nudenet', label: 'NudeNet', size_bytes: 12 * MB, status: 'missing', recommended: true, default_selected: true },
  { id: 'clip', label: 'CLIP', size_bytes: 600 * MB, status: 'missing', recommended: true, default_selected: true },
  { id: 'sam3', label: 'SAM 3', size_bytes: 3.3 * GB, status: 'missing', recommended: false, default_selected: false },
  { id: 'florence2', label: 'Florence-2', size_bytes: 465 * MB, status: 'missing', variant: 'base', recommended: true, default_selected: true },
  { id: 'cl-tagger-v2', label: 'CL', size_bytes: 2.7 * GB, status: 'missing', variant: 'v2_00', recommended: false, default_selected: false, requires_auth: true, gated_download: true, auth_url: 'https://huggingface.co/cella110n/cl_tagger_v2' },
  { id: 'rembg', label: 'rembg', size_bytes: 170 * MB, status: 'missing', recommended: false, default_selected: false, download_supported: false },
]

const ids = (picks: ReadonlySet<string>) => [...picks].sort()

describe('what the bulk download starts with', () => {
  it('ticks the recommended missing models, never a ready one, a gated one or one that cannot download', () => {
    expect(ids(initialPicks(ITEMS))).toEqual(['censor-nudenet', 'clip', 'florence2'])
  })

  it('leaves the gated model pickable by hand, and a ready or undownloadable one not pickable', () => {
    expect(canPick(ITEMS.find((i) => i.id === 'cl-tagger-v2')!)).toBe(true)
    expect(canPick(ITEMS.find((i) => i.id === 'wd14')!)).toBe(false)
    expect(canPick(ITEMS.find((i) => i.id === 'rembg')!)).toBe(false)
  })

  it('"pick recommended" and "pick all" choose only what can download; all includes the gated one', () => {
    expect(ids(recommendedPicks(ITEMS))).toEqual(['censor-nudenet', 'clip', 'florence2'])
    expect(ids(allPicks(ITEMS))).toEqual(['censor-nudenet', 'cl-tagger-v2', 'clip', 'florence2', 'sam3'])
  })
})

describe('what it downloads', () => {
  it('adds up the picked sizes, ignoring anything that is ready', () => {
    expect(pickedBytes(ITEMS, new Set(['clip', 'censor-nudenet']))).toBe(612 * MB)
    expect(pickedBytes(ITEMS, new Set(['wd14']))).toBe(0)
  })

  it('downloads the picks in the list order, each with its version and a name to show', () => {
    const targets = pickedTargets(ITEMS, new Set(['florence2', 'censor-nudenet', 'wd14']), (id) => `name:${id}`)
    expect(targets).toEqual([
      { card: 'censor-nudenet', variant: null, label: 'name:censor-nudenet' },
      { card: 'florence2', variant: 'base', label: 'name:florence2' },
    ])
  })
})

describe('sizes', () => {
  it('reads in MB below a gigabyte and in GB above', () => {
    expect(downloadSize(12 * MB)).toBe('12 MB')
    expect(downloadSize(612 * MB)).toBe('612 MB')
    expect(downloadSize(2.7 * GB)).toBe('2.7 GB')
    expect(downloadSize(1000)).toBe('1 MB')
  })
})
