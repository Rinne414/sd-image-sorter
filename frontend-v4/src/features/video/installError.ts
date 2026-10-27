import type { MessageKey, Params } from '../../i18n'

// Why a video support install failed, in words. The backend says it with a code
// (services/ffmpeg_install.py failure_code) and params; the system's own error
// text stays in the log and is shown only for a failure nobody has a sentence for.

type Say = (key: MessageKey, params?: Params) => string

const WORDS: Record<string, MessageKey> = {
  video_install_unsupported: 'video.err.unsupported',
  video_install_no_build: 'video.err.noBuild',
  video_install_no_checksum: 'video.err.noChecksum',
  video_install_checksum_mismatch: 'video.err.checksumMismatch',
  video_install_bad_archive: 'video.err.badArchive',
  video_install_site_refused: 'video.err.siteRefused',
  video_install_timeout: 'video.err.timeout',
  video_install_unreachable: 'video.err.unreachable',
  video_install_connection_broken: 'video.err.connectionBroken',
}

export interface InstallFailure {
  /** The backend's code (install status: error_code; a refused request: the error code). */
  code?: string | null
  params?: Record<string, unknown> | null
  /** The raw text; only for a code with no sentence. */
  message?: string | null
}

const paramsOf = (params: InstallFailure['params']): Params => {
  const out: Params = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value
  }
  return out
}

/** The sentence for a failed install; never the code itself. */
export function installFailureText(failure: InstallFailure, say: Say): string {
  const key = failure.code ? WORDS[failure.code] : undefined
  if (key) return say(key, paramsOf(failure.params))
  const reason = (typeof failure.params?.reason === 'string' && failure.params.reason) || failure.message || ''
  return reason ? say('video.err.unknown', { reason }) : say('video.err.unknownBare')
}
