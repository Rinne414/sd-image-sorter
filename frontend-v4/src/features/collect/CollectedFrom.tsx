import { useQuery } from '@tanstack/react-query'
import { useLang, useT } from '../../i18n'
import { fetchCollectedSource } from './collectApi'
import { sourceLine } from './collectLogic'
import styles from './CollectedFrom.module.css'

function whenText(value: string, lang: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(lang, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** "Collected from <page>" under a picture the program collected (pasted, downloaded, or sent by the browser extension). Nothing for any other picture. */
export function CollectedFrom({ id }: { id: number }) {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const source = useQuery({
    queryKey: ['collect-source', id],
    queryFn: () => fetchCollectedSource(id),
    staleTime: 60_000,
    retry: false,
  })
  if (!source.data) return null
  const line = sourceLine(source.data, { paste: t('collect.source.viaPaste'), url: t('collect.source.viaUrl') }, (v) => whenText(v, lang))
  return (
    <div className={styles.row} data-testid="collected-source">
      <span className={styles.label}>{t('collect.source.label')}</span>
      <span className={styles.name} title={line.title} data-testid="collected-source-name">
        {line.name}
      </span>
      {line.when && <span className={styles.when}>{line.when}</span>}
      {line.pageUrl && (
        <a className={styles.link} href={line.pageUrl} target="_blank" rel="noopener noreferrer" data-testid="collected-source-page">
          {t('collect.source.openPage')}
        </a>
      )}
      {line.imageUrl && (
        <a className={styles.link} href={line.imageUrl} target="_blank" rel="noopener noreferrer" data-testid="collected-source-image">
          {t('collect.source.openPicture')}
        </a>
      )}
    </div>
  )
}
