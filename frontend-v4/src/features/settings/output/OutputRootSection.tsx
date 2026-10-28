import { useState } from 'react'
import { useT } from '../../../i18n'
import { OUTPUT_FEATURES, type OutputFeature, type OutputFolders } from '../../output/outputFolders'
import { saveOutputRoot, useOutputFolders } from '../../output/outputApi'
import { FolderChooser } from '../../../ui/FolderChooser'
import { useToasts } from '../../../ui/toasts'
import { Section } from '../about/Section'
import { SettingRow } from '../SettingRow'
import { useSaved } from '../useSaved'
import styles from './OutputRoot.module.css'

const FEATURE_LABEL = {
  censor: 'desktop.out.feature.censor',
  publish: 'desktop.out.feature.publish',
  'video-censor': 'desktop.out.feature.video-censor',
  workflows: 'desktop.out.feature.workflows',
  collected: 'desktop.out.feature.collected',
} as const satisfies Record<OutputFeature, string>

/** Settings › Disk & cache › Where saves go: one root, and a folder per feature under it. */
export function OutputRootSection() {
  const t = useT()
  const query = useOutputFolders()
  const out = query.data
  const [saved, mark] = useSaved<'root'>()
  const [choosing, setChoosing] = useState(false)
  // What is typed shows until it is saved (Enter or leaving the box) or the server's value replaces it.
  const [typed, setTyped] = useState<string | null>(null)

  const save = async (root: string): Promise<boolean> => {
    try {
      await saveOutputRoot(root.trim())
      setTyped(null)
      mark('root')
      return true
    } catch (error) {
      useToasts.getState().push(t('desktop.out.saveFailed', { reason: error instanceof Error ? error.message : String(error) }), 'error')
      setTyped(null)
      return false
    }
  }

  if (query.isPending) return null
  if (!out) {
    return (
      <Section title={t('desktop.out.title')} testId="output-root">
        <p className={styles.error} role="alert" data-testid="output-root-failed">
          {t('desktop.out.loadFailed', { reason: query.error?.message ?? '' })}
        </p>
        <button type="button" className="btn" onClick={() => void query.refetch()}>
          {t('desktop.retry')}
        </button>
      </Section>
    )
  }

  return (
    <Section title={t('desktop.out.title')} saved={saved === 'root'} testId="output-root">
      <SettingRow title={t('desktop.out.label')} body={t('desktop.out.current', { path: out.root })}>
        <input
          className={`${styles.input} mono`}
          value={typed ?? out.custom_root}
          placeholder={t('desktop.out.placeholder')}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('desktop.out.label')}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => typed !== null && typed.trim() !== out.custom_root && void save(typed)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          data-testid="output-root-input"
        />
        <button type="button" className="btn" onClick={() => setChoosing(true)} data-testid="output-root-browse">
          {t('desktop.out.browse')}
        </button>
        <button type="button" className="btn btn-ghost" disabled={!out.custom_root} onClick={() => void save('')} data-testid="output-root-reset">
          {t('desktop.out.reset')}
        </button>
      </SettingRow>
      <FeatureFolders out={out} />
      {choosing && (
        <FolderChooser
          title={t('desktop.out.chooseTitle')}
          confirmLabel={t('desktop.out.chooseOk')}
          start={out.custom_root || null}
          shortcuts={[{ heading: t('desktop.out.builtin'), paths: [out.builtin_root] }]}
          onChoose={save}
          onClose={() => setChoosing(false)}
          testId="output-root-picker"
        />
      )}
    </Section>
  )
}

function FeatureFolders({ out }: { out: OutputFolders }) {
  const t = useT()
  return (
    <details className={styles.more}>
      <summary>{t('desktop.out.folders')}</summary>
      <dl className={styles.folders} data-testid="output-root-folders">
        {OUTPUT_FEATURES.map((feature) => (
          <div key={feature} className={styles.folderRow}>
            <dt>{t(FEATURE_LABEL[feature])}</dt>
            <dd className="mono">{out.folders[feature] ?? ''}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
