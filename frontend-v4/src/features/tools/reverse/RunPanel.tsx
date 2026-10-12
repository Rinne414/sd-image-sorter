import { useMemo } from 'react'
import { useTaggerModels } from '../../../api/queries'
import { useT, type MessageKey } from '../../../i18n'
import { useApp } from '../../../state/store'
import { useVlmStatus } from '../../batch/datasetTagApi'
import type { TargetModel } from '../../batch/datasetSettings'
import { loadTagOptions, type TagOptions } from '../../tagging/tagJob'
import { isTagger, taggerInfo } from '../../tagging/taggers'
import { useTT, type ToolKey } from '../toolText'
import styles from './Reverse.module.css'
import { MODES, needsVlm, type ReverseMode } from './reverseModes'
import { cancelRun, setReverseOptions, startRun, useReverseOptions, useReverseRun } from './reverseStore'

// How to work out the prompt, what for, and the run itself.

const TARGETS: [TargetModel, MessageKey][] = [
  ['', 'dataset.model.none'],
  ['sdxl', 'dataset.model.sdxl'],
  ['flux', 'dataset.model.flux'],
  ['krea2', 'dataset.model.krea2'],
  ['anima', 'dataset.model.anima'],
]

const PHASE: Partial<Record<string, ToolKey>> = {
  starting: 'reverse.phase.starting',
  installing: 'reverse.phase.installing',
  queued: 'reverse.phase.queued',
  running: 'reverse.phase.running',
  cancelling: 'reverse.phase.cancelling',
}

/** The tagger the user chose in the tag panel (and its thresholds), not the backend's default. */
export function useRememberedTagger(): TagOptions | null {
  const models = useTaggerModels()
  return useMemo(() => {
    if (!models.data) return null
    const loaded = loadTagOptions(models.data.default)
    const known = models.data.models.some((m) => m.name === loaded.model && isTagger(m.name) && !m.disabled)
    return known ? loaded : { ...loaded, model: models.data.default, threshold: null, characterThreshold: null }
  }, [models.data])
}

function Modes({ mode, vlmReady }: { mode: ReverseMode; vlmReady: boolean }) {
  const t = useTT()
  return (
    <fieldset className={styles.modes}>
      <legend className={styles.subLabel}>{t('reverse.how')}</legend>
      {MODES.map((m) => (
        <label key={m} className={styles.mode} data-off={(needsVlm(m) && !vlmReady) || undefined}>
          <input type="radio" name="reverse-mode" checked={mode === m} onChange={() => setReverseOptions({ mode: m })} data-testid={`reverse-mode-${m}`} />
          <span>
            <span className={styles.modeName}>{t(`reverse.mode.${m}` as ToolKey)}</span>
            <span className={styles.modeHint}>{t(`reverse.mode.${m}.hint` as ToolKey)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

function Status({ runKey }: { runKey: string }) {
  const t = useTT()
  const { phase, problem, key: runOf } = useReverseRun()
  const tagger = useRememberedTagger()
  if (runOf !== runKey) return null
  const key = PHASE[phase]
  if (key) return <p className={styles.status} role="status" data-testid="reverse-status">{t(key, { name: tagger ? taggerInfo(tagger.model).label : '' })}</p>
  if (!problem) return null
  if (problem === 'cancelled') return <p className={styles.status} role="status" data-testid="reverse-status">{t('reverse.cancelled')}</p>
  return (
    <p className={styles.problem} role="alert" data-testid="reverse-status">
      {problem}
    </p>
  )
}

interface Props {
  /** The image's key, and the file the tagger / vision model reads (null until the image is read). */
  runKey: string
  path: string | null
  hasRecord: boolean
}

export function RunPanel({ runKey, path, hasRecord }: Props) {
  const t = useTT()
  const common = useT()
  const { mode, target } = useReverseOptions()
  const phase = useReverseRun((s) => (s.key === runKey ? s.phase : 'idle'))
  const tagger = useRememberedTagger()
  const vlm = useVlmStatus()
  const vlmReady = vlm.data?.configured === true
  const taggerName = tagger ? taggerInfo(tagger.model).label : '…'
  const vlmName = vlm.data?.label || '—'
  const busy = phase !== 'idle'
  const blocked = !path || !tagger || (needsVlm(mode) && !vlmReady)
  const method = t(`reverse.by.${mode}` as ToolKey, { tagger: taggerName, vlm: vlmName })

  const run = () => {
    if (!path || !tagger || blocked) return
    void startRun({ key: runKey, path, mode, target, tagger, method })
  }

  return (
    <section className={styles.panel} data-testid="reverse-run">
      <Modes mode={mode} vlmReady={vlmReady} />
      <label className={styles.target}>
        <span className={styles.subLabel}>{t('reverse.target')}</span>
        <select value={target} onChange={(e) => setReverseOptions({ target: e.target.value as TargetModel })} data-testid="reverse-target">
          {TARGETS.map(([id, label]) => (
            <option key={id} value={id}>
              {common(label)}
            </option>
          ))}
        </select>
      </label>
      {target === 'krea2' && <p className={styles.muted}>{t('reverse.targetKrea2')}</p>}
      <p className={styles.muted} data-testid="reverse-models">
        {t('reverse.tagger', { name: taggerName })}
        {vlmReady && ` · ${t('reverse.vlm', { name: vlmName })}`}
      </p>
      {vlm.data && !vlmReady && needsVlm(mode) && (
        <p className={styles.warn} data-testid="reverse-vlm-missing">
          {t('reverse.vlmMissing')}{' '}
          <button type="button" className={styles.textButton} onClick={() => useApp.getState().openSettings('ai')}>
            {t('reverse.vlmOpen')}
          </button>
        </p>
      )}
      <div className={styles.runRow}>
        <button type="button" className="btn btn-primary" onClick={run} disabled={busy || blocked} title={hasRecord ? t('reverse.runAnywayHint') : undefined} data-testid="reverse-run-button">
          {t(hasRecord ? 'reverse.runAnyway' : 'reverse.run')}
        </button>
        {busy && (
          <button type="button" className="btn" onClick={cancelRun} disabled={phase === 'cancelling'} data-testid="reverse-cancel">
            {t('reverse.cancel')}
          </button>
        )}
      </div>
      <Status runKey={runKey} />
    </section>
  )
}
