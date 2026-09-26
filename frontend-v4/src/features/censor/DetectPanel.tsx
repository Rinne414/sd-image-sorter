import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { Batch, BatchItem } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { DetectorGuideLink } from '../settings/models/ModelGuideLink'
import { refineTargets, startDetectAll, startRefineAll } from './detectAll'
import { censorModelsQuery, type LegacyFile } from './detectApi'
import { detectCurrent, refineCurrent, segmentCurrent, useDetectBusy } from './detectRun'
import {
  addPromptWord,
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  DETECTORS,
  effectiveDetector,
  TARGETS,
  usesTargets,
  useDetectSettings,
  type DetectorId,
  type Target,
} from './detectSettings'
import styles from './DetectPanel.module.css'
import { Section, Slider } from './PanelParts'
import { detectAllTargets } from './review'
import { initialEdit, keyOf, useCensorSession } from './session'
import tp from './ToolPanel.module.css'

const DETECTOR_LABEL: Record<DetectorId, MessageKey> = {
  both: 'censor.detector.both',
  nudenet: 'censor.detector.nudenet',
  legacy: 'censor.detector.legacy',
  sam3: 'censor.detector.sam3',
}
const DETECTOR_NOTE: Record<DetectorId, MessageKey> = {
  both: 'censor.detector.bothNote',
  nudenet: 'censor.detector.nudenetNote',
  legacy: 'censor.detector.legacyNote',
  sam3: 'censor.detector.sam3Note',
}
export const TARGET_LABEL: Record<Target, MessageKey> = {
  breasts: 'censor.target.breasts',
  pussy: 'censor.target.pussy',
  dick: 'censor.target.dick',
  anus: 'censor.target.anus',
  buttocks: 'censor.target.buttocks',
  cum: 'censor.target.cum',
}

/** SAM3 common words (English: what SAM3 understands), shown under translated group names. */
const SAM3_WORDS: { group: MessageKey; words: { word: string; label: MessageKey }[] }[] = [
  {
    group: 'censor.sam3.group.privacy',
    words: [
      { word: 'exposed female breast', label: 'censor.sam3.w.breast' },
      { word: 'exposed nipple', label: 'censor.sam3.w.nipple' },
      { word: 'exposed female genitalia', label: 'censor.sam3.w.femaleGenitalia' },
      { word: 'exposed male genitalia', label: 'censor.sam3.w.maleGenitalia' },
      { word: 'exposed anus', label: 'censor.sam3.w.anus' },
      { word: 'exposed buttocks', label: 'censor.sam3.w.buttocks' },
    ],
  },
  {
    group: 'censor.sam3.group.body',
    words: [
      { word: 'face', label: 'censor.sam3.w.face' },
      { word: 'eyes', label: 'censor.sam3.w.eyes' },
      { word: 'mouth', label: 'censor.sam3.w.mouth' },
      { word: 'hands', label: 'censor.sam3.w.hands' },
      { word: 'feet', label: 'censor.sam3.w.feet' },
      { word: 'navel', label: 'censor.sam3.w.navel' },
      { word: 'armpit', label: 'censor.sam3.w.armpit' },
    ],
  },
  {
    group: 'censor.sam3.group.objects',
    words: [
      { word: 'underwear', label: 'censor.sam3.w.underwear' },
      { word: 'bra', label: 'censor.sam3.w.bra' },
      { word: 'bikini', label: 'censor.sam3.w.bikini' },
      { word: 'tattoo', label: 'censor.sam3.w.tattoo' },
      { word: 'piercing', label: 'censor.sam3.w.piercing' },
      { word: 'watermark', label: 'censor.sam3.w.watermark' },
      { word: 'text', label: 'censor.sam3.w.text' },
      { word: 'logo', label: 'censor.sam3.w.logo' },
    ],
  },
]

interface Props {
  batch: Batch
  item: BatchItem
}

