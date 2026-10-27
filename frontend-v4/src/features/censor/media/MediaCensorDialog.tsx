import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useT, type MessageKey } from '../../../i18n'
import { useApp } from '../../../state/store'
import { Dialog } from '../../../ui/Dialog'
import { FolderChooser } from '../../../ui/FolderChooser'
import { useToasts } from '../../../ui/toasts'
import { isQueueBusy } from '../../jobs/jobs'
import { installVideoSupport, useVideoSupport } from '../../video/videoApi'
import { censorModelsQuery } from '../detectApi'
import { DownloadConfirm } from '../DownloadConfirm'
import { legacyTargets, useDownloadAsk, withModels } from '../detectRun'
import { DETECTORS, effectiveDetector, TARGETS, useDetectSettings, CONFIDENCE_MAX, CONFIDENCE_MIN, type DetectorId } from '../detectSettings'
import { Slider } from '../PanelParts'
import { mediaCards, mediaDetection } from './mediaBody'
import { listMedia, mediaStatusQuery, type MediaListing } from './mediaApi'
import { countMoving } from './mediaKind'
import { beginMediaJob, runLabel } from './mediaRun'
import { BLOCK_MAX, BLOCK_MIN, EVERY_MAX, EVERY_MIN, HOLD_MAX, HOLD_MIN, MEDIA_STYLES, useMediaSettings, type MediaStyle } from './mediaSettings'
import { useMediaDialog } from './mediaStore'
import styles from './MediaCensorDialog.module.css'

// The GIF and video censor: which files (the ones picked in the library, or a
// folder), what to find (the censor step's own detection settings, shared),
// how to cover it, and where to save. Start hands the work to the Jobs drawer.

const LIST_DELAY_MS = 350
/** Shown when the program does not know the size of the video support download. */
const VIDEO_SUPPORT_MB = 77

const DETECTOR_LABEL: Record<DetectorId, MessageKey> = {
  both: 'censor.detector.both',
  nudenet: 'censor.detector.nudenet',
  legacy: 'censor.detector.legacy',
  sam3: 'censor.detector.sam3',
}
const TARGET_LABEL: Record<(typeof TARGETS)[number], MessageKey> = {
  breasts: 'censor.target.breasts',
  pussy: 'censor.target.pussy',
  dick: 'censor.target.dick',
  anus: 'censor.target.anus',
  buttocks: 'censor.target.buttocks',
  cum: 'censor.target.cum',
}
const STYLE_LABEL: Record<MediaStyle, MessageKey> = {
  mosaic: 'censor.style.mosaic',
  blur: 'censor.style.blur',
  black: 'censor.style.black',
}
/** The detectors a moving picture can use: SAM 3 is replaced by NudeNet. */
const MEDIA_DETECTORS = DETECTORS.filter((d) => d !== 'sam3')

const toast = (text: string, tone: 'info' | 'error' = 'info') => useToasts.getState().push(text, tone)

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** The dialog and the model question it may raise (MediaCensorHost.tsx loads this file on first use). */
export default function MediaCensorLoaded() {
  const open = useMediaDialog((s) => s.open)
  const page = useApp((s) => s.page)
  // The censor step shows this question itself; elsewhere it is asked here.
  return (
    <>
      {open && <MediaCensorDialog />}
      {page !== 'batch' && <DownloadConfirm />}
    </>
  )
}

function useFolderListing(folder: string, enabled: boolean) {
  const [listing, setListing] = useState<MediaListing | null>(null)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    const path = folder.trim()
    if (!enabled || !path) {
      setListing(null)
      setProblem('')
      return
    }
    const control = new AbortController()
    const timer = window.setTimeout(() => {
      listMedia(path, control.signal)
        .then((found) => {
          setListing(found)
          setProblem('')
        })
        .catch((error: unknown) => {
          if (control.signal.aborted) return
          setListing(null)
          setProblem((error as Error).message)
        })
    }, LIST_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      control.abort()
    }
  }, [folder, enabled])
  return { listing, problem }
}

