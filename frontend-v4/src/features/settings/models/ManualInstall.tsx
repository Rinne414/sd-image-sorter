import styles from './ModelCard.module.css'
import { safeUrl } from './modelCards'
import { copyModelPath, openModelFolder } from './modelsApi'
import { isModelKey, useMT, type ModelKey } from './modelText'
import type { ModelCenterCard } from './types'

/**
 * "Install by hand", folded: where the files go (copy the path, open the
 * folder), what this model needs there, and its download pages.
 */
export function ManualInstall({ card }: { card: ModelCenterCard }) {
  const mt = useMT()
  const extra = `mc.manual.extra.${card.id}`
  const links = (card.external_links ?? []).flatMap((l) => {
    const url = safeUrl(l.url)
    return url ? [{ url, label: l.label || mt('mc.manual.page') }] : []
  })
  const paths: [ModelKey, string | null | undefined][] = [
    ['mc.manual.path', card.path],
    ['mc.manual.runtimePath', card.runtime_path],
    ['mc.manual.textPath', card.text_path],
  ]
  return (
    <details className={styles.manual} data-testid="model-manual">
      <summary>{mt('mc.manual.title')}</summary>
      <div className={styles.manualBody}>
        <p className={styles.note}>{mt('mc.manual.how')}</p>
        {isModelKey(extra) && <p className={styles.note}>{mt(extra)}</p>}
        {paths.map(([label, path]) => (path ? <PathRow key={label} label={mt(label)} path={path} /> : null))}
        {links.length > 0 && (
          <div className={styles.links}>
            {links.map((l) => (
              <a key={l.url} className={`btn ${styles.small}`} href={l.url} target="_blank" rel="noopener noreferrer">
                {l.label} ↗
              </a>
            ))}
          </div>
        )}
      </div>
    </details>
  )
}

function PathRow({ label, path }: { label: string; path: string }) {
  const mt = useMT()
  return (
    <div className={styles.pathRow} data-testid="model-path">
      <span className={styles.pathLabel}>{label}</span>
      <code className={`${styles.path} mono`}>{path}</code>
      <div className={styles.pathButtons}>
        <button type="button" className={`btn ${styles.small}`} onClick={() => void copyModelPath(path)}>
          {mt('mc.manual.copy')}
        </button>
        <button type="button" className={`btn ${styles.small}`} onClick={() => void openModelFolder(path)}>
          {mt('mc.manual.open')}
        </button>
      </div>
    </div>
  )
}