/** The Detect tab: which detector and what it looks for, detect this image or all, SAM3 tools. */
export function DetectPanel({ batch, item }: Props) {
  const t = useT()
  const models = useQuery(censorModelsQuery)
  const s = useDetectSettings()
  const detector = effectiveDetector(s.detector, models.data?.recommended_backend)
  const busy = useDetectBusy((b) => b.busy[keyOf(batch.id, item.image_id)])

  return (
    <>
      <Section title={t('censor.detect.detector')} testId="censor-detectors">
        <div className={styles.options} role="radiogroup" aria-label={t('censor.detect.detector')}>
          {DETECTORS.map((id) => (
            <label key={id} className={styles.option} data-checked={detector === id || undefined}>
              <input type="radio" name="censor-detector" checked={detector === id} onChange={() => s.setDetector(id)} data-testid={`censor-detector-${id}`} />
              <span className={styles.optionName}>{t(DETECTOR_LABEL[id])}</span>
              {models.data?.recommended_backend === id && <span className={styles.badge}>{t('censor.detect.recommended')}</span>}
            </label>
          ))}
        </div>
        <p className={tp.note}>{t(DETECTOR_NOTE[detector])}</p>
        <DetectorGuideLink detector={detector} />
      </Section>
      <DetectButtons batch={batch} item={item} busy={busy} />
      {usesTargets(detector) && <Targets />}
      <Section title={t('censor.detect.settings')}>
        <Slider
          label={t('censor.detect.confidence')}
          value={Math.round(s.confidence * 100)}
          min={Math.round(CONFIDENCE_MIN * 100)}
          max={Math.round(CONFIDENCE_MAX * 100)}
          unit="%"
          onChange={(v) => s.setConfidence(v / 100)}
          testId="censor-confidence"
        />
        <div className={tp.pair} role="group" aria-label={t('censor.detect.shape')}>
          <button type="button" className="btn" aria-pressed={s.maskShape === 'precise'} onClick={() => s.setMaskShape('precise')} title={t('censor.detect.preciseTip')} data-testid="censor-shape-precise">
            {t('censor.detect.precise')}
          </button>
          <button type="button" className="btn" aria-pressed={s.maskShape === 'box'} onClick={() => s.setMaskShape('box')} title={t('censor.detect.boxTip')} data-testid="censor-shape-box">
            {t('censor.detect.box')}
          </button>
        </div>
      </Section>
      <Sam3Tools batch={batch} item={item} busy={busy} />
      {(detector === 'legacy' || detector === 'both') && <YoloChoice files={models.data?.models.find((m) => m.id === 'legacy')?.files ?? []} />}
    </>
  )
}

function useJobRunning(): boolean {
  return useJobs((j) => j.jobs.some((job) => (job.kind === 'detect' || job.kind === 'refine') && !isFinished(job.progress.status)))
}

function DetectButtons({ batch, item, busy }: Props & { busy: string | undefined }) {
  const t = useT()
  const edits = useCensorSession((x) => x.edits)
  const running = useJobRunning()
  const marks = batch.items.map((i) => ({ imageId: i.image_id, reviewed: (edits[keyOf(batch.id, i.image_id)] ?? initialEdit(i)).reviewed }))
  const all = detectAllTargets(marks)
  return (
    <div className={styles.actions}>
      <button type="button" className="btn btn-primary" onClick={() => void detectCurrent(batch.id, item)} disabled={!!busy} data-testid="censor-detect-current">
        {busy === 'detect' ? t('censor.detect.running') : t('censor.detect.this')}
        <kbd>D</kbd>
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => void startDetectAll(batch.id, batch.items)}
        disabled={running || all.ids.length === 0}
        title={t('censor.detect.allTip')}
        data-testid="censor-detect-all"
      >
        {t(all.redetect ? 'censor.detect.allAgain' : 'censor.detect.all', { n: all.ids.length })}
      </button>
    </div>
  )
}

function Targets() {
  const t = useT()
  const s = useDetectSettings()
  return (
    <Section title={t('censor.detect.targets')}>
      <div className={styles.targets}>
        {TARGETS.map((target) => (
          <label key={target} className={styles.check}>
            <input type="checkbox" checked={s.targets.includes(target)} onChange={() => s.toggleTarget(target)} data-testid={`censor-target-${target}`} />
            <span>{t(TARGET_LABEL[target])}</span>
          </label>
        ))}
      </div>
      {s.targets.length === 0 && <p className={styles.warn}>{t('censor.detect.noTargets')}</p>}
    </Section>
  )
}

