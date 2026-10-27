import { useRef, useState } from 'react'
import type { Batch } from '../../api/types'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { useClickOutside, useLayer } from '../../ui/layers'
import menuStyles from '../../ui/Menu.module.css'
import { ProfileDialog } from './ProfileDialog'
import { SORT_TITLE, type SortKey } from './queueSort'
import { useQueueProfiles } from './queueSortProfiles'
import styles from './QueueSort.module.css'
import { useQueueSort } from './useQueueSort'

const KEYS: readonly SortKey[] = ['rating', 'aesthetic', 'resolution']

interface Props {
  batch: Batch
  /** The narrow film strip of the censor step: a smaller button, the menu opening to the right. */
  compact?: boolean
}

/**
 * "Sort ▾" for a batch's queue: group it by rating, aesthetic score or
 * resolution, or by a saved profile (rules of your own). The Order step shows
 * where each group starts; one Undo puts the queue back.
 */
export function QueueSortMenu({ batch, compact = false }: Props) {
  const t = useT()
  const { source, busy, apply } = useQueueSort(batch)
  const profiles = useQueueProfiles((s) => s.profiles)
  const [open, setOpen] = useState(false)
  const [managing, setManaging] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useLayer(open, () => setOpen(false))
  useClickOutside(ref, open, () => setOpen(false))
  const few = source.entries.length < 2

  const run = (start: () => void) => {
    setOpen(false)
    start()
  }

  return (
    <div className={`${menuStyles.wrap} ${compact ? styles.compact : ''}`} ref={ref}>
      <button
        type="button"
        className={compact ? 'btn btn-sm' : 'btn'}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy || source.loading}
        title={t('partialsb.sort.tip')}
        onClick={() => setOpen(!open)}
        data-testid="queue-sort"
      >
        {busy ? t('partialsb.sort.working') : t('partialsb.sort.button')}
        <span className={menuStyles.caret} aria-hidden>
          <Icon name="caret" size={13} />
        </span>
      </button>
      {open && (
        <ul className={`${menuStyles.menu} ${styles.menu}`} data-align={compact ? undefined : 'right'} role="menu" data-testid="queue-sort-menu">
          <li role="presentation" className={menuStyles.group}>
            {t('partialsb.sort.heading')}
          </li>
          {KEYS.map((key) => (
            <li key={key}>
              <button type="button" role="menuitem" disabled={few} onClick={() => run(() => void apply({ kind: 'builtin', key }))} data-testid={`queue-sort-${key}`}>
                <span className={menuStyles.check} aria-hidden />
                <span className={menuStyles.itemLabel}>{t(SORT_TITLE[key])}</span>
              </button>
            </li>
          ))}
          <li role="presentation" className={menuStyles.group} data-divider>
            {t('partialsb.profile.heading')}
          </li>
          {profiles.length === 0 && <li className={styles.none}>{t('partialsb.profile.none')}</li>}
          {profiles.map((profile) => (
            <li key={profile.id}>
              <button
                type="button"
                role="menuitem"
                disabled={few || profile.rules.length === 0}
                title={profile.rules.map((r) => r.name).join(' · ')}
                onClick={() => run(() => void apply({ kind: 'profile', profile }))}
                data-testid="queue-sort-profile"
                data-profile={profile.name}
              >
                <span className={menuStyles.check} aria-hidden />
                <span className={menuStyles.itemLabel}>{profile.name}</span>
              </button>
            </li>
          ))}
          <li role="presentation" data-divider>
            <button type="button" role="menuitem" onClick={() => run(() => setManaging(true))} data-testid="queue-sort-manage">
              <span className={menuStyles.check} aria-hidden />
              <span className={menuStyles.itemLabel}>{t('partialsb.profile.manage')}</span>
            </button>
          </li>
        </ul>
      )}
      {managing && <ProfileDialog few={few} onClose={() => setManaging(false)} onApply={(profile) => void apply({ kind: 'profile', profile })} />}
    </div>
  )
}
