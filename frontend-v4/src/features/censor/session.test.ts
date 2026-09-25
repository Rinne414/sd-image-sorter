import { beforeEach, describe, expect, it } from 'vitest'
import type { Batch, BatchItem } from '../../api/types'
import type { StrokeOp } from './ops'
import {
  changeOps,
  editOf,
  initialEdit,
  isDirty,
  itemStatus,
  needsCopy,
  patchEdit,
  reconcile,
  redoEdit,
  rememberImage,
  startImage,
  syncItems,
  undoEdit,
  unsavedIds,
  useCensorSession,
} from './session'

const stroke: StrokeOp = { type: 'stroke', id: 's', tool: 'brush', style: 'mosaic', size: 10, block: 4, color: '#000000', opacity: 100, points: [1, 1] }

function item(id: number, over: Partial<BatchItem> = {}): BatchItem {
  return { image_id: id, position: id, filename: `${id}.png`, width: 8, height: 8, output_name: null, has_censored: false, censored_at: null, item_state: null, ...over }
}

function batch(items: BatchItem[]): Batch {
  return {
    id: 7,
    library_id: 'main',
    kind: 'pixiv',
    name: 'b',
    current_step: 'censor',
    revision: 1,
    archived_at: null,
    created_at: '',
    updated_at: '',
    item_count: items.length,
    censored_count: items.filter((i) => i.has_censored).length,
    steps: [],
    settings: {},
    dataset_project_id: null,
    items,
  }
}

const withOps = { censor: { v: 1, width: 8, height: 8, ops: [stroke] } }

beforeEach(() => useCensorSession.setState({ edits: {}, libraries: {}, lastImage: {} }))

describe('censor session', () => {
  it('an image counts as censored only when its copy exists', () => {
    expect(itemStatus(item(1), undefined)).toBe('clean')
    expect(itemStatus(item(1, { has_censored: true, item_state: withOps }), undefined)).toBe('saved')
    // ops stored but the copy is missing: not censored, saved again on leave
    expect(itemStatus(item(1, { item_state: withOps }), undefined)).toBe('dirty')
    const failing = { ...initialEdit(item(1)), ops: [stroke], error: 'HTTP 500' }
    expect(itemStatus(item(1), failing)).toBe('error')
    expect(itemStatus(item(1), { ...failing, error: null, saving: true })).toBe('saving')
  })

  it('a copy that went away makes saved ops unsaved again', () => {
    const saved = initialEdit(item(1, { has_censored: true, item_state: withOps }))
    expect(reconcile(saved, item(1, { has_censored: true, item_state: withOps }))).toBe(saved)
    expect(reconcile(saved, item(1, { item_state: withOps })).saved).toBeNull()
    const busy = { ...saved, saving: true }
    expect(reconcile(busy, item(1))).toBe(busy)
  })

  it('keeps undo history per image while other images change', () => {
    const b = batch([item(1), item(2)])
    syncItems(b)
    expect(useCensorSession.getState().libraries[7]).toBe('main')
    changeOps(7, item(1), [stroke])
    changeOps(7, item(2), [stroke])
    expect(unsavedIds(7).sort()).toEqual([1, 2])
    expect(undoEdit(7, 1)).toBe(true)
    expect(editOf(7, 1)?.ops).toEqual([])
    expect(editOf(7, 2)?.ops).toEqual([stroke])
    syncItems(b)
    expect(redoEdit(7, 1)).toBe(true)
    expect(editOf(7, 1)?.ops).toEqual([stroke])
    expect(undoEdit(7, 2)).toBe(true)
    expect(undoEdit(7, 2)).toBe(false)
  })

  it('a saved edit is no longer unsaved; a later stroke makes it unsaved again', () => {
    syncItems(batch([item(1)]))
    changeOps(7, item(1), [stroke])
    const ops = editOf(7, 1)!.ops
    patchEdit(7, 1, { saved: ops })
    expect(unsavedIds(7)).toEqual([])
    changeOps(7, item(1), [...ops, { ...stroke, id: 't' }])
    expect(unsavedIds(7)).toEqual([1])
    undoEdit(7, 1)
    expect(unsavedIds(7)).toEqual([])
  })

  it('opens on the image left last, else the first one without a copy', () => {
    const b = batch([item(1, { has_censored: true }), item(2), item(3)])
    expect(startImage(b)).toBe(2)
    rememberImage(7, 3)
    expect(startImage(b)).toBe(3)
    expect(startImage(batch([]))).toBeNull()
  })

  it('an approved image always has a copy (the export uses it), even with nothing to censor', () => {
    expect(needsCopy([], null)).toBe(false)
    expect(needsCopy([], false)).toBe(false)
    expect(needsCopy([], true)).toBe(true)
    expect(needsCopy([stroke], null)).toBe(true)
    expect(needsCopy([stroke], false)).toBe(true)
    const approvedNothing = { censor: { v: 1, width: 8, height: 8, ops: [], reviewed: true } }
    // approved, nothing to censor, no copy yet: unsaved, so leaving the image makes the copy
    expect(itemStatus(item(1, { item_state: approvedNothing }), undefined)).toBe('dirty')
    expect(itemStatus(item(1, { item_state: approvedNothing, has_censored: true }), undefined)).toBe('saved')
    // waiting for review with nothing found: no copy is needed
    const waitingNothing = { censor: { v: 1, width: 8, height: 8, ops: [], reviewed: false } }
    expect(itemStatus(item(1, { item_state: waitingNothing }), undefined)).toBe('clean')
    // the copy went away while the image stays approved: saved again on leave
    const known = initialEdit(item(1, { item_state: approvedNothing, has_censored: true }))
    expect(isDirty(reconcile(known, item(1, { item_state: approvedNothing })))).toBe(true)
  })
})
