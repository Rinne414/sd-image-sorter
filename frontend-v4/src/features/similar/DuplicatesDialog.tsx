import { useState } from 'react'
import { thumbnailUrl } from '../../api/client'
import { useLang, useT } from '../../i18n'
import { fileSize } from '../../lib/format'
import { Dialog } from '../../ui/Dialog'
import { Icon } from '../../ui/Icon'
import { useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { useSelectionDialog } from '../selection/dialogs'
import { withClip } from './clip'
import { useSimilarDialogs } from './dialogs'
import { keeperOf, othersOf, THRESHOLDS, type DupGroup, type DupMember, type DupSummary } from './duplicates'
import styles from './Duplicates.module.css'
import { percent } from './ranking'
import { fetchAllGroups, startDuplicateScan, startIndexing, useDuplicateReview, useIndexStats } from './similarApi'

// Library status › duplicates: scan the library for near-duplicate groups,
// keep one per group and send the rest to the Recycle Bin (or out of the
// library). Removing goes through the same confirm as the selection bar
// (D15: the danger button, focus on Cancel).

const THRESHOLD_LABEL = { 0.98: 'sim.dup.strict', 0.95: 'sim.dup.normal', 0.9: 'sim.dup.loose' } as const

const confirmFor = (kind: 'trash' | 'remove', ids: number[]) => useSelectionDialog.getState().showFor(kind, ids, ids.length)

export function DuplicatesDialog() {
  const open = useSimilarDialogs((s) => s.duplicates)
  if (!open) return null
  return <Review />
}

function Review() {
  const t = useT()
  const close = () => useSimilarDialogs.getState().setDuplicates(false)
  const review = useDuplicateReview()
  const [chosen, setChosen] = useState<ReadonlyMap<number, number>>(new Map())
  const first = review.data?.pages[0]?.page
  const groups = review.data?.pages.flatMap((p) => p.groups) ?? []
  const seen = review.data?.pages.reduce((n, p) => n + p.page.groups.length, 0) ?? 0

  return (
    <Dialog title={t('sim.dup.title')} onClose={close} testId="duplicates-dialog" wide="x">
      <IndexNote />
      <ScanControls summary={first?.summary ?? null} scannedAt={first?.scanned_at ?? null} />
      {review.isPending && <p className={styles.muted}>{t('sim.dup.loading')}</p>}
      {review.isError && <p className={styles.error}>{t('sim.dup.failed', { reason: review.error.message })}</p>}
      {first && !first.available && <p className={styles.muted}>{t('sim.dup.never')}</p>}
      {first?.available && groups.length === 0 && !review.hasNextPage && <p className={styles.muted}>{t('sim.dup.none')}</p>}
      {groups.length > 0 && <ApplyAll chosen={chosen} />}
      <ol className={styles.groups} data-testid="duplicate-groups">
        {groups.map((g) => (
          <Group key={g.group_id} group={g} keeper={keeperOf(g, chosen.get(g.group_id))} onKeep={(id) => setChosen(new Map(chosen).set(g.group_id, id))} />
        ))}
      </ol>
      {review.hasNextPage && (
        <button type="button" className="btn btn-ghost" onClick={() => void review.fetchNextPage()} disabled={review.isFetchingNextPage}>
          {review.isFetchingNextPage ? t('sim.dup.loading') : t('sim.dup.more', { n: Math.max(0, (first?.total_groups ?? 0) - seen) })}
        </button>
      )}
    </Dialog>
  )
}

/** Only the embedded images can be compared: say how many are not, and offer to add them. */
function IndexNote() {
  const t = useT()
  const stats = useIndexStats()
  const indexing = useJobs((s) => s.jobs.some((j) => j.kind === 'embed' && !isFinished(j.progress.status)))
  const data = stats.data
  if (!data) return null
  return (
    <p className={styles.coverage} data-testid="duplicates-coverage">
      {t('sim.dup.coverage', { embedded: data.embedded_count, total: data.total_images })}
      {data.pending_count > 0 && (
        <>
          {' · '}
          {t('sim.dup.coveragePending', { n: data.pending_count })}
          <button type="button" className={styles.link} disabled={indexing} onClick={() => void withClip(() => void startIndexing())}>
            {indexing ? t('sim.index.building') : t('sim.index.build')}
          </button>
        </>
      )}
    </p>
  )
}

function ScanControls({ summary, scannedAt }: { summary: DupSummary | null; scannedAt: number | null }) {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const [threshold, setThreshold] = useState<number>(summary?.threshold ?? 0.95)
  const scan = useJobs((s) => s.jobs.find((j) => j.kind === 'dupscan' && !isFinished(j.progress.status)))
  const when = scannedAt ? new Date(scannedAt * 1000).toLocaleString(lang) : null
  return (
    <div className={styles.scan}>
      {when && summary && (
        <p className={styles.muted}>
          {t('sim.dup.lastScan', { when, threshold: percent(summary.threshold) })}
          {' · '}
          {t('sim.dup.summary', { groups: summary.group_count, extra: summary.redundant_count, size: fileSize(summary.reclaimable_bytes) || '0 KB' })}
        </p>
      )}
      <fieldset className={styles.thresholds}>
        <legend>{t('sim.dup.threshold')}</legend>
        {THRESHOLDS.map((v) => (
          <label key={v}>
            <input type="radio" name="dup-threshold" checked={Math.abs(threshold - v) < 1e-6} onChange={() => setThreshold(v)} />
            {t(THRESHOLD_LABEL[v])}
          </label>
        ))}
      </fieldset>
      <button type="button" className="btn" onClick={() => void startDuplicateScan(threshold)} disabled={!!scan} data-testid="duplicates-scan">
        {scan ? t('sim.dup.scanning', { p: Math.round((scan.progress.current / (scan.progress.total || 100)) * 100) }) : when ? t('sim.dup.rescan') : t('sim.dup.scan')}
      </button>
    </div>
  )
}

/** Keep the suggestion in every group: one confirm for all the others. */
function ApplyAll({ chosen }: { chosen: ReadonlyMap<number, number> }) {
  const t = useT()
  const [collecting, setCollecting] = useState(false)
  const run = async () => {
    setCollecting(true)
    try {
      const all = await fetchAllGroups()
      const ids = all.flatMap((g) => othersOf(g, chosen.get(g.group_id)))
      if (ids.length) confirmFor('trash', ids)
    } finally {
      setCollecting(false)
    }
  }
  return (
    <div className={styles.applyAll}>
      <button type="button" className="btn btn-danger" onClick={() => void run()} disabled={collecting} data-testid="duplicates-apply-all">
        {collecting ? t('sim.dup.collecting') : t('sim.dup.applyAll')}
      </button>
    </div>
  )
}

function Group({ group, keeper, onKeep }: { group: DupGroup; keeper: number; onKeep: (id: number) => void }) {
  const t = useT()
  const others = othersOf(group, keeper)
  return (
    <li className={styles.group} data-testid="duplicate-group">
      <header className={styles.groupHead}>
        <span>{t('sim.dup.group', { n: group.members.length, sim: percent(group.similarity) })}</span>
        <span className={styles.spacer} />
        <button type="button" className="btn btn-ghost" onClick={() => confirmFor('remove', others)}>
          {t('sim.dup.removeOthers')}
        </button>
        <button type="button" className="btn btn-danger" onClick={() => confirmFor('trash', others)} data-testid="duplicates-trash-others">
          {t('sim.dup.trashOthers', { n: others.length })}
        </button>
      </header>
      <div className={styles.members} role="radiogroup" aria-label={t('sim.dup.keepHint')}>
        {group.members.map((m) => (
          <Member key={m.id} member={m} kept={m.id === keeper} name={`keep-${group.group_id}`} onKeep={() => onKeep(m.id)} />
        ))}
      </div>
    </li>
  )
}

function Member({ member, kept, name, onKeep }: { member: DupMember; kept: boolean; name: string; onKeep: () => void }) {
  const t = useT()
  const size = member.width && member.height ? `${member.width}×${member.height}` : ''
  return (
    <label className={styles.member} data-kept={kept || undefined} title={member.path}>
      <img src={thumbnailUrl(member.id, 256)} alt="" loading="lazy" draggable={false} />
      <span className={styles.keep}>
        <input type="radio" name={name} checked={kept} onChange={onKeep} data-testid="duplicate-keep" data-id={member.id} />
        {t('sim.dup.keep')}
        {member.suggested_keep && <span className={styles.badge}>{t('sim.dup.suggested')}</span>}
      </span>
      <span className={`${styles.facts} mono`}>
        {[size, fileSize(member.file_size)].filter(Boolean).join(' · ')}
        {member.user_rating ? (
          <span className={styles.stars}>
            <Icon name="star" filled size={10} />
            {member.user_rating}
          </span>
        ) : null}
      </span>
      <span className={styles.filename}>{member.filename}</span>
    </label>
  )
}
