import { useState } from 'react'
import { useImageCount } from '../../api/queries'
import { useT } from '../../i18n'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { needsColorData } from '../../lib/sort'
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
// current sort.

const usesAesthetic = (sort: string, params: ImageQueryParams) => sort === 'aesthetic' || 'min_aesthetic' in params || 'max_aesthetic' in params

export function SortNotice({ params }: { params: ImageQueryParams }) {
  const sort = useApp((s) => s.sort)
  const [hiddenFor, setHiddenFor] = useState<string | null>(null)
  const aesthetic = usesAesthetic(sort, params) && !params.aesthetic_unscored
  const key = aesthetic ? `aesthetic:${sort}` : needsColorData(sort) ? `color:${sort}` : null
  if (!key || hiddenFor === key) return null
  const hide = () => setHiddenFor(key)
  return aesthetic ? <AestheticNotice params={params} onHide={hide} /> : <ColorNotice onHide={hide} />
}

function AestheticNotice({ params, onHide }: { params: ImageQueryParams; onHide: () => void }) {
  const t = useT()
  const unscored = useImageCount(unscoredParams(params))
  const scoring = useJobs((s) => s.jobs.some((j) => j.kind === 'aesthetic' && !isFinished(j.progress.status)))
  const n = unscored.data ?? 0
  if (n === 0) return null
  return (
    <Notice text={t('info.sort.aesUnscored', { n })} onHide={onHide} testId="sort-notice-aesthetic">
      <button type="button" className={styles.link} onClick={() => void scoreUnscoredIn(params)} disabled={scoring} title={t('info.aes.firstUse')}>
        {scoring ? t('info.aes.scoring') : t('info.sort.aesAction', { n })}
      </button>
    </Notice>
  )
}

function ColorNotice({ onHide }: { onHide: () => void }) {
  const t = useT()
  const missing = useColorsMissing()
  const analysing = useJobs((s) => s.jobs.some((j) => j.kind === 'colors' && !isFinished(j.progress.status)))
  const n = missing.data?.missing ?? 0
  if (n === 0) return null
  return (
    <Notice text={t('info.sort.colorMissing', { n })} onHide={onHide} testId="sort-notice-color">
      <button type="button" className={styles.link} onClick={() => void startColorAnalysis()} disabled={analysing}>
        {analysing ? t('status.analysing') : t('status.colorHintAction')}
      </button>
    </Notice>
  )
}

function Notice({ text, onHide, testId, children }: { text: string; onHide: () => void; testId: string; children: React.ReactNode }) {
  const t = useT()
  return (
    <div className={styles.notice} role="status" data-testid={testId}>
      <p className={styles.text}>
        {text}
        {children}
      </p>
      <button type="button" className="btn btn-ghost btn-icon" onClick={onHide} title={t('info.sort.dismiss')} aria-label={t('info.sort.dismiss')}>
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}
