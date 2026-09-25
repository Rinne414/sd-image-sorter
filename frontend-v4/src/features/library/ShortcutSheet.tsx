import { create } from 'zustand'
import { useT, type MessageKey } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { SHORTCUT_GROUPS, SHORTCUTS } from './keys'
import styles from './ShortcutSheet.module.css'

// Ctrl K › 快捷键: every key the library and the big image answer to, from
// the same table keys.ts maps keys with, so the sheet cannot go out of date.

export const useShortcutSheet = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** Mouse gestures are words, so they are translated; key names are shown as printed on the key. */
const GESTURE: Record<string, MessageKey> = {
  ctrlClick: 'lib.keys.gesture.ctrlClick',
  shiftClick: 'lib.keys.gesture.shiftClick',
  rightClick: 'lib.keys.gesture.rightClick',
  doubleClick: 'lib.keys.gesture.doubleClick',
  drag: 'lib.keys.gesture.drag',
}

export function ShortcutSheet() {
  const open = useShortcutSheet((s) => s.open)
  if (!open) return null
  return <Sheet />
}

function Sheet() {
  const t = useT()
  const setOpen = useShortcutSheet((s) => s.setOpen)
  return (
    <Dialog title={t('lib.keys.title')} onClose={() => setOpen(false)} testId="shortcut-sheet" wide>
      <div className={styles.grid}>
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.id} className={styles.group}>
            <h3>{t(group.label)}</h3>
            <dl>
              {SHORTCUTS.filter((s) => s.group === group.id).map((s) => (
                <div key={`${s.keys.join()}-${s.label}`} className={styles.row}>
                  <dt>
                    {s.keys.map((k) => {
                      const gesture = s.pointer ? GESTURE[k] : undefined
                      return <kbd key={k}>{gesture ? t(gesture) : k}</kbd>
                    })}
                  </dt>
                  <dd>{t(s.label)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
