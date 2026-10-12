import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { Batch, BatchStep } from '../../api/types'
import { useT } from '../../i18n'
import { patchBatch } from './batchApi'
import { useBatchDialog } from './dialogStore'
import { currentAfterEdit, enabledSteps, moveStep, moveStepTo, stepState, toggleStep } from './batchLogic'
import { stepLabel } from './labels'
import styles from './StepRail.module.css'

/** The pick step holds the batch's images, so it cannot be switched off. */
const LOCKED = new Set(['pick'])

interface Props {
  batch: Batch
  current: string | null
  onGo: (step: string) => void
}

/** The batch's steps down the left. Edit mode switches steps on/off, reorders them and saves a template. */
export function StepRail({ batch, current, onGo }: Props) {
  const t = useT()
  const [editing, setEditing] = useState(false)

  return (
    <aside className={styles.rail} data-editing={editing || undefined} data-testid="step-rail">
      <div className={styles.head}>
        <h2 className={styles.heading}>{t('batch.rail.title')}</h2>
        <button type="button" className="btn btn-ghost" aria-pressed={editing} onClick={() => setEditing(!editing)} data-testid="rail-edit">
          {editing ? t('batch.rail.done') : t('batch.rail.edit')}
        </button>
      </div>
      {editing ? (
        <EditList batch={batch} />
      ) : (
        <ol className={styles.list}>
          {enabledSteps(batch.steps).map((step, i) => {
            const state = stepState(batch.steps, current, step.id)
            return (
              <li key={step.id}>
                <button
                  type="button"
                  className={styles.step}
                  data-state={state}
                  aria-current={state === 'current' ? 'step' : undefined}
                  onClick={() => onGo(step.id)}
                  data-testid="rail-step"
                  data-step-id={step.id}
                >
                  <span className={`${styles.num} mono`}>{i + 1}</span>
                  <span className={styles.label}>{stepLabel(step.id, t)}</span>
                  {state === 'done' && <span className={styles.done}>{t('batch.rail.stateDone')}</span>}
                </button>
              </li>
            )
          })}
        </ol>
      )}
      {editing && (
        <div className={styles.foot}>
          <p className={styles.hint}>{t('batch.rail.editHint')}</p>
          <button type="button" className="btn" onClick={() => useBatchDialog.getState().show({ type: 'template', batch })} data-testid="save-template">
            {t('batch.rail.saveTemplate')}
          </button>
        </div>
      )}
    </aside>
  )
}

function EditList({ batch }: { batch: Batch }) {
  const t = useT()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const refocus = useRef<string | null>(null)
  const listRef = useRef<HTMLOListElement>(null)

  // A keyboard move re-renders the list; keep the moved step focused.
  useLayoutEffect(() => {
    if (!refocus.current) return
    listRef.current?.querySelector<HTMLElement>(`[data-step-id="${refocus.current}"]`)?.focus()
    refocus.current = null
  })

  const save = (steps: readonly BatchStep[]) => {
    if (steps === batch.steps) return
    const list = [...steps]
    const cur = currentAfterEdit(list, batch.current_step)
    void patchBatch(batch.id, cur !== batch.current_step ? { steps: list, current_step: cur } : { steps: list })
  }

  const onKey = (e: KeyboardEvent, id: string) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    e.stopPropagation()
    refocus.current = id
    save(moveStep(batch.steps, id, e.key === 'ArrowUp' ? -1 : 1))
  }

  const onDrop = (e: DragEvent, index: number) => {
    e.preventDefault()
    if (dragId) save(moveStepTo(batch.steps, dragId, index))
    setDragId(null)
    setOverIndex(null)
  }

  return (
    <ol className={styles.list} ref={listRef}>
      {batch.steps.map((step, i) => {
        const locked = LOCKED.has(step.id)
        return (
          <li
            key={step.id}
            className={styles.editRow}
            draggable
            data-off={!step.enabled || undefined}
            data-over={overIndex === i && dragId !== step.id ? true : undefined}
            data-testid="rail-edit-row"
            onDragStart={(e) => {
              setDragId(step.id)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', step.id)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setOverIndex(i)
            }}
            onDragLeave={() => setOverIndex((o) => (o === i ? null : o))}
            onDrop={(e) => onDrop(e, i)}
            onDragEnd={() => {
              setDragId(null)
              setOverIndex(null)
            }}
          >
            <input
              type="checkbox"
              checked={step.enabled}
              disabled={locked}
              title={locked ? t('batch.rail.pickLocked') : undefined}
              aria-label={t('batch.rail.toggle', { step: stepLabel(step.id, t) })}
              onChange={() => save(toggleStep(batch.steps, step.id))}
            />
            <span className={styles.grip} aria-hidden>
              <Grip />
            </span>
            <button
              type="button"
              className={styles.editName}
              data-step-id={step.id}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              aria-label={t('batch.rail.moveLabel', { step: stepLabel(step.id, t), i: i + 1, n: batch.steps.length })}
              onKeyDown={(e) => onKey(e, step.id)}
            >
              {stepLabel(step.id, t)}
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function Grip() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
      {[2, 7, 12].map((y) => (
        <g key={y}>
          <circle cx="3" cy={y} r="1.1" />
          <circle cx="7" cy={y} r="1.1" />
        </g>
      ))}
    </svg>
  )
}
