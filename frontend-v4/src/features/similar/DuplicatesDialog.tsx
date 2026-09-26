import { useState } from 'react'
import { thumbnailUrl } from '../../api/client'
import type { ImageSummary } from '../../api/types'
import { useLang, useT } from '../../i18n'
import { fileSize } from '../../lib/format'
import { useApp } from '../../state/store'
import { Dialog } from '../../ui/Dialog'
import { Icon } from '../../ui/Icon'
import { useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { Lightbox } from '../lightbox/Lightbox'
import { useSelectionDialog } from '../selection/dialogs'
import { withClip } from './clip'
import { useSimilarDialogs } from './dialogs'
import { PairsView } from './PairsView'
import { canMark, marksOf, THRESHOLDS, toggleMark, type DupGroup, type DupMember, type DupSummary } from './duplicates'
import styles from './Duplicates.module.css'
import { percent } from './ranking'
import { fetchAllGroups, imagesByIds, startDuplicateScan, startIndexing, useDuplicateReview, useIndexStats } from './similarApi'

// Library status › duplicates, two ways (V3.5 had both): "分组清理" and
// "相似的一对" (PairsView, V3.5's pair finder, 50-99 %).
//
// Grouped cleanup: scan the library for near-duplicate groups,
// tick what goes (all but the suggested keeper to start with; two or more can
// stay, never none) and send it to the Recycle Bin or out of the library.
// Removing goes through the same confirm as the selection bar (D15: the
// danger button, focus on Cancel). A thumbnail opens full size in the
// lightbox, over the dialog, with the group's other images beside it.

const THRESHOLD_LABEL = { 0.98: 'sim.dup.strict', 0.95: 'sim.dup.normal', 0.9: 'sim.dup.loose' } as const

const confirmFor = (kind: 'trash' | 'remove', ids: number[]) => useSelectionDialog.getState().showFor(kind, ids, ids.length)

/** The dialog's own lightbox (store `lightboxOwner`), so the page's lightbox stays out of it. */
const LIGHTBOX = 'duplicates'

type Ticks = ReadonlyMap<number, ReadonlySet<number>>

export function DuplicatesDialog() {
  const open = useSimilarDialogs((s) => s.duplicates)
  if (!open) return null
  return <Review />
}

type Mode = 'groups' | 'pairs'

function Review() {
  const t = useT()
  const close = () => useSimilarDialogs.getState().setDuplicates(false)
  const [mode, setMode] = useState<Mode>('groups')
  const [viewing, setViewing] = useState<ImageSummary[]>([])
  const show = (rows: ImageSummary[], id: number) => {
    if (!rows.some((r) => r.id === id)) return
    setViewing(rows)
    useApp.getState().openLightbox(id, LIGHTBOX)
  }

  return (
    <Dialog title={t('sim.dup.title')} onClose={close} testId="duplicates-dialog" wide="x">
      <IndexNote />
      <div className={styles.modes} role="tablist" aria-label={t('sim.dup.title')}>
        {(['groups', 'pairs'] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={styles.mode} onClick={() => setMode(m)} data-testid={`duplicates-mode-${m}`}>
            {t(m === 'groups' ? 'sim.mode.groups' : 'sim.mode.pairs')}
          </button>
        ))}
      </div>
      {mode === 'groups' ? <GroupsView onView={show} /> : <PairsView onView={show} onGroups={() => setMode('groups')} />}
      {viewing.length > 0 && <Lightbox images={viewing} total={viewing.length} hasMore={false} fetchMore={noop} pickable={false} owner={LIGHTBOX} />}
    </Dialog>
  )
}

