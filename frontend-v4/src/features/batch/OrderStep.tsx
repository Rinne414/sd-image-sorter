import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { Batch } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { unmatched } from './batchFilter'
import { BatchFilterBar } from './BatchFilterBar'
import { HoverPreview, useHoverPreview } from './HoverPreview'
import { stepLabel } from './labels'
import { MarqueeBox } from './MarqueeBox'
import type { GroupMove } from './orderLogic'
import { draggedKeys, movingKeys, orderMoves } from './orderMoves'
import styles from './OrderStep.module.css'
import { OrderTile } from './OrderTile'
import { usePickKeys, useTileDrag } from './pickHooks'
import { clickSelection, keepPresent, NO_PICKS, selectAll, type PickSelection } from './pickLogic'
import { StepBar } from './StepBar'
import { useStepView, useStepViews } from './stepView'
import { useBatchEntries } from './useBatchEntries'
import { useBatchScores } from './useBatchScores'
import { renderedTileRects, useMarquee } from './useMarquee'

const MOVES: readonly { how: GroupMove; label: MessageKey }[] = [
  { how: 'top', label: 'batch.order.top' },
  { how: 'up', label: 'batch.order.up' },
  { how: 'down', label: 'batch.order.down' },
  { how: 'bottom', label: 'batch.order.bottom' },
]

