import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { Batch } from '../../api/types'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { Lightbox } from '../lightbox/Lightbox'
import { AddFolderDialog } from './AddFolderDialog'
import { removingKey, useRemoving } from './batchApi'
import { unmatched } from './batchFilter'
import { BatchFilterBar } from './BatchFilterBar'
import { DropOverlay, useDatasetDrop } from './DatasetDrop'
import { entrySummary, type Entry } from './entries'
import type { GroupMove } from './orderLogic'
import { draggedKeys, movingKeys, orderMoves } from './orderMoves'
import { PickBar } from './PickBar'
import { usePickKeys, useTileDrag } from './pickHooks'
import { clickSelection, keepPresent, NO_PICKS, removalKeys, selectAll, type PickSelection } from './pickLogic'
import styles from './PickStep.module.css'
import { PickTile } from './PickTile'
import { useStepView } from './stepView'
import { useBatchEntries } from './useBatchEntries'

const GAP = 8
const PAD = 16
const CAPTION = 22
const TILE_TARGET = 168

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

interface Props {
  batch: Batch
  next: string | null
  onNext: (step: string) => void
}

/**
 * The pick step: the batch's images in order (a dataset batch's folder images
 * beside its Library ones). Arrows move, Alt + arrows or a drag move the
 * selection (or the one under the cursor), Ctrl/Shift click select, Delete
 * takes the selection (or the one under the cursor) out, Enter opens a
 * Library image. The name filter only narrows the grid: what is hidden is
 * neither selected, moved nor removed.
 */
