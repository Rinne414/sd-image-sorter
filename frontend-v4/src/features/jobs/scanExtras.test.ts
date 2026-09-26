import { describe, expect, test } from 'vitest'
import { readProgress } from './progress'
import { readScanExtras } from './scanExtras'

describe('what an import says beyond its counts', () => {
  test('no visible progress: how long, where it is and what is left, for the diagnostics card', () => {
    const raw = {
      status: 'running',
      attention_required: true,
      stalled_seconds: 94.6,
      step: 'metadata',
      current_item: 'Z:/share/big.png',
      metadata_pending: 12,
      metadata_processed: 30,
      metadata_total: 42,
      processed: 42,
      total: 42,
      diagnostics_available: true,
    }
    expect(readScanExtras(raw).stall).toEqual({ seconds: 95, step: 'metadata', item: 'Z:/share/big.png', pending: 12, done: 30, total: 42, logReady: true })
  })

  test('moving again, the card goes away; before details it counts files', () => {
    expect(readScanExtras({ status: 'running', attention_required: false }).stall).toBeNull()
    const files = readScanExtras({ status: 'running', attention_required: true, processed: 5, total: 9, step: 'scanning' }).stall
    expect(files).toMatchObject({ done: 5, total: 9, pending: 0, item: null })
  })

  test('images that belong to another library are named so they can be moved here', () => {
    const extras = readScanExtras({ status: 'done', skipped_other_library: 2, skipped_other_library_paths: ['D:/a.png', 'D:/b.png', 7] })
    expect(extras.otherLibrary).toEqual({ count: 2, paths: ['D:/a.png', 'D:/b.png'] })
  })

  test('a search for missing files counts the found files that were already in the library', () => {
    const p = readProgress('reconnect', { status: 'done', matched: 2, review_pending_total: 1, conflicts: 3 })
    expect(p).toMatchObject({ succeeded: 2, toReview: 1, alreadyIndexed: 3 })
  })

  test('the scan reader carries them for our run', () => {
    const p = readProgress('scan', { run_id: 4, status: 'running', attention_required: true, stalled_seconds: 60 }, { runId: 4 })
    expect(p.scan?.stall?.seconds).toBe(60)
  })
})
