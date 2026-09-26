import { useState, type FormEvent } from 'react'
import { useApp } from '../../../state/store'
import { Section } from '../about/Section'
import { useLT } from '../libraryText'
import { useSaved } from '../useSaved'
import { CleanSection, KeptSection, RuntimeSection } from './DiskParts'
import styles from './Disk.module.css'
import { diskSize, parseLimit, thumbState } from './disk'
import { saveThumbnailLimit, useCacheStatus } from './diskApi'
import type { CacheEntry, CacheStatus, LibraryIndex } from './types'

const cleanKey = (entries: readonly CacheEntry[]) => entries.map((e) => `${e.key}:${e.size_bytes}`).join('|')

/** Settings › Disk & cache: the index, the thumbnail cache limit, what can be cleaned, what is kept, and the runtime rebuild. */
export function DiskTab() {
  const t = useLT()
  const status = useCacheStatus()

  if (status.isPending) return <p className={styles.state}>{t('disk.loading')}</p>
  if (status.isError) {
    return (
      <div className={styles.sections}>
        <p className={styles.state} data-tone="error">
          {t('disk.failed', { reason: status.error.message })}
        </p>
        <div>
          <button type="button" className="btn" onClick={() => void status.refetch()}>
            {t('libset.retry')}
          </button>
        </div>
      </div>
    )
  }
  const data = status.data
  return (
    <div className={styles.sections} data-testid="disk-settings">
      {data.library_index && <IndexSection index={data.library_index} />}
      <ThumbSection data={data} />
      {/* new sizes after a clean or a refresh start the ticks over */}
      <CleanSection key={cleanKey(data.safe_to_clean ?? [])} entries={data.safe_to_clean ?? []} />
      <KeptSection entries={data.preserved ?? []} />
      <RuntimeSection runtime={data.runtime_environment ?? {}} />
    </div>
  )
}

function IndexSection({ index }: { index: LibraryIndex }) {
  const t = useLT()
  const current = useApp((s) => s.libraryId)
  return (
    <Section title={t('disk.index.title')} testId="disk-index">
      <p className={styles.total} data-testid="disk-index-total">
        {t('disk.index.total', { size: diskSize(index.db_size_bytes) ?? '—', n: index.total_images })}
      </p>
      <p className={styles.hint}>{t('disk.index.hint')}</p>
      {index.libraries.length === 0 ? (
        <p className={styles.hint}>{t('disk.index.none')}</p>
      ) : (
        <ul className={styles.list}>
          {index.libraries.map((lib) => (
            <li key={lib.id} className={styles.item} data-plain data-testid="disk-library">
              <span className={styles.itemName}>
                {lib.name}
                {lib.id === current && <span className={styles.here}>{t('disk.index.current')}</span>}
              </span>
              <span className={`${styles.itemSize} mono`}>{t('disk.index.images', { n: lib.image_count })}</span>
            </li>
          ))}
        </ul>
      )}
      {index.db_path && <p className={`${styles.path} mono`}>{index.db_path}</p>}
    </Section>
  )
}

/** The limit in force and what the cache takes now (which the backend may not have finished counting). */
function thumbStatusText(limitMb: number, used: string | null, t: ReturnType<typeof useLT>): string {
  const limit = `${limitMb} MB`
  if (limitMb === 0) return used ? t('disk.thumb.statusOff', { current: used }) : t('disk.thumb.statusOffUnknown')
  return used ? t('disk.thumb.status', { current: used, limit }) : t('disk.thumb.statusUnknown', { limit })
}

function ThumbSection({ data }: { data: CacheStatus }) {
  const t = useLT()
  const { limitMb, usedBytes } = thumbState(data)
  const [text, setText] = useState(String(limitMb))
  const [shownLimit, setShownLimit] = useState(limitMb)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, mark] = useSaved<'limit'>()
  // A limit saved elsewhere (or just now) replaces what the box shows.
  if (shownLimit !== limitMb) {
    setShownLimit(limitMb)
    setText(String(limitMb))
  }

  const used = diskSize(usedBytes)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    const mb = parseLimit(text)
    if (mb === null) {
      setNote({ text: t('disk.thumb.invalid'), error: true })
      return
    }
    setBusy(true)
    try {
      const res = await saveThumbnailLimit(mb)
      const freed = res.limit_cleanup?.freed_bytes ?? 0
      setNote({ text: freed > 0 ? t('disk.thumb.freed', { size: diskSize(freed) ?? '' }) : t('disk.thumb.saved') })
      mark('limit')
    } catch (error) {
      setNote({ text: t('disk.thumb.failed', { reason: (error as Error).message }), error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={t('disk.thumb.title')} saved={saved === 'limit'} testId="disk-thumbs">
      <p className={styles.lead} data-testid="disk-thumb-status">
        {thumbStatusText(limitMb, used, t)}
      </p>
      <form className={styles.field} onSubmit={(e) => void save(e)} noValidate>
        <label htmlFor="disk-thumb-limit">{t('disk.thumb.label')}</label>
        <input
          id="disk-thumb-limit"
          className={`${styles.number} mono`}
          type="number"
          min={0}
          step={50}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setNote(null)
          }}
          aria-invalid={note?.error ? true : undefined}
          data-testid="disk-thumb-limit"
        />
        <span className={styles.unit}>{t('disk.thumb.unit')}</span>
        <button type="submit" className="btn" disabled={busy} data-testid="disk-thumb-save">
          {t('disk.thumb.save')}
        </button>
      </form>
      {note && (
        <p className={styles.note} data-tone={note.error ? 'error' : undefined} role="status" data-testid="disk-thumb-note">
          {note.text}
        </p>
      )}
      <p className={styles.hint}>{t('disk.thumb.hint')}</p>
    </Section>
  )
}