function MediaCensorDialog() {
  const t = useT()
  const picks = useMediaDialog((s) => s.picks)
  const close = useMediaDialog((s) => s.close)
  const detect = useDetectSettings()
  const media = useMediaSettings()
  const models = useQuery(censorModelsQuery)
  const mediaStatus = useQuery(mediaStatusQuery)
  const support = useVideoSupport()
  const [folder, setFolder] = useState(media.source)
  const [includeVideos, setIncludeVideos] = useState(true)
  const [choosing, setChoosing] = useState<'source' | 'output' | null>(null)
  const [starting, setStarting] = useState(false)
  const { listing, problem } = useFolderListing(folder, picks === null)

  const counts = picks ? countMoving(picks) : { gifs: listing?.gifs.length ?? 0, videos: listing?.videos.length ?? 0 }
  const withVideos = includeVideos && counts.videos > 0
  // Video support's ffmpeg, or the one imageio-ffmpeg brings: the program says which is there (the folder listing and the status ask it the same way).
  const videoReady = listing?.video_ready ?? mediaStatus.data?.video_ready ?? false
  const needsInstall = withVideos && !videoReady
  // No ready-made ffmpeg for this system: nothing to offer but leaving the videos out.
  const cannotInstall = needsInstall && support.data?.can_install === false
  const fileCount = counts.gifs + (withVideos ? counts.videos : 0)

  const chosen = effectiveDetector(detect.detector, models.data?.recommended_backend)
  const shown: DetectorId = chosen === 'sam3' ? 'nudenet' : chosen
  const path = detect.customPath.trim() || detect.yolo
  const detection = mediaDetection({
    detector: detect.detector,
    recommended: models.data?.recommended_backend,
    targets: detect.targets,
    confidence: detect.confidence,
    maskShape: detect.maskShape,
    yolo: detect.yolo,
    customPath: detect.customPath,
    legacyKnowsTargets: legacyTargets(models.data, path),
  })
  const usesTargetList = shown !== 'legacy' || legacyTargets(models.data, path)

  const start = async () => {
    if ('error' in detection) return toast(t('censor.detect.noTargets'), 'error')
    if (fileCount === 0) return toast(t('mediacensor.nothingToDo'), 'error')
    const files = picks ? picks.filter((p) => withVideos || p.kind === 'gif') : null
    const names = files ? files.map((f) => f.name) : [...(listing?.gifs ?? []), ...(withVideos ? (listing?.videos ?? []) : [])].map(baseName)
    const run = {
      source: files ? { files: files.map((f) => f.path) } : { folder: folder.trim() },
      detection,
      options: {
        style: media.style,
        blockAuto: media.blockAuto,
        block: media.block,
        every: media.every,
        hold: media.hold,
        output: media.output,
        includeVideos: withVideos,
      },
      count: fileCount,
      label: runLabel(names),
    }
    media.setSource(folder.trim())
    setStarting(true)
    const post = async () => {
      if (await beginMediaJob(run)) close()
      setStarting(false)
    }
    // Videos need ffmpeg: Start is the go-ahead to install video support (one download that also
    // plays the library's videos), and the censoring goes on by itself after.
    const proceed = async () => {
      if (!needsInstall) return post()
      if (isQueueBusy('video')) {
        toast(t('mediacensor.videos.installing'), 'error')
      } else if (await installVideoSupport(() => post())) {
        toast(t('mediacensor.videos.installFirst'))
        close()
      }
      setStarting(false)
    }
    let ranNow = false
    await withModels(mediaCards(detection), 'censor.ask.forDetect', () => {
      ranNow = true
      void proceed()
    })
    if (!ranNow) {
      // Waiting for the answer to the download question, which is shown on its own.
      if (useDownloadAsk.getState().ask) close()
      setStarting(false)
    }
  }

  const canStart = !starting && fileCount > 0 && !cannotInstall && !('error' in detection)
  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={close}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={!canStart} data-testid="mediacensor-start">
        {starting ? t('mediacensor.starting') : t('mediacensor.start', { n: fileCount })}
      </button>
    </>
  )

  return (
    <Dialog title={t('mediacensor.title')} onClose={close} footer={footer} testId="mediacensor-dialog" wide>
      <div className={styles.grid}>
        <section className={styles.group}>
          <h3 className={styles.heading}>{t('mediacensor.source.heading')}</h3>
          {picks ? (
            <p className={styles.line} data-testid="mediacensor-picks">
              {t('mediacensor.source.picks', { gifs: counts.gifs, videos: counts.videos })}
            </p>
          ) : (
            <>
              <div className={styles.pathRow}>
                <input
                  type="text"
                  className={`${styles.path} mono`}
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder={t('mediacensor.source.placeholder')}
                  aria-label={t('mediacensor.source.folder')}
                  spellCheck={false}
                  data-testid="mediacensor-folder"
                />
                <button type="button" className="btn" onClick={() => setChoosing('source')} data-testid="mediacensor-folder-choose">
                  {t('mediacensor.choose')}
                </button>
              </div>
              <p className={problem ? styles.warn : styles.line} role="status" data-testid="mediacensor-found">
                {problem
                  ? t('mediacensor.source.bad', { reason: problem })
                  : listing
                    ? counts.gifs + counts.videos === 0
                      ? t('mediacensor.source.none')
                      : t('mediacensor.source.found', { gifs: counts.gifs, videos: counts.videos })
                    : ''}
              </p>
              <p className={styles.note}>{t('mediacensor.source.subfolders')}</p>
            </>
          )}
          {counts.videos > 0 && (
            <label className={styles.check}>
              <input type="checkbox" checked={includeVideos} onChange={(e) => setIncludeVideos(e.target.checked)} data-testid="mediacensor-videos" />
              <span>{t('mediacensor.videos.include', { n: counts.videos })}</span>
            </label>
          )}
          {needsInstall && (
            <p className={styles.warn} data-testid="mediacensor-video-note">
              {cannotInstall ? t('mediacensor.videos.noBuild') : t('mediacensor.videos.needSupport', { mb: support.data?.estimated_mb ?? VIDEO_SUPPORT_MB })}
            </p>
          )}

          <h3 className={styles.heading}>{t('mediacensor.output.heading')}</h3>
          <div className={styles.pathRow}>
            <input
              type="text"
              className={`${styles.path} mono`}
              value={media.output}
              onChange={(e) => media.setOutput(e.target.value)}
              placeholder={t('mediacensor.output.placeholder')}
              aria-label={t('mediacensor.output.heading')}
              spellCheck={false}
              data-testid="mediacensor-output"
            />
            <button type="button" className="btn" onClick={() => setChoosing('output')} data-testid="mediacensor-output-choose">
              {t('mediacensor.choose')}
            </button>
          </div>
          <p className={styles.note}>{t('mediacensor.output.note')}</p>

          <h3 className={styles.heading}>{t('mediacensor.look.heading')}</h3>
          <div className={styles.buttons} role="group" aria-label={t('censor.style')}>
            {MEDIA_STYLES.map((id) => (
              <button key={id} type="button" className="btn" aria-pressed={media.style === id} onClick={() => media.setStyle(id)} data-testid={`mediacensor-style-${id}`}>
                {t(STYLE_LABEL[id])}
              </button>
            ))}
          </div>
          <label className={styles.check}>
            <input type="checkbox" checked={media.blockAuto} onChange={(e) => media.setBlockAuto(e.target.checked)} data-testid="mediacensor-block-auto" />
            <span>{t('mediacensor.look.blockAuto')}</span>
          </label>
          {!media.blockAuto && <Slider label={t('mediacensor.look.block')} value={media.block} min={BLOCK_MIN} max={BLOCK_MAX} unit=" px" onChange={media.setBlock} testId="mediacensor-block" />}
          <details className={styles.advanced}>
            <summary>{t('mediacensor.timing.heading')}</summary>
            <Slider label={t('mediacensor.timing.every')} value={media.every} min={EVERY_MIN} max={EVERY_MAX} unit={t('mediacensor.timing.frames')} onChange={media.setEvery} testId="mediacensor-every" />
            <Slider label={t('mediacensor.timing.hold')} value={media.hold} min={HOLD_MIN} max={HOLD_MAX} unit={t('mediacensor.timing.frames')} onChange={media.setHold} testId="mediacensor-hold" />
            <p className={styles.note}>{t('mediacensor.timing.note')}</p>
          </details>
        </section>

        <section className={styles.group}>
          <h3 className={styles.heading}>{t('censor.detect.detector')}</h3>
          <div className={styles.stack} role="group" aria-label={t('censor.detect.detector')}>
            {MEDIA_DETECTORS.map((id) => (
              <button key={id} type="button" className="btn" aria-pressed={shown === id} onClick={() => detect.setDetector(id)} data-testid={`mediacensor-detector-${id}`}>
                {t(DETECTOR_LABEL[id])}
              </button>
            ))}
          </div>
          {chosen === 'sam3' && <p className={styles.note}>{t('mediacensor.detect.sam3')}</p>}
          {usesTargetList && (
            <div className={styles.targets}>
              {TARGETS.map((target) => (
                <label key={target} className={styles.check}>
                  <input type="checkbox" checked={detect.targets.includes(target)} onChange={() => detect.toggleTarget(target)} data-testid={`mediacensor-target-${target}`} />
                  <span>{t(TARGET_LABEL[target])}</span>
                </label>
              ))}
            </div>
          )}
          {'error' in detection && <p className={styles.warn}>{t('censor.detect.noTargets')}</p>}
          <Slider
            label={t('censor.detect.confidence')}
            value={Math.round(detect.confidence * 100)}
            min={Math.round(CONFIDENCE_MIN * 100)}
            max={Math.round(CONFIDENCE_MAX * 100)}
            unit="%"
            onChange={(v) => detect.setConfidence(v / 100)}
            testId="mediacensor-confidence"
          />
          <div className={styles.buttons} role="group" aria-label={t('censor.detect.shape')}>
            <button type="button" className="btn" aria-pressed={detect.maskShape === 'precise'} onClick={() => detect.setMaskShape('precise')} data-testid="mediacensor-shape-precise">
              {t('censor.detect.precise')}
            </button>
            <button type="button" className="btn" aria-pressed={detect.maskShape === 'box'} onClick={() => detect.setMaskShape('box')} data-testid="mediacensor-shape-box">
              {t('censor.detect.box')}
            </button>
          </div>
          <p className={styles.note}>{t('mediacensor.detect.shared')}</p>
        </section>
      </div>
      {choosing && (
        <FolderChooser
          title={t(choosing === 'source' ? 'mediacensor.source.chooseTitle' : 'mediacensor.output.chooseTitle')}
          confirmLabel={t('mediacensor.choose')}
          start={(choosing === 'source' ? folder : media.output) || null}
          shortcuts={[]}
          allowNewFolder={choosing === 'output'}
          onChoose={async (target) => {
            if (choosing === 'source') setFolder(target)
            else media.setOutput(target)
            return true
          }}
          onClose={() => setChoosing(null)}
          testId="mediacensor-folder-picker"
        />
      )}
    </Dialog>
  )
}
