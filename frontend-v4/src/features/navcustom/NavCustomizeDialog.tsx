import { useEffect, useRef, useState, type DragEvent } from 'react'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { Icon } from '../../ui/Icon'
import { isDefaultChoice, moveBy, moveTo, setShown, type NavChoice, type NavDef } from './navChoice'
import type { NavStore } from './navStore'
import styles from './NavCustomizeDialog.module.css'

interface Props {
  /** The interface's own store (its places, its storage key). */
  useStore: <T>(select: (s: NavStore) => T) => T
  defs: readonly NavDef[]
  /** Every place's name in the current language. */
  labels: Readonly<Record<string, string>>
  onClose: () => void
}

type Focus = { id: string; step: -1 | 1 }

/**
 * Customize places: tick the places that stay in the top bar, drag them or use
 * the arrows to set the order, restore the defaults. Changes apply at once.
 * One place always stays in the bar, and the dialog says why when asked to
 * hide the last one.
 */
export function NavCustomizeDialog({ useStore, defs, labels, onClose }: Props) {
  const t = useT()
  const choice = useStore((s) => s.choice)
  const setChoice = useStore((s) => s.set)
  const resetChoice = useStore((s) => s.reset)
  const [notice, setNotice] = useState<string | null>(null)
  const [live, setLive] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [focus, setFocus] = useState<Focus | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)

  const name = (id: string) => labels[id] ?? id
  const inTools = new Set(defs.filter((d) => d.inTools).map((d) => d.id))
  const atDefault = isDefaultChoice(choice, defs)

  // After a move the row has a new place; keep the keyboard on the arrow that
  // was pressed, or on the other one once the row reaches an end.
  useEffect(() => {
    if (!focus) return
    const row = listRef.current?.querySelector(`[data-row="${focus.id}"]`)
    const pressed = row?.querySelector<HTMLButtonElement>(`[data-move="${focus.step}"]`)
    const other = row?.querySelector<HTMLButtonElement>(`[data-move="${-focus.step}"]`)
    ;(pressed && !pressed.disabled ? pressed : other)?.focus()
    setFocus(null)
  }, [focus, choice])

  const apply = (next: NavChoice, id: string) => {
    if (next === choice) return
    setChoice(next)
    setNotice(null)
    setLive(t('navcustom.position', { name: name(id), n: next.order.indexOf(id) + 1 }))
  }

  const toggle = (id: string, shown: boolean) => {
    const result = setShown(choice, id, shown)
    if (result.refused) {
      setNotice(t('navcustom.lastOne'))
      setLive(t('navcustom.lastOne'))
      return
    }
    setNotice(null)
    setChoice(result.choice)
  }

  const onDrop = (e: DragEvent, targetId: string) => {
    e.preventDefault()
    const id = dragId
    setDragId(null)
    setOverId(null)
    if (id && id !== targetId) apply(moveTo(choice, id, choice.order.indexOf(targetId)), id)
  }

  const reset = () => {
    resetChoice()
    setNotice(null)
    setLive(t('navcustom.resetDone'))
  }

  const last = choice.order.length - 1
  return (
    <Dialog
      title={t('navcustom.title')}
      onClose={onClose}
      testId="navcustom-dialog"
      initialFocus={doneRef}
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={reset}
            disabled={atDefault}
            title={atDefault ? t('navcustom.resetNone') : undefined}
            data-testid="navcustom-reset"
          >
            {t('navcustom.reset')}
          </button>
          <span className={styles.spread} />
          <button ref={doneRef} type="button" className="btn btn-primary" onClick={onClose} data-testid="navcustom-done">
            {t('navcustom.done')}
          </button>
        </>
      }
    >
      <p className={styles.body}>{t('navcustom.body')}</p>
      <ul ref={listRef} className={styles.list} aria-label={t('navcustom.list')}>
        {choice.order.map((id, i) => {
          const shown = !choice.hidden.includes(id)
          return (
            <li
              key={id}
              className={styles.row}
              data-row={id}
              data-on={shown || undefined}
              data-dragging={dragId === id || undefined}
              data-over={overId === id && dragId !== id ? (choice.order.indexOf(dragId ?? '') < i ? 'after' : 'before') : undefined}
              draggable
              onDragStart={(e) => {
                setDragId(id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', id)
              }}
              onDragOver={(e) => {
                if (!dragId) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (overId !== id) setOverId(id)
              }}
              onDrop={(e) => onDrop(e, id)}
              onDragEnd={() => {
                setDragId(null)
                setOverId(null)
              }}
              data-testid={`navcustom-row-${id}`}
            >
              <span className={styles.grip} aria-hidden title={t('navcustom.drag')} />
              <label className={styles.pick}>
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={(e) => toggle(id, e.target.checked)}
                  aria-label={t('navcustom.show', { name: name(id) })}
                  data-testid={`navcustom-show-${id}`}
                />
                <span className={styles.name}>{name(id)}</span>
              </label>
              <span className={styles.where}>{shown ? t('navcustom.inBar') : inTools.has(id) ? t('navcustom.inTools') : t('navcustom.inMore')}</span>
              <span className={styles.moves}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon"
                  data-move="-1"
                  disabled={i === 0}
                  title={t('navcustom.moveUp', { name: name(id) })}
                  aria-label={t('navcustom.moveUp', { name: name(id) })}
                  onClick={() => {
                    apply(moveBy(choice, id, -1), id)
                    setFocus({ id, step: -1 })
                  }}
                  data-testid={`navcustom-up-${id}`}
                >
                  <Icon name="up" size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon"
                  data-move="1"
                  disabled={i === last}
                  title={t('navcustom.moveDown', { name: name(id) })}
                  aria-label={t('navcustom.moveDown', { name: name(id) })}
                  onClick={() => {
                    apply(moveBy(choice, id, 1), id)
                    setFocus({ id, step: 1 })
                  }}
                  data-testid={`navcustom-down-${id}`}
                >
                  <span className={styles.flip}>
                    <Icon name="up" size={14} />
                  </span>
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      {notice && (
        <p className={styles.notice} role="alert" data-testid="navcustom-notice">
          {notice}
        </p>
      )}
      <span className={styles.live} role="status" aria-live="polite">
        {live}
      </span>
    </Dialog>
  )
}
