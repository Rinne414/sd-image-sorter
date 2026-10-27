import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { thumbnailUrl } from '../../api/client'
import { useImageDetail } from '../../api/queries'
import type { ImageSummary } from '../../api/types'
import { useT } from '../../i18n'
import { fileSize } from '../../lib/format'
import styles from './VideoStage.module.css'
import { registerVideoControl } from './videoControl'
import { getPlayback, installVideoSupport, useVideoSupport } from './videoApi'
import { companionRecipe, stepTime, videoFacts } from './videoMedia'
import { useVideoSource } from './useVideoSource'

const PREFS_KEY = 'sd-v4-video-viewer'

interface Prefs {
  loop: boolean
  muted: boolean
}

function readPrefs(): Prefs {
  try {
    return { loop: true, muted: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return { loop: true, muted: false }
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // storage blocked: the choice lasts until the page closes
  }
}

/** One video in the big image: the player, loop and sound toggles, frame steps, and what is wrong with it if anything. */
export function VideoStage({ id, summary }: { id: number; summary: ImageSummary | undefined }) {
  const t = useT()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [prefs, setPrefs] = useState(readPrefs)
  const detail = useImageDetail(id)
  const image = detail.data?.image ?? summary
  const support = useVideoSupport()
  const playback = useQuery({ queryKey: ['video-playback', id], queryFn: ({ signal }) => getPlayback(id, signal), staleTime: 30_000 })
  const tools = support.data?.available ?? playback.data?.tools_available
  const source = useVideoSource({ id, codec: image?.video_codec, playback: playback.data, tools })
  const fps = playback.data?.fps ?? detail.data?.image.video_fps ?? null

  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    savePrefs(next)
  }

  const toggle = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused || v.ended) void v.play().catch(() => undefined)
    else v.pause()
  }
  const step = (dir: 1 | -1) => {
    const v = videoRef.current
    if (!v) return
    v.pause()
    v.currentTime = stepTime(v.currentTime, dir, fps, v.duration)
  }
  // The latest handlers, for the keys the lightbox forwards.
  const handlers = useRef({ toggle, step })
  handlers.current = { toggle, step }
  useEffect(() => registerVideoControl({ toggle: () => handlers.current.toggle(), step: (d) => handlers.current.step(d) }), [])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.loop = prefs.loop
    v.muted = prefs.muted
  }, [prefs, source.src])

  useEffect(() => {
    if (source.src) void videoRef.current?.play().catch(() => undefined)
  }, [source.src])

  const facts = image
    ? videoFacts({ ...image, video_fps: fps }, (n) => t('video.fps', { n }), (b) => fileSize(b))
    : ''
  const note = noteFor()

  function noteFor(): { text: string; install: boolean } {
    if (source.status.kind === 'needsTools') {
      return { text: t('video.needsConversion', { action: t(installLabelKey()) }), install: true }
    }
    if (source.note) return { text: source.note, install: false }
    const state = image?.video_probe_state
    if (state === 'pending') {
      const ready = support.data?.available === true
      return { text: ready ? t('video.reading') : t('video.noToolsNote'), install: !ready }
    }
    if (state === 'unreadable') return { text: t('video.unreadableNote', { reason: detail.data?.image.video_probe_error ?? '' }), install: false }
    const recipe = companionRecipe(detail.data?.image.metadata_json)
    return recipe ? { text: t('video.recipeFromCompanion', { file: recipe.file }), install: false } : { text: '', install: false }
  }

  function installLabelKey() {
    return support.data?.estimated_mb ? 'video.installWithSize' : 'video.install'
  }
  const installLabel = t(installLabelKey(), { mb: support.data?.estimated_mb ?? 0 })
  const installing = support.data?.install.state === 'running'

  return (
    <div className={styles.wrap} data-testid="lightbox-video">
      <video
        ref={videoRef}
        key={`${id}-${source.src ?? 'none'}`}
        className={styles.video}
        src={source.src ?? undefined}
        poster={thumbnailUrl(id, 384)}
        controls
        autoPlay
        playsInline
        preload="auto"
        aria-label={t('video.player.label')}
        data-testid="video-element"
        onError={() => source.src && source.fail()}
        onLoadedMetadata={(e) => e.currentTarget.videoWidth === 0 && source.fail()}
        onVolumeChange={(e) => e.currentTarget.muted !== prefs.muted && update({ muted: e.currentTarget.muted })}
      />
      <div className={styles.bar} role="toolbar" aria-label={t('video.player.label')} title={t('video.keysTip')}>
        <button type="button" className="btn" aria-pressed={prefs.loop} onClick={() => update({ loop: !prefs.loop })} data-testid="video-loop">
          {prefs.loop ? t('video.loopOn') : t('video.loopOff')}
        </button>
        <button type="button" className="btn" aria-pressed={!prefs.muted} onClick={() => update({ muted: !prefs.muted })} data-testid="video-sound">
          {prefs.muted ? t('video.soundOff') : t('video.soundOn')}
        </button>
        <button type="button" className="btn" onClick={() => step(-1)} title={t('video.prevFrameTip')} data-testid="video-prev-frame">
          {t('video.prevFrame')} <kbd>,</kbd>
        </button>
        <button type="button" className="btn" onClick={() => step(1)} title={t('video.nextFrameTip')} data-testid="video-next-frame">
          {t('video.nextFrame')} <kbd>.</kbd>
        </button>
        <span className={`${styles.facts} mono`} data-testid="video-facts">
          {facts}
        </span>
      </div>
      {note.text && (
        <p className={styles.note} role="status" data-testid="video-note">
          {note.text}
          {note.install && support.data?.can_install !== false && (
            <button type="button" className="btn btn-small" disabled={installing} onClick={() => void installVideoSupport()} data-testid="video-note-install">
              {installLabel}
            </button>
          )}
        </p>
      )}
    </div>
  )
}
