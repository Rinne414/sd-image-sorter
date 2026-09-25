import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BatchItem } from '../../api/types'
import type { Op, StrokeOp } from './ops'
import { ItemGoneError, runSave, saveOutcome, type WriteOps } from './saveFlow'
import { changeOps, editOf, itemStatus, setReviewed, syncItems, unsavedIds, useCensorSession } from './session'

const BATCH = 3
const IMAGE = 11
const UNKNOWN = 'unknown error'

const stroke = (id: string): StrokeOp => ({ type: 'stroke', id, tool: 'brush', style: 'mosaic', size: 10, block: 4, color: '#000000', opacity: 100, points: [1, 1] })

function item(over: Partial<BatchItem> = {}): BatchItem {
  return { image_id: IMAGE, position: 0, filename: 'a.png', width: 8, height: 8, output_name: null, has_censored: false, censored_at: null, item_state: null, ...over }
}

function track(): void {
  syncItems({
    id: BATCH,
    library_id: 'main',
    kind: 'pixiv',
    name: 'b',
    current_step: 'censor',
    revision: 1,
    archived_at: null,
    created_at: '',
    updated_at: '',
    item_count: 1,
    censored_count: 0,
    steps: [],
    settings: {},
    dataset_project_id: null,
    items: [item()],
  })
}

const save = (write: WriteOps, force = false) => runSave(BATCH, IMAGE, write, { force, unknownReason: UNKNOWN })

beforeEach(() => {
  useCensorSession.setState({ edits: {}, libraries: {}, lastImage: {} })
  track()
})

describe('saving one image', () => {
  it('a failed request leaves the image unsaved with the reason; the retry saves it', async () => {
    changeOps(BATCH, item(), [stroke('a')])
    const ops = editOf(BATCH, IMAGE)?.ops as Op[]
    const write = vi.fn<WriteOps>().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce(undefined)

    expect(await save(write)).toBe(false)
    expect(write).toHaveBeenCalledWith(ops, null)
    const failed = editOf(BATCH, IMAGE)
    expect(failed).toMatchObject({ error: 'HTTP 500', saving: false, saved: [] })
    // never counted as censored: the server did not take the copy
    expect(itemStatus(item(), failed)).toBe('error')
    expect(unsavedIds(BATCH)).toEqual([IMAGE])

    expect(await save(write)).toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith(ops, null)
    const saved = editOf(BATCH, IMAGE)
    expect(saved?.saved).toBe(ops)
    expect(saved?.error).toBeNull()
    expect(itemStatus(item({ has_censored: true }), saved)).toBe('saved')
    expect(unsavedIds(BATCH)).toEqual([])
  })

  it('a failure without a message still shows a reason', async () => {
    changeOps(BATCH, item(), [stroke('a')])
    expect(await save(() => Promise.reject(new Error('')))).toBe(false)
    expect(editOf(BATCH, IMAGE)?.error).toBe(UNKNOWN)
  })

  it('nothing changed: nothing is sent, unless forced', async () => {
    const write = vi.fn<WriteOps>().mockResolvedValue(undefined)
    expect(await save(write)).toBe(true)
    expect(write).not.toHaveBeenCalled()
    expect(await save(write, true)).toBe(true)
    expect(write).toHaveBeenCalledWith([], null)
  })

  it('a save asked for while one runs runs again with the newest ops', async () => {
    changeOps(BATCH, item(), [stroke('a')])
    const first = editOf(BATCH, IMAGE)?.ops as Op[]
    let finish: () => void = () => {}
    const write = vi
      .fn<WriteOps>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
      .mockResolvedValueOnce(undefined)

    const running = save(write)
    changeOps(BATCH, item(), [...first, stroke('b')])
    const newest = editOf(BATCH, IMAGE)?.ops as Op[]
    // the second ask waits for the save that carries it, not for the one running now
    const queued = save(write)
    expect(editOf(BATCH, IMAGE)?.again).toBe(true)
    finish()

    expect(await running).toBe(true)
    expect(await queued).toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenNthCalledWith(1, first, null)
    expect(write).toHaveBeenNthCalledWith(2, newest, null)
    expect(editOf(BATCH, IMAGE)?.saved).toBe(newest)
  })

  it('a queued save reports the retry: a failing retry is a failure with its reason, never an early "saved"', async () => {
    changeOps(BATCH, item(), [stroke('a')])
    let finish: () => void = () => {}
    const write = vi
      .fn<WriteOps>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
      .mockRejectedValueOnce(new Error('disk full'))

    const running = save(write)
    changeOps(BATCH, item(), [stroke('a'), stroke('b')])
    const queued = save(write)
    let settled = false
    void queued.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    expect(await queued).toBe(false)
    expect(await running).toBe(false)
    const edit = editOf(BATCH, IMAGE)
    expect(saveOutcome(false, edit)).toEqual({ ok: false, reason: 'disk full' })
    expect(unsavedIds(BATCH)).toEqual([IMAGE])
  })

  it('what a save means for a job: saved; newer edits still to save (fine); failed; gone', () => {
    const edit = editOf(BATCH, IMAGE)
    expect(saveOutcome(true, edit)).toEqual({ ok: true })
    expect(saveOutcome(false, edit && { ...edit, error: null })).toEqual({ ok: true })
    expect(saveOutcome(false, edit && { ...edit, error: 'HTTP 500' })).toEqual({ ok: false, reason: 'HTTP 500' })
    expect(saveOutcome(false, undefined)).toEqual({ ok: false, reason: null })
  })

  it('the review mark is saved with the ops: a new mark alone makes the image unsaved', async () => {
    const write = vi.fn<WriteOps>().mockResolvedValue(undefined)
    setReviewed(BATCH, item(), false)
    expect(unsavedIds(BATCH)).toEqual([IMAGE])
    expect(await save(write)).toBe(true)
    expect(write).toHaveBeenLastCalledWith([], false)
    expect(editOf(BATCH, IMAGE)).toMatchObject({ reviewed: false, savedReviewed: false })
    expect(unsavedIds(BATCH)).toEqual([])

    changeOps(BATCH, item(), [stroke('a')])
    setReviewed(BATCH, item(), true)
    expect(await save(write)).toBe(true)
    expect(write).toHaveBeenLastCalledWith([stroke('a')], true)
    // the same mark again changes nothing
    setReviewed(BATCH, item(), true)
    expect(unsavedIds(BATCH)).toEqual([])
  })

  it('an item that no longer exists is forgotten, not retried', async () => {
    changeOps(BATCH, item(), [stroke('a')])
    expect(await save(() => Promise.reject(new ItemGoneError('gone')))).toBe(false)
    expect(editOf(BATCH, IMAGE)).toBeUndefined()
    expect(unsavedIds(BATCH)).toEqual([])
  })
})
