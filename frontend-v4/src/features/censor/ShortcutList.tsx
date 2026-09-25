import { useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useClickOutside, useLayer } from '../../ui/layers'
import { SHORTCUTS, type ShortcutGroup } from './keys'
import styles from './ShortcutList.module.css'

// "快捷键": every key the editor answers to, from the same table keys.ts
// checks against its own key handling, so the list cannot go out of date.

const GROUPS: { id: ShortcutGroup; label: MessageKey }[] = [
  { id: 'tools', label: 'censor.keys.groupTools' },
  { id: 'edit', label: 'censor.keys.groupEdit' },
  { id: 'review', label: 'censor.keys.groupReview' },
  { id: 'view', label: 'censor.keys.groupView' },
]

/** Mouse gestures are words, so they are translated; key names are shown as printed on the key. */
const GESTURE: Record<string, MessageKey> = {
  'Alt+click': 'censor.keys.altClick',
  'Ctrl+wheel': 'censor.keys.ctrlWheel',
  'Space+drag': 'censor.keys.spaceDrag',
}

const WHEN: Record<'review' | 'outside', MessageKey> = {
  review: 'censor.keys.inReview',
  outside: 'censor.keys.outsideReview',
}

export function ShortcutList() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useLayer(open, () => setOpen(false))
  useClickOutside(ref, open, () => setOpen(false))

  return (
    <div className={styles.wrap} ref={ref}>
      <button type="button" className="btn btn-ghost" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="censor-shortcuts">
        {t('censor.keys.title')}
      </button>
      {open && (
        <div className={styles.popover} role="dialog" aria-label={t('censor.keys.title')} data-testid="censor-shortcut-list">
          {GROUPS.map((group) => (
            <section key={group.id} className={styles.group}>
              <h3>{t(group.label)}</h3>
              <dl>
                {SHORTCUTS.filter((s) => s.group === group.id).map((s) => (
                  <div key={`${s.keys.join()}-${s.label}`} className={styles.row}>
                    <dt>
                      {s.keys.map((k) => {
                        const gesture = GESTURE[k]
                        return <kbd key={k}>{gesture ? t(gesture) : k}</kbd>
                      })}
                    </dt>
                    <dd>
                      {t(s.label)}
                      {(s.when === 'review' || s.when === 'outside') && <span className={styles.when}>{t(WHEN[s.when])}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
