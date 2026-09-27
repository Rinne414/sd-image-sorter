import type { BatchKind, BatchSummary } from '../../api/types'
import { useLibraries } from '../../api/queries'
import { useLang, useT, type MessageKey } from '../../i18n'
import { useApp } from '../../state/store'
import { useBatches, useBatchTemplates } from '../batch/batchApi'
import { timeAgo } from '../batch/batchLogic'
import { ContactSheet, StepTrack } from '../batch/ContactSheet'
import { kindLabel } from '../batch/labels'
import { describeSession } from '../sort/SetupParts'
import type { SessionView } from '../sort/sortSession'
import { useOtherLibrary } from '../sort/StageParts'
import { continueSort, newSort, useSortPending } from '../sort/sortStore'
import { useSelectionDialog } from '../selection/dialogs'
import { FilmStrip } from './FilmStrip'
import styles from './HomePage.module.css'
import { useFilm, type Film } from './useFilm'

const CONTINUE_COUNT = 3

/**
 * Home: ★5 and the newest images on film, where you left off, and the three
 * ways to start. With the film switched off (Settings › Appearance, e.g. while
 * sharing the screen) nothing is asked for it; the rest stays.
 */
export function HomePage() {
  const homeFilm = useApp((s) => s.homeFilm)
  return homeFilm ? <HomeWithFilm /> : <Home film={null} />
}

function HomeWithFilm() {
  const film = useFilm()
  return <Home film={film} />
}

function Home({ film }: { film: Film | null }) {
  const t = useT()
  const batches = useBatches()
  const libraries = useLibraries()
  const libraryId = useApp((s) => s.libraryId)
  const library = libraries.data?.libraries.find((l) => l.id === libraryId)
  const recent = (batches.data ?? []).slice(0, CONTINUE_COUNT)
  const sort = useSortPending(true)
  const libraryName = library?.is_default && library.name === 'Main library' ? t('rail.mainLibrary') : library?.name
  // Without the film, the library's own count says it is empty.
  const empty = film ? film.empty : library?.image_count === 0

  return (
    <section className={styles.page} data-testid="home">
      <h1 className="visually-hidden">{t('nav.home')}</h1>
      {film && !film.empty && (
        <div className={styles.filmRow}>
          <FilmStrip film={film} />
        </div>
      )}
      <div className={styles.sheet}>
        {library && (
          <p className={styles.library}>
            <span className={styles.libraryName}>{libraryName}</span>
            <span className={styles.libraryCount}>{t('rail.images', { n: library.image_count })}</span>
          </p>
        )}
        {empty && <EmptyLibrary />}

        <div className={styles.columns}>
          <div className={styles.column}>
            <h2 className={styles.section}>{t('home.continue')}</h2>
            {batches.isSuccess && recent.length === 0 && !sort ? (
              <p className={styles.empty}>{t('home.noBatches')}</p>
            ) : (
              <ul className={styles.recent}>
                {sort && <RecentSort view={sort} />}
                {recent.map((b) => (
                  <RecentBatch key={b.id} batch={b} />
                ))}
              </ul>
            )}
          </div>

          <div className={styles.column}>
            <h2 className={styles.section}>{t('home.start')}</h2>
            <div className={styles.starts}>
              <Start kind="pixiv" title="home.start.pixiv" body="home.start.pixivBody" />
              <Start kind="dataset" title="home.start.dataset" body="home.start.datasetBody" />
              <button type="button" className={styles.start} onClick={newSort} data-testid="home-start-sort">
                <span className={styles.startTitle}>{t('home.start.sort')}</span>
                <span className={styles.startBody}>{t('home.start.sortBody')}</span>
                <span className={styles.keys} aria-hidden>
                  {['W', 'A', 'S', 'D'].map((k) => (
                    <kbd key={k} className={styles.key}>
                      {k}
                    </kbd>
                  ))}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** A library with no images yet: where the film would be, the way to bring some in. */
function EmptyLibrary() {
  const t = useT()
  return (
    <div className={styles.emptyLibrary} data-testid="home-empty">
      <p className={styles.emptyTitle}>{t('browse.empty.title')}</p>
      <p className={styles.emptyHint}>{t('browse.empty.hint')}</p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => useSelectionDialog.getState().showFor('import', null, 1)}
        data-testid="home-empty-import"
      >
        {t('browse.empty.import')}
      </button>
    </div>
  )
}

function RecentBatch({ batch }: { batch: BatchSummary }) {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const openBatch = useApp((s) => s.openBatch)
  return (
    <li className={styles.card} data-testid="home-batch" data-batch-id={batch.id}>
      <ContactSheet ids={batch.cover_image_ids} total={batch.item_count} />
      <div className={styles.cardInfo}>
        <span className={styles.cardName}>{batch.name}</span>
        <span className={styles.cardMeta}>
          {kindLabel(batch.kind, t)} · {t('rail.images', { n: batch.item_count })} · {t('batch.list.updated', { when: timeAgo(batch.updated_at, lang) })}
        </span>
        <StepTrack steps={batch.steps} current={batch.current_step} />
      </div>
      <button type="button" className="btn btn-primary" onClick={() => openBatch(batch.id)} aria-label={t('batch.list.openNamed', { name: batch.name })}>
        {t('home.resume')}
      </button>
    </li>
  )
}

/** The unfinished WASD sort: the next images as its cover, how far it got. */
function RecentSort({ view }: { view: SessionView }) {
  const t = useT()
  const { title, line } = describeSession(t, view)
  const other = useOtherLibrary(view)
  return (
    <li className={styles.card} data-testid="home-sort">
      <ContactSheet ids={view.ids.slice(view.index, view.index + 4)} total={view.ids.length - view.index} />
      <div className={styles.cardInfo}>
        <span className={styles.cardName}>{title}</span>
        <span className={styles.cardMeta}>{line}</span>
        {other && <span className={styles.cardWhen}>{other.sentence}</span>}
      </div>
      <button type="button" className="btn btn-primary" onClick={continueSort} data-testid="home-sort-continue">
        {t('home.resume')}
      </button>
    </li>
  )
}

/** Start a new batch by picking in the library; the banner there makes the batch from the picks. */
function Start({ kind, title, body }: { kind: BatchKind; title: MessageKey; body: MessageKey }) {
  const t = useT()
  // A batch started here gets the built-in steps of its kind.
  const steps = useBatchTemplates().data?.builtin_steps[kind]
  const go = () => {
    const s = useApp.getState()
    s.setAdding({ kind })
    s.setPage('library')
  }
  return (
    <button type="button" className={styles.start} onClick={go} data-testid={`home-start-${kind}`}>
      <span className={styles.startTitle}>{t(title)}</span>
      <span className={styles.startBody}>{t(body)}</span>
      {steps && <StepTrack steps={steps} />}
    </button>
  )
}
