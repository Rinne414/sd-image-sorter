import { useEffect, useState, type DragEvent, type RefObject } from 'react'
import { isTypingTarget } from '../../lib/format'
import { useApp } from '../../state/store'
import { layerCount } from '../../ui/layers'
import { moveCursor } from './batchLogic'
import { groupMove, type GroupMove } from './orderLogic'

export interface PickKeyActions {
  /** Keys count while the focus is in here (or nowhere). */
  areaRef: RefObject<HTMLElement | null>
  count: number
  at: number
  cols: number
  hasSelection: boolean
  moveCursorTo: (index: number) => void
  reorder: (how: GroupMove) => void
  selectAll: () => void
  clearSelection: () => void
  open?: () => void
  remove?: () => void
  undo?: () => void
}

/** Ctrl + a key: Ctrl+A selects all, Ctrl+Z undoes where the step can. Whether it was handled. */
function ctrlKey(e: KeyboardEvent, a: PickKeyActions): boolean {
  const key = e.key.toLowerCase()
  if (key === 'a' && a.count > 0) a.selectAll()
  else if (key === 'z' && !e.shiftKey && a.undo) a.undo()
  else return false
  return true
}

/**
 * A batch grid's keys, while nothing else has the focus: arrows move,
 * Alt + arrows / Home / End move the selection (or the image under the
 * cursor), Ctrl+A selects all, Enter opens, Delete removes (a held key only
 * once), Esc drops the selection, Ctrl+Z undoes a reorder where offered.
 */
export function usePickKeys(a: PickKeyActions): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (layerCount() > 0 || useApp.getState().page !== 'batch' || isTypingTarget(e.target) || e.metaKey) return
      const target = e.target as Node
      if (target !== document.body && !a.areaRef.current?.contains(target)) return
      const nav = e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End'
      if (e.ctrlKey) {
        if (!ctrlKey(e, a)) return
      } else if (e.altKey) {
        const how = groupMove(e.key)
        if (how === null || a.at < 0) return
        a.reorder(how)
      } else if (nav) a.moveCursorTo(moveCursor(a.at, a.count, a.cols, e.key))
      else if (e.key === 'Enter' && a.at >= 0 && a.open) a.open()
      else if (e.key === 'Delete' && a.remove) {
        if (!e.repeat) a.remove()
      } else if (e.key === 'Escape' && a.hasSelection) a.clearSelection()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

interface Drag {
  from: number
  over: number
  after: boolean
}

/** Reordering tiles by dragging one (and the selection it belongs to) onto another's left or right half. */
export function useTileDrag(onDrop: (from: number, over: number, after: boolean) => void, onPick: (index: number) => void) {
  const [drag, setDrag] = useState<Drag | null>(null)

  const start = (index: number, key: string, e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', key)
    onPick(index)
    setDrag({ from: index, over: index, after: false })
  }

  const over = (index: number, e: DragEvent<HTMLDivElement>) => {
    if (!drag) return
    e.preventDefault()
    const box = e.currentTarget.getBoundingClientRect()
    const after = e.clientX > box.left + box.width / 2
    if (drag.over !== index || drag.after !== after) setDrag({ ...drag, over: index, after })
  }

  const drop = (e: DragEvent<HTMLDivElement>) => {
    if (!drag) return
    e.preventDefault()
    onDrop(drag.from, drag.over, drag.after)
    setDrag(null)
  }

  /** Where a tile shows the landing mark, if it does. */
  const sideOf = (index: number): 'before' | 'after' | undefined =>
    drag && drag.over === index && drag.from !== index ? (drag.after ? 'after' : 'before') : undefined

  return { drag, start, over, drop, end: () => setDrag(null), sideOf }
}
