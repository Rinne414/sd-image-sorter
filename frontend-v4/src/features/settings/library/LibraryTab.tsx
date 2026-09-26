import { useLibraries } from '../../../api/queries'
import { useApp } from '../../../state/store'
import { useAutoRefresh } from '../../library/autoRefreshRun'
import { useSelectionDialog } from '../../selection/dialogs'
import { Section } from '../about/Section'
import { useLT } from '../libraryText'
import { useSaved } from '../useSaved'
import { ClearSection } from './ClearSection'
import styles from './LibrarySettings.module.css'
import { SourcesSection } from './SourcesSection'
import { TagBackupSection } from './TagBackupSection'

/**
 * Settings › Library: the source folders, checking them for new images while
 * idle, managing libraries, the tag backup, and (at the bottom, set apart)
 * clearing this library's index.
 */
export function LibraryTab() {
  return (
    <div className={styles.sections} data-testid="library-settings">
      <SourcesSection />
      <AutoRefreshSection />
      <LibrariesSection />
      <TagBackupSection />
      <ClearSection />
    </div>
  )
}

function AutoRefreshSection() {
  const t = useLT()
  const on = useAutoRefresh((s) => s.on)
  const [saved, mark] = useSaved<'auto'>()
  return (
    <Section title={t('libset.auto.title')} saved={saved === 'auto'} testId="libset-auto">
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            useAutoRefresh.getState().setOn(e.target.checked)
            mark('auto')
          }}
          data-testid="auto-refresh"
        />
        {t('libset.auto.label')}
      </label>
      <p className={styles.hint}>{t('libset.auto.hint')}</p>
    </Section>
  )
}

function LibrariesSection() {
  const t = useLT()
  const libraryId = useApp((s) => s.libraryId)
  const library = useLibraries().data?.libraries.find((l) => l.id === libraryId)
  return (
    <Section title={t('libset.libraries.title')} testId="libset-libraries">
      {library && <p className={styles.lead}>{t('libset.libraries.current', { name: library.name, n: library.image_count })}</p>}
      <p className={styles.hint}>{t('libset.libraries.hint')}</p>
      <div className={styles.row}>
        <button type="button" className="btn" onClick={() => useSelectionDialog.getState().showFor('libraries', null, 1)} data-testid="libset-manage">
          {t('libset.libraries.manage')}
        </button>
      </div>
    </Section>
  )
}
