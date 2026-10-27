import { useCallback, useRef, useState } from 'react'
import type { Batch } from '../../api/types'
import type { MessageKey, Params } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { orderMoves } from './orderMoves'
import { arrange, type GroupName } from './queueSort'
import { groupEntries, groupsOf, titleOf, type SortSpec } from './queueSortRun'
import { useStepViews, useViewKey } from './stepView'
import { useBatchEntries } from './useBatchEntries'

/** A group's or sort's name in the language in use. */
export const nameText = (name: GroupName, t: (key: MessageKey) => string): string => ('key' in name ? t(name.key) : name.text)

/**
 * Sorting a batch's queue into groups (by rating, aesthetic score, resolution
 * or a saved profile). The new order is saved like any move, so one Undo (the
 * Order step's button, Ctrl+Z, or the button on the message) puts it back.
 */
export function useQueueSort(batch: Batch) {
  const source = useBatchEntries(batch)
  const key = useViewKey(batch.id)
  const latest = useRef(source)
  latest.current = source
  const [busy, setBusy] = useState(false)

  const apply = useCallback(
    async (spec: SortSpec) => {
      const t = (k: MessageKey, params?: Params) => tr(k, params)
      const say = useToasts.getState().push
      const entries = latest.current.entries
      if (entries.length < 2) return say(t('partialsb.sort.tooFew'))
      const order = entries.map((entry) => entry.key)
      setBusy(true)
      try {
        const of = await groupEntries(spec, entries)
        const now = latest.current
        if (now.entries.length !== order.length || now.entries.some((entry, i) => entry.key !== order[i])) {
          return say(t('partialsb.sort.changed'), 'error')
        }
        const groups = groupsOf(spec)
        const moves = orderMoves(now, key)
        const moved = moves.set(arrange(order, groups, of))
        const title = titleOf(spec)
        useStepViews.getState().setGrouping(key, { title, groups, of: Object.fromEntries(of), before: order })
        const name = nameText(title, t)
        if (moved) {
          say(t('partialsb.sort.done', { name }), 'info', { label: t('batch.order.undo'), run: () => void orderMoves(latest.current, key).undo() })
        } else {
          say(t('partialsb.sort.already', { name }))
        }
      } catch (error) {
        say(t('partialsb.sort.failed', { reason: (error as Error).message }), 'error')
      } finally {
        setBusy(false)
      }
    },
    [key],
  )

  return { source, key, busy, apply }
}