/** The last grouped scan: tick what goes in each group. */
function GroupsView({ onView }: { onView: (rows: ImageSummary[], id: number) => void }) {
  const t = useT()
  const review = useDuplicateReview()
  const [ticks, setTicks] = useState<Ticks>(new Map())
  const first = review.data?.pages[0]?.page
  const groups = review.data?.pages.flatMap((p) => p.groups) ?? []
  const seen = review.data?.pages.reduce((n, p) => n + p.page.groups.length, 0) ?? 0

  return (
    <>
      <ScanControls summary={first?.summary ?? null} scannedAt={first?.scanned_at ?? null} />
      {review.isPending && <p className={styles.muted}>{t('sim.dup.loading')}</p>}
      {review.isError && <p className={styles.error}>{t('sim.dup.failed', { reason: review.error.message })}</p>}
      {first && !first.available && <p className={styles.muted}>{t('sim.dup.never')}</p>}
      {first?.available && groups.length === 0 && !review.hasNextPage && <p className={styles.muted}>{t('sim.dup.none')}</p>}
      {groups.length > 0 && <ApplyAll ticks={ticks} />}
      {groups.length > 0 && <p className={styles.muted}>{t('sim.dup.keepHint')}</p>}
      <ol className={styles.groups} data-testid="duplicate-groups">
        {groups.map((g) => (
          <Group
            key={g.group_id}
            group={g}
            ticks={ticks.get(g.group_id)}
            onToggle={(id) => setTicks(new Map(ticks).set(g.group_id, toggleMark(g, ticks.get(g.group_id), id)))}
            onView={(id) => void imagesByIds(g.members.map((m) => m.id)).then((rows) => onView(rows, id))}
          />
        ))}
      </ol>
      {review.hasNextPage && (
        <button type="button" className="btn btn-ghost" onClick={() => void review.fetchNextPage()} disabled={review.isFetchingNextPage}>
          {review.isFetchingNextPage ? t('sim.dup.loading') : t('sim.dup.more', { n: Math.max(0, (first?.total_groups ?? 0) - seen) })}
        </button>
      )}
    </>
  )
}

const noop = () => {}


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
      {/* A deliberate limit of grouping, not a cap: lower likeness belongs to the pairs. */}
      <p className={styles.muted}>{t('sim.dup.groupsLimit')}</p>
    </div>
  )
}

/** What is ticked in every group (the suggestion where untouched): one confirm for all of it. */
function ApplyAll({ ticks }: { ticks: Ticks }) {
  const t = useT()
  const [collecting, setCollecting] = useState(false)
  const run = async () => {
    setCollecting(true)
    try {
      const all = await fetchAllGroups()
      const ids = all.flatMap((g) => marksOf(g, ticks.get(g.group_id)))
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

interface GroupProps {
  group: DupGroup
  ticks: ReadonlySet<number> | undefined
  onToggle: (id: number) => void
  onView: (id: number) => void
}

function Group({ group, ticks, onToggle, onView }: GroupProps) {
  const t = useT()
  const marked = marksOf(group, ticks)
  const none = marked.length === 0
  return (
    <li className={styles.group} data-testid="duplicate-group">
      <header className={styles.groupHead}>
        <span>{t('sim.dup.group', { n: group.members.length, sim: percent(group.similarity) })}</span>
        <span className={styles.spacer} />
        <button type="button" className="btn btn-ghost" onClick={() => confirmFor('remove', marked)} disabled={none} data-testid="duplicates-remove-marked">
          {t('sim.dup.removeMarked')}
        </button>
        <button type="button" className="btn btn-danger" onClick={() => confirmFor('trash', marked)} disabled={none} data-testid="duplicates-trash-marked">
          {t('sim.dup.trashMarked', { n: marked.length })}
        </button>
      </header>
      <div className={styles.members}>
        {group.members.map((m) => (
          <Member
            key={m.id}
            member={m}
            marked={marked.includes(m.id)}
            locked={!canMark(group, ticks, m.id)}
            onToggle={() => onToggle(m.id)}
            onView={() => onView(m.id)}
          />
        ))}
      </div>
    </li>
  )
}

interface MemberProps {
  member: DupMember
  marked: boolean
  /** The last image kept: it cannot be ticked. */
  locked: boolean
  onToggle: () => void
  onView: () => void
}

function Member({ member, marked, locked, onToggle, onView }: MemberProps) {
  const t = useT()
  const size = member.width && member.height ? `${member.width}×${member.height}` : ''
  return (
    <div className={styles.member} data-kept={!marked || undefined} title={member.path}>
      <button type="button" className={styles.thumb} onClick={onView} aria-label={t('sim.dup.view')} title={t('sim.dup.view')} data-testid="duplicate-view" data-id={member.id}>
        <img src={thumbnailUrl(member.id, 256)} alt="" loading="lazy" draggable={false} />
      </button>
      <span className={styles.keep}>
        <label className={styles.mark} title={locked ? t('sim.dup.lastKept') : undefined}>
          <input type="checkbox" checked={marked} disabled={locked} onChange={onToggle} data-testid="duplicate-mark" data-id={member.id} />
          {t('sim.dup.trash')}
        </label>
        {!marked && <span className={styles.kept}>{t('sim.dup.keep')}</span>}
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
    </div>
  )
}