function Sam3Tools({ batch, item, busy }: Props & { busy: string | undefined }) {
  const t = useT()
  const s = useDetectSettings()
  const [wordsOpen, setWordsOpen] = useState(false)
  const running = useJobRunning()
  const edits = useCensorSession((x) => x.edits)
  const refineCount = refineTargets(batch.id, batch.items, edits).length
  return (
    <Section title={t('censor.sam3.title')}>
      <label className={styles.field}>
        <span>{t('censor.sam3.words')}</span>
        <input type="text" value={s.prompt} onChange={(e) => s.setPrompt(e.target.value)} placeholder="face, tattoo" spellCheck={false} data-testid="censor-sam3-words" />
      </label>
      <button type="button" className={`btn btn-ghost ${styles.disclosure}`} aria-expanded={wordsOpen} onClick={() => setWordsOpen(!wordsOpen)} data-testid="censor-sam3-common">
        {t('censor.sam3.common')}
      </button>
      {wordsOpen && (
        <div className={styles.words} data-testid="censor-sam3-chips">
          {SAM3_WORDS.map(({ group, words }) => (
            <div key={group} className={styles.wordGroup}>
              <h4>{t(group)}</h4>
              <div className={styles.chips}>
                {words.map(({ word, label }) => (
                  <button key={word} type="button" className={styles.chip} title={word} onClick={() => s.setPrompt(addPromptWord(s.prompt, word))}>
                    {t(label)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="btn" onClick={() => void segmentCurrent(batch.id, item)} disabled={!!busy} title={t('censor.sam3.segmentTip')} data-testid="censor-sam3-segment">
        {busy === 'text' ? t('censor.detect.running') : t('censor.sam3.segment')}
      </button>
      <div className={tp.pair}>
        <button type="button" className="btn" onClick={() => void refineCurrent(batch.id, item)} disabled={!!busy} title={t('censor.refine.thisTip')} data-testid="censor-refine-current">
          {busy === 'refine' ? t('censor.detect.running') : t('censor.refine.this')}
        </button>
        <button type="button" className="btn" onClick={() => void startRefineAll(batch.id, batch.items)} disabled={running || refineCount === 0} title={t('censor.refine.allTip')} data-testid="censor-refine-all">
          {t('censor.refine.all', { n: refineCount })}
        </button>
      </div>
    </Section>
  )
}

const PROFILE_LABEL: Record<string, MessageKey> = {
  'privacy-censor': 'censor.yolo.privacy',
  'general-object': 'censor.yolo.general',
}

function YoloChoice({ files }: { files: LegacyFile[] }) {
  const t = useT()
  const s = useDetectSettings()
  return (
    <details className={styles.advanced} open={!!s.customPath || undefined}>
      <summary>{t('censor.yolo.title')}</summary>
      <div className={styles.options} role="radiogroup" aria-label={t('censor.yolo.title')}>
        <label className={styles.option} data-checked={!s.yolo || undefined}>
          <input type="radio" name="censor-yolo" checked={!s.yolo} onChange={() => s.setYolo('')} />
          <span className={styles.optionName}>{t('censor.yolo.default')}</span>
        </label>
        {files.map((file) => (
          <label key={file.path} className={styles.option} data-checked={s.yolo === file.path || undefined} title={file.path}>
            <input type="radio" name="censor-yolo" checked={s.yolo === file.path} onChange={() => s.setYolo(file.path)} />
            <span className={`${styles.optionName} mono`}>{file.name ?? file.path}</span>
            <span className={styles.optionNote}>{t(PROFILE_LABEL[file.profile ?? ''] ?? 'censor.yolo.unknown')}</span>
          </label>
        ))}
      </div>
      <label className={styles.field}>
        <span>{t('censor.yolo.path')}</span>
        <input type="text" value={s.customPath} onChange={(e) => s.setCustomPath(e.target.value)} placeholder="models\yolo\my-seg.pt" spellCheck={false} data-testid="censor-yolo-path" />
        <small>{t('censor.yolo.pathNote')}</small>
      </label>
    </details>
  )
}
