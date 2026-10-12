import { create } from 'zustand'
import { useT } from '../../i18n'
import type { Page } from '../../lib/route'
import { Dialog } from '../../ui/Dialog'
import { helpTopic, type HelpGroup } from '../command/helpTopics'
import styles from './ShortcutSheet.module.css'

// Ctrl K › 说明 / 快捷键: what a page is for and every key it answers to, from
// the same tables the key handlers are tested against (command/helpTopics.ts),
// so the sheet cannot go out of date.

interface SheetState {
  /** The page whose help is open (null: closed). */
  topic: Page | null
  open: (topic: Page) => void
  close: () => void
}

export const useShortcutSheet = create<SheetState>((set) => ({
  topic: null,
  open: (topic) => set({ topic }),
  close: () => set({ topic: null }),
}))

export function ShortcutSheet() {
  const topic = useShortcutSheet((s) => s.topic)
  if (!topic) return null
  return <Sheet page={topic} />
}

function Sheet({ page }: { page: Page }) {
  const t = useT()
  const close = useShortcutSheet((s) => s.close)
  const topic = helpTopic(page)
  const onlyApp = topic.groups.length === 1 && topic.groups[0]?.id === 'app'
  return (
    <Dialog title={t('help.title', { page: t(topic.name) })} onClose={close} testId="shortcut-sheet" wide>
      <p className={styles.purpose} data-testid="help-purpose">
        {t(topic.purpose)}
      </p>
      {onlyApp && <p className={styles.none}>{t('help.noKeys')}</p>}
      <div className={styles.grid}>
        {topic.groups.map((group) => (
          <Group key={group.id} group={group} />
        ))}
      </div>
    </Dialog>
  )
}

function Group({ group }: { group: HelpGroup }) {
  const t = useT()
  return (
    <section className={styles.group}>
      <h3>{group.part ? t(group.label, { group: t(group.part) }) : t(group.label)}</h3>
      <dl>
        {group.rows.map((row) => (
          <div key={`${row.keys.join()}-${row.label}-${row.note ?? ''}`} className={styles.row}>
            <dt>{row.gesture ? <kbd>{t(row.gesture)}</kbd> : row.keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt>
            <dd>
              {t(row.label)}
              {row.note && <span className={styles.note}> {t(row.note)}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