/** Columns the grid currently lays out (for ↑/↓). */
function useColumns(ref: React.RefObject<HTMLElement | null>): number {
  const [cols, setCols] = useState(1)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setCols(Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return cols
}

interface Props {
  batch: Batch
  next: string | null
  onNext: (step: string) => void
}

/**
 * The posting order: large pictures as they will be posted. Click, Ctrl or
 * Shift click select, and so does a box dragged from empty space; a short
 * hover shows a picture larger, and a tile shows its aesthetic score; the buttons, Alt + arrows / Home / End or a drag move
 * the selection together (or the image under the cursor); Ctrl+Z undoes.
 */
export function OrderStep({ batch, next, onNext }: Props) {
  const t = useT()
  const source = useBatchEntries(batch)
  const view = useStepView(batch.id, source.entries)
  const shown = view.shown
  const shownOrder = useMemo(() => shown.map((entry) => entry.key), [shown])
  const positions = useMemo(() => new Map(source.entries.map((entry, i) => [entry.key, i])), [source.entries])
  const stepRef = useRef<HTMLElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const cols = useColumns(gridRef)
  const [cursor, setCursor] = useState(0)
  const [picks, setPicks] = useState<PickSelection>(NO_PICKS)
  const [said, setSaid] = useState('')
  const canUndo = useStepViews((s) => (s.histories[view.key]?.length ?? 0) > 0)
  const selection = useMemo(() => keepPresent(picks, shownOrder), [picks, shownOrder])
  const at = shown.length === 0 ? -1 : Math.min(Math.max(cursor, 0), shown.length - 1)
  const moves = orderMoves(source, view.key)
  const hover = useHoverPreview()
  const scores = useBatchScores(source.entries)

  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  // The cursor follows the first moved image; the live region says where it went.
  const settle = (order: readonly string[] | null, keys: ReadonlySet<string>) => {
    if (!order) return
    const first = order.find((key) => keys.has(key)) ?? ''
    setCursor((view.shownSet ? order.filter((key) => view.shownSet?.has(key)) : order).indexOf(first))
    const n = order.indexOf(first) + 1
    const name = source.entries.find((entry) => entry.key === first)?.filename ?? ''
    setSaid(keys.size === 1 ? t('batch.order.moved', { name, n }) : t('batch.order.movedGroup', { n: keys.size, first: n }))
  }

  const move = (how: GroupMove) => {
    const keys = movingKeys(selection.keys, shownOrder[at])
    settle(moves.move(keys, view.shownSet, how), keys)
  }

  const dropOn = (from: number, over: number, after: boolean) => {
    const key = shownOrder[from]
    const target = shownOrder[over]
    if (key === undefined || target === undefined) return
    const keys = draggedKeys(selection.keys, key)
    settle(moves.drop(keys, target, after), keys)
  }

  const undo = () => setSaid(t(moves.undo() ? 'batch.order.undone' : 'batch.order.noUndo'))

  usePickKeys({
    areaRef: stepRef,
    count: shown.length,
    at,
    cols,
    hasSelection: selection.keys.size > 0,
    moveCursorTo: setCursor,
    reorder: move,
    selectAll: () => setPicks(selectAll(shownOrder)),
    clearSelection: () => setPicks(NO_PICKS),
    undo,
  })
  const drag = useTileDrag(dropOn, setCursor)
  const carried = drag.drag ? draggedKeys(selection.keys, shownOrder[drag.drag.from] ?? '') : null
  const marquee = useMarquee({ scrollRef, tiles: () => renderedTileRects(scrollRef.current), selection, onSelect: setPicks })

  const click = (index: number, e: MouseEvent) => {
    setCursor(index)
    setPicks(clickSelection(selection, shownOrder, index, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }))
  }

  const picked = selection.keys.size
  const cannotMove = at < 0 || source.entries.length < 2
  return (
    <section ref={stepRef} className={styles.step} data-testid="order-step">
      <StepBar count={t('batch.pick.count', { n: source.entries.length })} hint={picked > 0 ? t('batch.order.selected', { n: picked }) : t('batch.order.keys')}>
        {MOVES.map((m) => (
          <button key={m.how} type="button" className="btn" disabled={cannotMove} onClick={() => move(m.how)} data-testid={`order-${m.how}`}>
            {t(m.label)}
          </button>
        ))}
        <button type="button" className="btn btn-ghost" disabled={!canUndo} onClick={undo} title={t('batch.order.undoTip')} data-testid="order-undo">
          {t('batch.order.undo')}
        </button>
        {next && (
          <button type="button" className="btn btn-primary" onClick={() => onNext(next)} data-testid="step-next">
            {t('batch.panel.next', { step: stepLabel(next, t) })}
          </button>
        )}
      </StepBar>
      <BatchFilterBar
        view={view}
        total={source.entries.length}
        hiddenNote={t('batch.order.hiddenNote')}
        onSelectMatches={(keys) => setPicks({ keys, anchor: null })}
      />
      <div
        ref={scrollRef}
        className={styles.scroller}
        tabIndex={0}
        role="listbox"
        aria-multiselectable
        aria-label={t('batch.order.label')}
        data-testid="order-grid"
        {...marquee.handlers}
      >
        {shown.length === 0 ? (
          <p className={styles.empty}>{source.entries.length === 0 ? t('batch.order.empty') : t('batch.filter.noneShown', { text: view.name.trim() })}</p>
        ) : (
          <div ref={gridRef} className={styles.grid}>
            {shown.map((entry, index) => (
              <OrderTile
                key={entry.key}
                batch={batch}
                entry={entry}
                index={index}
                position={positions.get(entry.key) ?? index}
                cursor={index === at}
                selected={selection.keys.has(entry.key)}
                dim={unmatched(view.matches.keys, entry)}
                dragging={carried?.has(entry.key) ?? false}
                drop={carried?.has(entry.key) ? undefined : drag.sideOf(index)}
                score={entry.imageId === null ? undefined : scores.get(entry.imageId)}
                onClick={click}
                onHover={hover.enter}
                onLeave={hover.leave}
                onDragStart={(i, e) => drag.start(i, shownOrder[i] ?? '', e)}
                onDragOver={drag.over}
                onDrop={drag.drop}
                onDragEnd={drag.end}
              />
            ))}
          </div>
        )}
        <MarqueeBox box={marquee.box} />
      </div>
      <HoverPreview batch={batch} shown={marquee.box || drag.drag ? null : hover.shown} />
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
    </section>
  )
}
