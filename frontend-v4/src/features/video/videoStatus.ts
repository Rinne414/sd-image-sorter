import type { MessageKey, Params } from '../../i18n'
import { installFailureText } from './installError'
import type { VideoInstall, VideoSupport } from './videoApi'

type Say = (key: MessageKey, params?: Params) => string

const mb = (bytes: number | undefined) => Math.max(1, Math.round((Number(bytes) || 0) / 1e6))

const SOURCE: Record<string, MessageKey> = {
  installed: 'video.sourceInstalled',
  beside_program: 'video.sourceBeside',
  path: 'video.sourcePath',
}

function progressText(install: VideoInstall, say: Say): string {
  if (install.phase === 'downloading' && install.total) {
    return say('video.statusDownloading', { done: mb(install.downloaded), total: mb(install.total) })
  }
  if (install.phase === 'unpacking') return say('video.statusUnpacking')
  return say('video.statusLooking')
}

/** Why the install failed, in words (never the code). */
export const failureOf = (install: VideoInstall, say: Say): string =>
  installFailureText({ code: install.error_code, params: install.error_params, message: install.error }, say)

/** One honest sentence about video support: installing, failed, ready, or missing. */
export function videoStatusText(state: VideoSupport | undefined, say: Say): string {
  if (!state) return say('video.statusChecking')
  const install = state.install
  if (install.state === 'running') return progressText(install, say)
  if (install.state === 'failed') return say('video.statusFailed', { reason: failureOf(install, say) })
  if (state.available) {
    const where = state.source ? say(SOURCE[state.source] ?? 'video.sourcePath') : ''
    const reading = state.pending ? ` ${say('video.statusReading', { n: state.pending })}` : ''
    return say('video.statusReady', { where }) + reading
  }
  if (!state.can_install) return say('video.statusNoBuild')
  return say('video.statusMissing', { from: state.download_from })
}

/** The install button's words: the size when it is known, "Try again" after a failure. */
export function installLabelOf(state: VideoSupport | undefined, say: Say): string {
  if (state?.install.state === 'failed') return say('video.tryAgain')
  return state?.estimated_mb ? say('video.installWithSize', { mb: state.estimated_mb }) : say('video.install')
}
