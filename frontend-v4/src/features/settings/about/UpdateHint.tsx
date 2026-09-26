import { useEffect } from 'react'
import { useT } from '../../../i18n'
import { useApp } from '../../../state/store'
import styles from './UpdateHint.module.css'
import { hintVersion } from './updateState'
import { scheduleAutoCheck, useUpdates } from './updateStore'

/**
 * Top bar: "新版本 x.y.z", only when a check found one; it opens About &
 * updates. Also starts the one check after start (Settings › About can turn
 * it off).
 */
export function UpdateHint() {
  const t = useT()
  const version = useUpdates((s) => hintVersion(s.status))
  const openSettings = useApp((s) => s.openSettings)
  useEffect(() => scheduleAutoCheck(), [])

  if (!version) return null
  return (
    <button
      type="button"
      className={`btn ${styles.hint}`}
      onClick={() => openSettings('about')}
      title={t('update.hintTitle', { version })}
      data-testid="update-hint"
    >
      <span className={styles.dot} aria-hidden />
      {t('update.hint', { version })}
    </button>
  )
}
