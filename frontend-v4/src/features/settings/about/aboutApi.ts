import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../../api/client'
import { translate, useLang, type MessageKey, type Params } from '../../../i18n'
import { copyText } from '../../../lib/format'
import { useToasts } from '../../../ui/toasts'
import { diagnostics, formatDiagnostics, LOG_LINES } from '../../import/supportLog'
import { diagnosticLines, type SystemFacts } from './systemFacts'
import type { AppStats, ChannelSettings, SystemInfo, SystemInfoResponse } from './types'

// What About & updates reads and writes: the version, this computer, the update
// source (proxy), and the copied diagnostics.

const say = (key: MessageKey, params?: Params) => translate(useLang.getState().lang, key, params)

export function useAppStats() {
  return useQuery({
    queryKey: ['about', 'stats'],
    queryFn: async ({ signal }) => unwrap<AppStats>(await api.GET('/api/stats', { signal })),
    staleTime: Infinity,
  })
}

/** The hardware probe; the backend keeps it for 30 s. */
export function useSystemInfo() {
  return useQuery({
    queryKey: ['about', 'system'],
    queryFn: async ({ signal }): Promise<SystemInfo> => unwrap<SystemInfoResponse>(await api.GET('/api/system-info', { signal })).system_info ?? {},
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
}

export const CHANNEL_KEY = ['about', 'channel'] as const

export function useChannel() {
  return useQuery({
    queryKey: CHANNEL_KEY,
    queryFn: async ({ signal }) => unwrap<ChannelSettings>(await api.GET('/api/updates/channel', { signal })),
    staleTime: Infinity,
  })
}

/** Save a proxy prefix; an empty one goes back to official GitHub. */
export async function saveProxy(prefix: string): Promise<ChannelSettings> {
  if (!prefix) return unwrap<ChannelSettings>(await api.DELETE('/api/updates/channel'))
  return unwrap<ChannelSettings>(await api.POST('/api/updates/channel/proxy', { body: { proxy_prefix: prefix, channel_name: 'Custom Proxy' } }))
}

/** The support bundle: the backend's (redacted) log plus the hardware, the update check and the window. */
export async function copyAboutDiagnostics(facts: SystemFacts | null, update: string): Promise<void> {
  const d = await diagnostics(LOG_LINES)
  if (!d) return
  const zoom = parseFloat(document.documentElement.style.zoom) || 1
  const extra = diagnosticLines(facts, update, { width: window.innerWidth, height: window.innerHeight, zoom, agent: navigator.userAgent })
  const ok = await copyText(formatDiagnostics(d, { title: 'SD Image Sorter diagnostics', extra }))
  useToasts.getState().push(ok ? say('import.diag.copied') : say('lib.copy.failed'), ok ? 'info' : 'error')
}