export function PickStep({ batch, next, onNext }: Props) {
  const t = useT()
  const source = useBatchEntries(batch)
  const view = useStepView(batch.id, source.entries)
  const entries = view.shown
  const order = useMemo(() => entries.map((entry) => entry.key), [entries])
  const positions = useMemo(() => new Map(source.entries.map((entry, i) => [entry.key, i])), [source.entries])
  const scrollRef = useRef<HTMLDivElement>(null)
  const width = useWidth(scrollRef)
  const [cursor, setCursor] = useState(0)
  const [picks, setPicks] = useState<PickSelection>(NO_PICKS)
  const lightboxId = useApp((s) => s.lightboxId)
  const removing = useRemoving((s) => s.keys)
  const dropOver = useDatasetDrop(batch.id, source.isDataset)
  const selection = useMemo(() => keepPresent(picks, order), [picks, order])
  const viewable = useMemo(() => entries.filter((e): e is Entry & { imageId: number } => e.imageId !== null), [entries])
  const summaries = useMemo(() => viewable.map(entrySummary), [viewable])
  const folderCount = useMemo(() => source.entries.filter((e) => e.ref.kind === 'folder').length, [source.entries])

  const inner = Math.max(0, width - 2 * PAD)
  const cols = Math.max(1, Math.floor((inner + GAP) / (TILE_TARGET + GAP)))
  const tileW = (inner - GAP * (cols - 1)) / cols
  const rows = Math.ceil(entries.length / cols)
  const at = entries.length === 0 ? -1 : Math.min(Math.max(cursor, 0), entries.length - 1)

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => tileW + CAPTION + GAP,
    overscan: 3,
    paddingStart: PAD,
    paddingEnd: PAD,
  })

  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, tileW])

  // Follow the lightbox as it steps through the Library images.
  useEffect(() => {
    if (lightboxId === null) return
    const i = entries.findIndex((entry) => entry.imageId === lightboxId)
    if (i >= 0) setCursor(i)
  }, [lightboxId, entries])

  const moveCursorTo = (index: number) => {
    setCursor(index)
    if (index >= 0) virtualizer.scrollToIndex(Math.floor(index / cols), { align: 'auto' })
  }

  const remove = (keys: string[]) => {
    if (keys.length === 0) return
    source.remove(keys)
    setPicks(NO_PICKS)
  }

  const moves = orderMoves(source, view.key)
  // The cursor follows the first moved image.
  const follow = (moved: readonly string[] | null, keys: ReadonlySet<string>) => {
    if (!moved) return
    const first = moved.find((key) => keys.has(key)) ?? ''
    moveCursorTo((view.shownSet ? moved.filter((key) => view.shownSet?.has(key)) : moved).indexOf(first))
  }

  const reorder = (how: GroupMove) => {
    const keys = movingKeys(selection.keys, order[at])
    follow(moves.move(keys, view.shownSet, how), keys)
  }

  const dropOn = (from: number, over: number, after: boolean) => {
    const key = order[from]
    const target = order[over]
    if (key === undefined || target === undefined) return
    const keys = draggedKeys(selection.keys, key)
    follow(moves.drop(keys, target, after), keys)
  }

  const open = (entry: Entry | undefined) => {
    if (entry && entry.imageId !== null) useApp.getState().openLightbox(entry.imageId)
  }

  usePickKeys({
    areaRef: scrollRef,
    count: entries.length,
    at,
    cols,
    hasSelection: selection.keys.size > 0,
    moveCursorTo,
    reorder,
    open: () => open(entries[at]),
    remove: () => remove(removalKeys(selection, order, at)),
    selectAll: () => setPicks(selectAll(order)),
    clearSelection: () => setPicks(NO_PICKS),
  })
  const drag = useTileDrag(dropOn, setCursor)
  const carried = drag.drag ? draggedKeys(selection.keys, order[drag.drag.from] ?? '') : null

  const click = (index: number, e: MouseEvent) => {
    setCursor(index)
    setPicks(clickSelection(selection, order, index, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }))
  }

  const empty = source.loading
    ? t('grid.loading')
    : source.error
      ? t('dataset.loadError', { reason: source.error })
      : source.entries.length > 0
        ? t('batch.filter.noneShown', { text: view.name.trim() })
        : source.isDataset
          ? t('dataset.pickEmpty')
          : t('batch.pick.empty')

  return (
    <section className={styles.step} data-testid="pick-step" data-loading={source.loading || undefined}>
      <PickBar
        batchId={batch.id}
        total={source.entries.length}
        folderCount={folderCount}
        selected={selection.keys.size}
        isDataset={source.isDataset}
        next={next}
        onNext={onNext}
        onRemoveSelected={() => remove(removalKeys(selection, order, at))}
        onClearSelection={() => setPicks(NO_PICKS)}
        onSelectAll={() => setPicks(selectAll(order))}
      />
      <BatchFilterBar
        view={view}
        total={source.entries.length}
        onSelectMatches={(keys) => setPicks({ keys, anchor: null })}
      />
      <div ref={scrollRef} className={styles.scroller} tabIndex={0} role="listbox" aria-multiselectable aria-label={t('batch.pick.count', { n: entries.length })} data-testid="pick-grid">
        {entries.length === 0 ? (
          <p className={styles.empty}>{empty}</p>
        ) : (
          <div className={styles.canvas} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) =>
              entries.slice(row.index * cols, row.index * cols + cols).map((entry, c) => {
                const index = row.index * cols + c
                return (
                  <PickTile
                    key={entry.key}
                    entry={entry}
                    index={index}
                    position={positions.get(entry.key) ?? index}
                    x={PAD + c * (tileW + GAP)}
                    y={row.start}
                    width={tileW}
                    cursor={index === at}
                    selected={selection.keys.has(entry.key)}
                    pending={removing.has(removingKey(batch.id, entry.key))}
                    dim={unmatched(view.matches.keys, entry)}
                    drop={carried?.has(entry.key) ? undefined : drag.sideOf(index)}
                    dragging={carried?.has(entry.key) ?? false}
                    onClick={click}
                    onOpen={open}
                    onRemove={(e) => remove([e.key])}
                    onDragStart={(i, e) => drag.start(i, order[i] ?? '', e)}
                    onDragOver={drag.over}
                    onDrop={drag.drop}
                    onDragEnd={drag.end}
                  />
                )
              }),
            )}
          </div>
        )}
      </div>
      {dropOver && <DropOverlay />}
      {source.isDataset && <AddFolderDialog batchId={batch.id} />}
      <Lightbox images={summaries} total={summaries.length} hasMore={false} fetchMore={noop} pickable={false} />
    </section>
  )
}

function noop(): void {}
