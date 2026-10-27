import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { convertedVideoUrl, getPlayback, requestConvertedPreview, videoFileUrl, type ConvertedPreview, type Playback } from './videoApi'
import { canPreviewInBrowser } from './videoMedia'

const POLL_MS = 1000

export type SourceStatus =
  | { kind: 'original' }
  /** The browser cannot play it and ffmpeg is not there to make a preview. */
  | { kind: 'needsTools' }
  | { kind: 'converting'; percent: number }
  | { kind: 'converted' }
  | { kind: 'failed'; reason: string }
  | { kind: 'lost' }

interface Args {
  id: number
  codec: string | null | undefined
  playback: Playback | undefined
  /** ffmpeg is installed (from the support status, else from the playback answer). */
  tools: boolean | undefined
}

/**
 * Where a video plays from: the original file, or (when the browser cannot
 * decode it) a converted VP9 preview the backend makes once. A codec known to be
 * undecodable goes straight to the preview instead of downloading the original.
 */
export function useVideoSource({ id, codec, playback, tools }: Args) {
  const t = useT()
  const [status, setStatus] = useState<SourceStatus>({ kind: 'original' })
  const tried = useRef(false)
  const alive = useRef(0)
  const toolsRef = useRef(tools)
  toolsRef.current = tools
  const browserCodec = canPreviewInBrowser(codec)

  const follow = useCallback(async (token: number, start: ConvertedPreview) => {
    let state = start
    while (alive.current === token) {
      if (state.status === 'done') return setStatus({ kind: 'converted' })
      if (state.status === 'failed') return setStatus({ kind: 'failed', reason: state.error ?? '' })
      setStatus({ kind: 'converting', percent: Math.round((Number(state.progress) || 0) * 100) })
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      if (alive.current !== token) return
      try {
        state = (await getPlayback(id)).converted
      } catch {
        if (alive.current === token) setStatus({ kind: 'lost' })
        return
      }
    }
  }, [id])

  const convert = useCallback(async () => {
    if (tried.current) return
    tried.current = true
    const token = alive.current
    if (toolsRef.current === false) return setStatus({ kind: 'needsTools' })
    try {
      await follow(token, await requestConvertedPreview(id))
    } catch (error) {
      if (alive.current === token) setStatus({ kind: 'failed', reason: (error as Error).message })
    }
  }, [follow, id])

  useEffect(() => {
    alive.current += 1
    tried.current = false
    setStatus({ kind: 'original' })
    return () => {
      alive.current += 1
    }
  }, [id])

  // Known not to play: go to the preview now. The codec may only be known once the playback answer is in.
  const known = playback ? playback.plays_in_browser === false : !browserCodec
  useEffect(() => {
    if (known) void convert()
  }, [known, convert])

  // The preview is made once ffmpeg arrives (the install finishes while the note is up).
  useEffect(() => {
    if (status.kind === 'needsTools' && tools === true) {
      tried.current = false
      void convert()
    }
  }, [status.kind, tools, convert])

  const src = status.kind === 'converted' ? convertedVideoUrl(id) : status.kind === 'original' && !known ? videoFileUrl(id) : null
  const note =
    status.kind === 'converting'
      ? t('video.converting', { percent: status.percent })
      : status.kind === 'converted'
        ? t('video.playingConverted')
        : status.kind === 'failed'
          ? t('video.conversionFailed', { reason: status.reason })
          : status.kind === 'lost'
            ? t('video.conversionLost')
            : ''
  return { src, status, note, fail: convert }
}
