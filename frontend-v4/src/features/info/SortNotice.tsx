import { useState } from 'react'
import { useImageCount } from '../../api/queries'
import { useT, type MessageKey } from '../../i18n'
import { usesColorFilter } from '../../lib/colorFilter'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { needsColorData, type SortBase } from '../../lib/sort'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { startColorAnalysis, useColorsMissing } from '../status/colorAnalysis'
import { scoreUnscoredIn } from './aesthetic'
import { unscoredParams } from './scoring'
import styles from './SortNotice.module.css'

// Over the grid when the order (or a filter) depends on data some images do
// not have yet: aesthetic scores, colour analysis. It says how many are
// missing and offers the job that fills them in; it can be put away for the
// current sort or filter. A colour filter that found nothing says it in the
// empty grid instead (library/EmptyResult.tsx).

const usesAesthetic = (sort: string, params: ImageQueryParams) => sort === 'aesthetic' || 'min_aesthetic' in params || 'max_aesthetic' in params

/** Which notice: the one for the aesthetic score, a colour filter that found images, or a colour sort. */
function noticeKey(sort: SortBase, params: ImageQueryParams, found: boolean): string | null {
  if (usesAesthetic(sort, params) && !params.aesthetic_unscored) return `aesthetic:${sort}`
  if (found && usesColorFilter(params)) return 'color-filter'
  return needsColorData(sort) ? `color:${sort}` : null
}

export function SortNotice({ params, found }: { params: ImageQueryParams; found: boolean }) {
  const sort = useApp((s) => s.sort)
  const [hiddenFor, setHiddenFor] = useState<string | null>(null)
  const key = noticeKey(sort, params, found)
  if (!key || hiddenFor === key) return null
  const hide = () => setHiddenFor(key)
  if (key.startsWith('aesthetic:')) return <AestheticNotice params={params} onHide={hide} />
  return <ColorNotice onHide={hide} filter={key === 'color-filter'} />
}

function AestheticNotice({ params, onHide }: { params: ImageQueryParams; onHide: () => void }) {
  const t = useT()
  const unscored = useImageCount(unscoredParams(params))
  const scoring = useJobs((s) => s.jobs.some((j) => j.kind === 'aesthetic' && !isFinished(j.progress.status)))
  const n = unscored.data ?? 0
  if (n === 0) return null
  return (
    <Notice text={t('info.sort.aesUnscored', { n })} onHide={onHide} testId="sort-notice-aesthetic" dismiss="info.sort.dismiss">
      <button type="button" className={styles.link} onClick={() => void scoreUnscoredIn(params)} disabled={scoring} title={t('info.aes.firstUse')}>
        {scoring ? t('info.aes.scoring') : t('info.sort.aesAction', { n })}
      </button>
    </Notice>
  )
}

/** Images with no colour analysis: a colour sort puts them last, a colour filter leaves them out. */
function ColorNotice({ onHide, filter }: { onHide: () => void; filter: boolean }) {
  const t = useT()
  const missing = useColorsMissing()
  const analysing = useJobs((s) => s.jobs.some((j) => j.kind === 'colors' && !isFinished(j.progress.status)))
  const n = missing.data?.missing ?? 0
  if (n === 0) return null
  return (
    <Notice
      text={t(filter ? 'info.filter.colorMissing' : 'info.sort.colorMissing', { n })}
      onHide={onHide}
      testId={filter ? 'color-filter-note' : 'sort-notice-color'}
      dismiss={filter ? 'info.filter.dismiss' : 'info.sort.dismiss'}
    >
      <button type="button" className={styles.link} onClick={() => void startColorAnalysis()} disabled={analysing} data-testid="color-analyse-link">
        {analysing ? t('status.analysing') : t('status.colorHintAction')}
      </button>
    </Notice>
  )
}

interface NoticeProps {
  text: string
  onHide: () => void
  testId: string
  dismiss: MessageKey
  children: React.ReactNode
}

function Notice({ text, onHide, testId, dismiss, children }: NoticeProps) {
  const t = useT()
  return (
    <div className={styles.notice} role="status" data-testid={testId}>
      <p className={styles.text}>
        {text}
        {children}
      </p>
      <button type="button" className="btn btn-ghost btn-icon" onClick={onHide} title={t(dismiss)} aria-label={t(dismiss)}>
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}
