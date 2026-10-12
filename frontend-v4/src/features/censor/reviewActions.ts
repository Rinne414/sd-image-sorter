import type { Batch, BatchItem } from '../../api/types'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { isDrawing } from './CanvasView'
import { setRegionOff, toggleAllRegions } from './detection'
import { detectCurrent, opsNow } from './detectRun'
import type { Op } from './ops'
import { approve, regionByNumber, skip, type ReviewItem } from './review'
import type { ReviewActions } from './ReviewPanel'
import { saveAll } from './saving'
import { changeOps, editOf, initialEdit, setReviewed } from './session'

// The review actions for the image open in the editor. Moving on goes through
// the editor's `go`, which saves the image being left (its ops and its
// review mark in one request).

function marks(batch: Batch): ReviewItem[] {
  return batch.items.map((i) => ({ imageId: i.image_id, reviewed: (editOf(batch.id, i.image_id) ?? initialEdit(i)).reviewed }))
}

const say = (text: string) => useToasts.getState().push(text, 'info')

export function reviewActions(batch: Batch, item: BatchItem | undefined, index: number, go: (to: number) => void): ReviewActions {
  const change = (next: (ops: Op[]) => Op[]) => {
    if (!item || isDrawing()) return
    const ops = opsNow(batch.id, item)
    const changed = next(ops)
    if (JSON.stringify(changed) !== JSON.stringify(ops)) changeOps(batch.id, item, changed)
  }
  return {
    approve: () => {
      if (!item || isDrawing()) return
      setReviewed(batch.id, item, true)
      const { next } = approve(marks(batch), index)
      if (next !== null) return go(next)
      void saveAll(batch.id)
      say(tr('censor.review.allDone'))
    },
    skip: () => {
      const { next } = skip(marks(batch), index)
      if (next !== null) go(next)
      else say(tr('censor.review.noOther'))
    },
    toggle: (n) =>
      change((ops) => {
        const region = regionByNumber(ops, n)
        return region ? setRegionOff(ops, region.id, !region.off) : ops
      }),
    toggleAll: () => change(toggleAllRegions),
    redetect: () => {
      if (item) void detectCurrent(batch.id, item)
    },
  }
}
