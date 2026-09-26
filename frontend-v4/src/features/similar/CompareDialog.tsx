import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { ApiError, thumbnailUrl } from '../../api/client'
import { useImageDetail } from '../../api/queries'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { withClip } from './clip'
import { compareDetails, type TagDiff } from './compare'
import styles from './CompareDialog.module.css'
import { useSimilarDialogs } from './dialogs'
import { percent } from './ranking'
import { compareScore } from './similarApi'

/** "Compare these two": side by side, the CLIP likeness, then what differs. */
export function CompareDialog() {
  const pair = useSimilarDialogs((s) => s.compare)
  if (!pair) return null
  return <Compare key={pair.join(':')} a={pair[0]} b={pair[1]} />
}

function Compare({ a, b }: { a: number; b: number }) {
  const t = useT()
  const close = useSimilarDialogs((s) => s.closeCompare)
  const da = useImageDetail(a)
  const db = useImageDetail(b)
  const [showSame, setShowSame] = useState(false)
  const diff = useMemo(() => (da.data && db.data ? compareDetails(da.data, db.data) : null), [da.data, db.data])
  const nameA = da.data?.image.filename ?? `#${a}`
  const nameB = db.data?.image.filename ?? `#${b}`
  const sameCount = diff?.rows.filter((r) => r.same).length ?? 0
  const rows = diff?.rows.filter((r) => showSame || !r.same) ?? []

  return (
    <Dialog title={t('sim.cmp.title')} onClose={close} testId="compare-dialog" wide>
      <div className={styles.pair}>
        {[
          { id: a, name: nameA },
          { id: b, name: nameB },
        ].map((side) => (
          <figure key={side.id} className={styles.side}>
            <img src={thumbnailUrl(side.id, 768)} alt="" className={styles.image} draggable={false} />
            <figcaption className="mono" title={side.name}>
              {side.name}
            </figcaption>
          </figure>
        ))}
      </div>
      <ClipScore a={a} b={b} />
      <section className={styles.section}>
        <header className={styles.head}>
          <h3>{t('sim.cmp.params')}</h3>
          {sameCount > 0 && (
            <button type="button" className={styles.link} onClick={() => setShowSame(!showSame)}>
              {showSame ? t('sim.cmp.hideSame') : t('sim.cmp.showSame', { n: sameCount })}
            </button>
          )}
        </header>
        {diff && rows.length === 0 && <p className={styles.muted}>{t('sim.cmp.sameAll')}</p>}
        {rows.length > 0 && (
          <table className={styles.table} data-testid="compare-params">
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} data-same={r.same || undefined}>
                  <th scope="row">{t(r.label)}</th>
                  <td className="mono">{r.a || '—'}</td>
                  <td className="mono">{r.b || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {diff && <Tags title={t('sim.cmp.promptTags')} diff={diff.promptTags} nameA={nameA} nameB={nameB} testId="compare-prompt-tags" />}
      {diff && <Tags title={t('sim.cmp.tags')} diff={diff.tags} nameA={nameA} nameB={nameB} testId="compare-tags" />}
    </Dialog>
  )
}

function ClipScore({ a, b }: { a: number; b: number }) {
  const t = useT()
  const score = useQuery({ queryKey: ['compare', a, b], queryFn: () => compareScore(a, b), retry: false, staleTime: 60_000 })
  if (score.isPending) return <p className={styles.clip}>{t('sim.cmp.clipWorking')}</p>
  if (score.isSuccess) {
    return (
      <p className={styles.clip} data-testid="compare-clip">
        {t('sim.cmp.clip', { score: percent(score.data) })}
      </p>
    )
  }
  if (score.error instanceof ApiError && score.error.status === 503) {
    return (
      <p className={styles.clip}>
        {t('sim.cmp.clipMissing')}
        <button type="button" className={styles.link} onClick={() => void withClip(() => void score.refetch())}>
          {t('sim.cmp.clipGet')}
        </button>
      </p>
    )
  }
  return <p className={styles.clip}>{t('sim.cmp.clipFailed', { reason: score.error.message })}</p>
}

function Tags({ title, diff, nameA, nameB, testId }: { title: string; diff: TagDiff; nameA: string; nameB: string; testId: string }) {
  const t = useT()
  const none = diff.onlyA.length === 0 && diff.onlyB.length === 0
  return (
    <section className={styles.section} data-testid={testId}>
      <header className={styles.head}>
        <h3>{title}</h3>
        <span className={styles.muted}>{t('sim.cmp.shared', { n: diff.shared })}</span>
      </header>
      {none ? (
        <p className={styles.muted}>{t('sim.cmp.noDiff')}</p>
      ) : (
        <div className={styles.tagCols}>
          {[
            { name: nameA, list: diff.onlyA },
            { name: nameB, list: diff.onlyB },
          ].map((side, i) => (
            <div key={i}>
              <p className={styles.only}>{t('sim.cmp.onlyIn', { name: side.name })}</p>
              <div className={styles.chips}>
                {side.list.map((tag) => (
                  <span key={tag} className="chip">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
