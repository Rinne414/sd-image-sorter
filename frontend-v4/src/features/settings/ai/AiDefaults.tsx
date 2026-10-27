import { useState } from 'react'
import { useTaggerModels } from '../../../api/queries'
import { useT } from '../../../i18n'
import { clearTaggerDefaults, readTaggerDefaults, taggerDefaultsOf, writeTaggerDefaults } from '../../tagging/savedDefaults'
import { clearTagOptions, loadTagOptions } from '../../tagging/tagOptions'
import { useAT as useArtistAT } from '../../tools/artist/artistText'
import { ARTIST_KEY, resetArtistPrefs, setArtistPrefs, useArtistPrefs } from '../../tools/artist/artistPrefs'
import { Section } from '../about/Section'
import { useSaved } from '../useSaved'
import styles from './Ai.module.css'
import { artistLine, artistPrefsOf, restoreSnapshot, takeSnapshot, taggerLine, type Snapshot } from './defaultsState'

interface Note {
  text: string
  tone: 'ok' | 'error' | 'info'
  /** The settings as they were before a reset. */
  undo?: Snapshot
}

const readKey = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Settings > AI > AI defaults: what the tagger and the style finder start from; save the current settings as them, or go back to the program's own. */
export function AiDefaults() {
  const t = useT()
  const artistText = useArtistAT()
  const models = useTaggerModels()
  const [justSaved, markSaved] = useSaved<'defaults'>()
  const [note, setNote] = useState<Note | null>(null)
  // the lines read the keys when they are drawn; this counter redraws them after a change
  const [, setVersion] = useState(0)
  const redraw = () => setVersion((v) => v + 1)

  const tagger = taggerLine(readTaggerDefaults())
  const artistSaved = artistLine(readKey(ARTIST_KEY))
  const device = (d: 'gpu' | 'cpu') => t(d === 'gpu' ? 'aipresets.defaults.gpu' : 'aipresets.defaults.cpu')

  const save = () => {
    const current = loadTagOptions(models.data?.default ?? '')
    const known = models.data?.models.find((m) => m.name === current.model)
    const payload = taggerDefaultsOf(
      current,
      { threshold: known?.default_threshold, characterThreshold: known?.default_character_threshold },
      readTaggerDefaults(),
    )
    // the style finder keeps its settings as they change; saving writes them down again as the defaults
    setArtistPrefs({})
    redraw()
    if (!current.model) {
      setNote({ text: t('aipresets.defaults.noTaggers'), tone: 'error' })
      return
    }
    if (!writeTaggerDefaults(payload)) {
      setNote({ text: t('aipresets.defaults.saveFailed'), tone: 'error' })
      return
    }
    markSaved('defaults')
    setNote({ text: t('aipresets.defaults.saveDone'), tone: 'ok' })
  }

  const reset = () => {
    const before = takeSnapshot(localStorage)
    clearTaggerDefaults()
    clearTagOptions()
    resetArtistPrefs()
    markSaved('defaults')
    setNote({ text: t('aipresets.defaults.resetDone'), tone: 'info', undo: before })
    redraw()
  }

  const undo = (before: Snapshot) => {
    restoreSnapshot(localStorage, before)
    useArtistPrefs.setState(artistPrefsOf(before))
    setNote({ text: t('aipresets.defaults.undone'), tone: 'info' })
    redraw()
  }

  return (
    <Section title={t('aipresets.defaults.title')} saved={justSaved === 'defaults'} testId="ai-defaults">
      <p className={styles.lead}>{t('aipresets.defaults.lead')}</p>
      <ul className={styles.defaultsList}>
        <li data-testid="ai-defaults-tagger">
          {tagger
            ? t('aipresets.defaults.tagger', { model: tagger.model, general: tagger.general, character: tagger.character, device: device(tagger.device) })
            : t('aipresets.defaults.taggerNone')}
        </li>
        <li data-testid="ai-defaults-artist">
          {artistSaved
            ? t('aipresets.defaults.artist', { source: artistText(`artist.source.${artistSaved.source}`), threshold: artistSaved.threshold, device: device(artistSaved.device) })
            : t('aipresets.defaults.artistNone')}
        </li>
      </ul>
      <div className={styles.row}>
        <button type="button" className="btn" onClick={save} disabled={models.isPending} data-testid="ai-defaults-save">
          {t('aipresets.defaults.save')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={reset} data-testid="ai-defaults-reset">
          {t('aipresets.defaults.reset')}
        </button>
      </div>
      <div className={styles.statusRow}>
        <p className={styles.note} data-tone={note?.tone} role="status" data-testid="ai-defaults-note">
          {note?.text ?? ''}
        </p>
        {note?.undo && (
          <button type="button" className="btn btn-ghost" onClick={() => undo(note.undo as Snapshot)} data-testid="ai-defaults-undo">
            {t('aipresets.undo')}
          </button>
        )}
      </div>
    </Section>
  )
}
