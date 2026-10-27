import { useRef } from 'react'
import { thumbnailUrl } from '../../api/urls'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { withClip } from '../similar/clip'
import { startIndexing } from '../similar/similarApi'
import { startStyleIndex } from './indexJob'
import { listNote, neighbourDot, neighbourFlags, type Note } from './lookups'
import { openPicture } from './MapLightbox'
import { mapOnScreen, showWholeLibrary, useMap } from './mapStore'
import { clearNear, lookupFile, pickRow, useNear } from './nearStore'
import styles from './Side.module.css'
import type { Neighbour } from './types'

const THUMB = 256

/**
 * "Drop a picture, find the nearest": a dropped (or chosen) file, or a
 * library picture sent here, is compared with the map's pictures. The map
 * rings the closest ones; this list names them with their similarity. A row
 * turns the camera to its dot; a double-click opens the picture. A file
 * dropped anywhere on the page lands here (StyleMapPage takes the drop).
 */
export function NearCard() {
  const t = useT()
  const points = useMap((s) => s.points)
  const available = mapOnScreen() !== null
  const near = useNear()
  const fileRef = useRef<HTMLInputElement>(null)
  const result = near.result
  const ofLibrary = near.source?.kind === 'library'
  const choose = () => {
    if (!available || !fileRef.current) return
    fileRef.current.value = ''
    fileRef.current.click()
  }

  return (
    <section
      className={styles.near}
      data-over={(near.dragging && available) || undefined}
      aria-labelledby="stylemap-near-title"
      data-testid="stylemap-near"
      data-map={points?.map_id ?? undefined}
    >
      <header className={styles.nearHead}>
        <h2 className={styles.nearTitle} id="stylemap-near-title">
          {t('stylemap.near.title')}
        </h2>
        {near.source && (
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            onClick={clearNear}
            aria-label={t('stylemap.near.clear')}
            title={t('stylemap.near.clear')}
            data-testid="stylemap-near-clear"
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </header>
      {!(result && ofLibrary) && (
        <button
          type="button"
          className={styles.drop}
          data-compact={result ? true : undefined}
          disabled={!available}
          onClick={choose}
          data-testid="stylemap-near-drop"
        >
          <span className={styles.dropMain}>{t('stylemap.near.drop')}</span>
          {!result && <span className={styles.dropSub}>{t(available ? 'stylemap.near.dropSub' : 'stylemap.near.dropOff')}</span>}
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) lookupFile(file)
        }}
        data-testid="stylemap-near-file"
      />
      {near.note && <NoteLine note={near.note} />}
      {result && (
        <>
          {ofLibrary && <p className={styles.nearFor}>{t('stylemap.near.for')}</p>}
          <ul className={styles.nearList} data-testid="stylemap-near-list">
            <QueryRow />
            {(result.neighbors ?? []).map((n) => (
              <NeighbourRow key={n.id} n={n} active={near.active === n.id} />
            ))}
          </ul>
          <p className={styles.nearNote}>{t(listNote(result, ofLibrary).key, listNote(result, ofLibrary).params)}</p>
        </>
      )}
    </section>
  )
}

/** A status line with its one button (build the index, show the whole library). */
function NoteLine({ note }: { note: Note }) {
  const t = useT()
  const space = useMap((s) => s.space)
  const token = useMap((s) => s.token)
  const action = {
    showAll: { label: t('stylemap.near.showAll'), run: showWholeLibrary },
    build: { label: t(space === 'csd' ? 'stylemap.index.buildCsd' : 'stylemap.index.build'), run: () => void startStyleIndex(space, token) },
    buildClip: { label: t('stylemap.index.buildClip'), run: () => void withClip(() => void startIndexing()) },
  }[note.action ?? 'showAll']
  return (
    <div className={styles.noteRow}>
      <p className={styles.note} data-tone={note.tone} role="status" data-testid="stylemap-near-status">
        {t(note.key, note.params)}
      </p>
      {note.action && (
        <button type="button" className="btn btn-sm" onClick={action.run} data-testid="stylemap-near-action">
          {action.label}
        </button>
      )}
    </div>
  )
}

function QueryRow() {
  const t = useT()
  const near = useNear()
  const result = near.result
  if (!result || !near.source) return null
  const ofLibrary = near.source.kind === 'library'
  const src = near.source.kind === 'library' ? thumbnailUrl(near.source.id, THUMB) : near.source.url
  const flag = t(ofLibrary ? 'stylemap.near.this' : 'stylemap.near.query')
  const name = (ofLibrary ? result.self?.filename : near.source.kind === 'file' ? near.source.file.name : null) || flag
  const position: [number, number, number] | null = result.query ? [result.query.x, result.query.y, result.query.z] : null
  const libraryId = near.source.kind === 'library' ? near.source.id : null
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        aria-current={near.active === 'query' || undefined}
        onClick={() => pickRow('query', position)}
        onDoubleClick={() => libraryId !== null && void openPicture(libraryId)}
        data-testid="stylemap-near-query"
      >
        <img className={styles.rowThumb} src={src} alt="" />
        <span className={styles.rowText}>
          <span className={styles.rowName} title={name}>
            {name}
          </span>
          <span className={styles.rowFlag}>{flag}</span>
        </span>
      </button>
    </li>
  )
}

function NeighbourRow({ n, active }: { n: Neighbour; active: boolean }) {
  const t = useT()
  const name = n.filename || `#${n.id}`
  const flags = neighbourFlags(n).map((key) => t(key))
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        aria-current={active || undefined}
        data-weak={n.weak || undefined}
        title={t('stylemap.near.openRow')}
        onClick={() => pickRow(n.id, neighbourDot(n))}
        onDoubleClick={() => void openPicture(n.id)}
        data-testid="stylemap-near-row"
        data-id={n.id}
      >
        <img className={styles.rowThumb} src={thumbnailUrl(n.id, THUMB)} alt="" loading="lazy" />
        <span className={styles.rowText}>
          <span className={styles.rowName}>{name}</span>
          {flags.length > 0 && <span className={styles.rowFlag}>{flags.join(' · ')}</span>}
        </span>
        <span className={`${styles.score} mono`}>{Number(n.score).toFixed(2)}</span>
      </button>
    </li>
  )
}
