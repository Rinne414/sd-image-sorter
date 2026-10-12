import type { RefObject } from 'react'
import { useFolders } from '../../api/queries'
import type { LibraryHealth } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { fileSize, generatorName } from '../../lib/format'
import { tailOfPath } from '../../lib/paths'
import { useApp } from '../../state/store'
import { issueRows, sampleReason } from './health'
import styles from './HealthDialog.module.css'

// The lower half of the library report: the breakdown, same file names, the
// largest folders and the files to check. "Show" narrows the library to them.

/** The smallest bar still reads as a bar. */
const MIN_BAR = 3

export function Breakdown({ counts }: { counts: Record<string, number> }) {
  const t = useT()
  const rows = issueRows(counts)
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <section className={styles.section} data-testid="report-breakdown">
      <h3 className={styles.heading}>{t('status.issues.title')}</h3>
      {rows.every((r) => r.count === 0) && <p className={styles.note}>{t('status.issues.none')}</p>}
      <ul className={styles.bars}>
        {rows.map((r) => (
          <li key={r.key} className={styles.bar} data-coverage={r.coverage || undefined}>
            <span className={styles.barLabel}>
              {t(`status.issue.${r.key}` as MessageKey)}
              {r.coverage && <span className={styles.tag}>{t('status.issues.coverage')}</span>}
            </span>
            <span className={`${styles.barCount} mono`}>{r.count.toLocaleString()}</span>
            <span className={styles.barTrack} aria-hidden>
              <span style={{ width: `${r.count ? Math.max(MIN_BAR, (r.count / max) * 100) : 0}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Close the report and look at the library. */
function toLibrary(onClose: () => void): ReturnType<typeof useApp.getState> {
  onClose()
  const s = useApp.getState()
  s.setPage('library')
  return s
}

interface SectionProps {
  report: LibraryHealth
  onClose: () => void
}

export function Duplicates({ report, onClose, sectionRef }: SectionProps & { sectionRef: RefObject<HTMLElement | null> }) {
  const t = useT()
  const d = report.duplicate_filenames
  const show = (filename: string) => {
    const s = toLibrary(onClose)
    s.setScope({ favorites: false, folder: null, generators: [] })
    s.setQueryText(`"${filename}"`)
  }
  return (
    <section className={styles.section} ref={sectionRef} data-testid="report-duplicates">
      <h3 className={styles.heading}>
        {t('status.dups.title')}
        {d && d.groups > 0 && <span className={styles.headingNote}>{t('status.dups.summary', { groups: d.groups, images: d.images })}</span>}
      </h3>
      {!d || d.samples.length === 0 ? (
        <p className={styles.note}>{t('status.dups.none')}</p>
      ) : (
        <ul className={styles.rows}>
          {d.samples.map((item) => (
            <li key={item.filename} className={styles.row}>
              <span className={`${styles.rowMain} mono`} title={item.filename}>
                {item.filename}
              </span>
              <span className={`${styles.rowNum} mono`}>{t('status.dups.times', { n: item.count })}</span>
              <span className={`${styles.rowNum} mono`}>{fileSize(item.total_size)}</span>
              <button type="button" className={styles.fix} onClick={() => show(item.filename)} title={t('status.showTitle')}>
                {t('status.show')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export function Folders({ report, onClose }: SectionProps) {
  const t = useT()
  const known = useFolders()
  const folders = report.top_folders ?? []
  const show = (folder: string) => {
    // The rail's own spelling of the folder, so its row lights up too.
    const railFolder = known.data?.find((f) => slashes(f) === slashes(folder)) ?? folder
    toLibrary(onClose).setScope({ folder: railFolder })
  }
  return (
    <section className={styles.section} data-testid="report-folders">
      <h3 className={styles.heading}>{t('status.folders.title')}</h3>
      {folders.length === 0 ? (
        <p className={styles.note}>{t('status.folders.none')}</p>
      ) : (
        <ul className={styles.rows}>
          {folders.map((f) => (
            <li key={f.folder || '(root)'} className={styles.row} data-folder>
              <span className={styles.rowMain} title={f.folder}>
                <span className="mono">{f.folder ? tailOfPath(f.folder, 48) : t('status.folders.root')}</span>
                <span className={styles.rowDetail}>{t('status.folders.detail', { text: f.missing_text ?? 0, tags: f.untagged ?? 0 })}</span>
              </span>
              <span className={`${styles.rowNum} mono`}>{f.count.toLocaleString()}</span>
              <span className={`${styles.rowNum} mono`}>{fileSize(f.total_size)}</span>
              {f.folder ? (
                <button type="button" className={styles.fix} onClick={() => show(f.folder)} title={t('status.showTitle')}>
                  {t('status.show')}
                </button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function Samples({ report, onClose }: SectionProps) {
  const t = useT()
  const samples = report.issue_samples ?? []
  const look = (id: number) => {
    const s = toLibrary(onClose)
    if (!s.cardOpen) s.toggleCard()
    s.inspect(id)
  }
  return (
    <section className={styles.section} data-testid="report-samples">
      <h3 className={styles.heading}>{t('status.samples.title')}</h3>
      {samples.length === 0 ? (
        <p className={styles.note}>{t('status.samples.none')}</p>
      ) : (
        <ul className={styles.rows}>
          {samples.map((s) => {
            const reason = sampleReason(s)
            return (
              <li key={s.id} className={`${styles.row} ${styles.sample}`}>
                <span className={`${styles.rowMain} mono`} title={s.path ?? undefined}>
                  #{s.id} {s.filename}
                </span>
                <span className={styles.rowNum}>{generatorName(s.generator, t)}</span>
                <span className={`${styles.rowNum} mono`}>{s.width && s.height ? `${s.width}×${s.height}` : '—'}</span>
                <span className={styles.reason}>{reason.kind === 'unreadable' ? reason.text : t(`status.reason.${reason.kind}` as MessageKey)}</span>
                <button type="button" className={styles.fix} onClick={() => look(s.id)}>
                  {t('status.samples.open')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
