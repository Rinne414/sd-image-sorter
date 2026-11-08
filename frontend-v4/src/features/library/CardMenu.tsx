import { useState } from 'react'
import { create } from 'zustand'
import { findLoadedImage } from '../../api/loaded'
import { useImageDetail } from '../../api/queries'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { ContextMenu, type CtxItem } from '../../ui/ContextMenu'
import { cardMenu, menuTarget, say, type ImageAction } from '../selection/actions'
import { useBulkActions, useImageActions } from '../selection/actionOps'

// The right-click menu on a library card (also Shift+F10 / the menu key on
// the inspected card). Its entries come from the shared action list, so it
// offers exactly what the selection bar and Ctrl K offer.

interface Open {
  id: number
  x: number
  y: number
  keyboard: boolean
  /** The pictures of the closed run's stack that was right-clicked ("Group runs"). */
  run?: number[]
}

export const useCardMenu = create<{ open: Open | null; show: (open: Open) => void; close: () => void }>((set) => ({
  open: null,
  show: (open) => set({ open }),
  close: () => set({ open: null }),
}))

/** Open the menu for the card with this id, at the card itself (keyboard). */
export function showCardMenuAtTile(id: number): void {
  const tile =
    document.querySelector<HTMLElement>(`[data-testid="tile"][data-id="${id}"]`) ??
    // a picture inside a closed run's stack ("Group runs") is shown by the stack
    [...document.querySelectorAll<HTMLElement>('[data-testid="tile"][data-run-ids]')].find((el) => el.dataset.runIds?.split(',').includes(String(id))) ??
    null
  const r = tile?.getBoundingClientRect()
  const x = r ? r.left + Math.min(24, r.width / 2) : innerWidth / 2
  const y = r ? r.top + Math.min(24, r.height / 2) : innerHeight / 3
  const run = tile?.dataset.runIds?.split(',').map(Number)
  useCardMenu.getState().show({ id, x, y, keyboard: true, ...(run ? { run } : {}) })
}

export function CardMenu() {
  const open = useCardMenu((s) => s.open)
  if (!open) return null
  return <CardMenuBody key={`${open.id}:${open.x}:${open.y}`} {...open} />
}

function CardMenuBody({ id, x, y, keyboard, run }: Open) {
  const t = useT()
  const close = useCardMenu((s) => s.close)
  // What it acts on is fixed when it opens, like the dialogs it leads to.
  const [target] = useState(() => menuTarget(id, useApp.getState().selection, run))
  const bulk = useBulkActions(target.ids)
  const single = useImageActions(id)
  const runPicked = useApp((s) => target.run === true && target.ids.every((x) => s.selection.includes(x)))
  const detail = useImageDetail(id)
  const filename = findLoadedImage(id)?.filename ?? detail.data?.image.filename ?? '…'
  // On a run's stack, Pick means the whole run: "This image" keeps the cover's own actions.
  const runPick: ImageAction[] = target.run
    ? [{
        id: 'pick-run',
        section: 'mark',
        hint: 'Space',
        label: { key: runPicked ? 'lib.menu.unpickRun' : 'lib.menu.pickRun', params: { n: target.ids.length } },
        run: () => useApp.getState().togglePicks(target.ids),
      }]
    : []
  const plan = cardMenu(target, [...runPick, ...bulk], target.run ? single.filter((a) => a.id !== 'pick') : single, filename)

  const toItem = (a: ImageAction): CtxItem => ({
    id: a.id,
    label: say(t, a.label),
    ...(a.hint ? { hint: a.hint } : {}),
    ...(a.reason ? { hint: say(t, a.reason) } : {}),
    ...(a.danger ? { danger: true } : {}),
    ...(a.disabled ? { disabled: true } : {}),
    ...(a.group ? { group: say(t, a.group) } : {}),
    ...(a.children ? { children: a.children.map(toItem) } : {}),
    ...(a.run ? { onSelect: a.run } : {}),
  })

  return (
    <ContextMenu
      x={x}
      y={y}
      label={t('lib.menu.label')}
      header={say(t, plan.header)}
      groups={plan.groups.map((g) => ({ ...(g.heading ? { heading: say(t, g.heading) } : {}), items: g.actions.map(toItem) }))}
      onClose={close}
      focusFirst={keyboard}
      testId="card-menu"
    />
  )
}
