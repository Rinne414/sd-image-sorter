import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { ChatEvent, LocalModels, Preset, ProbeResult, TestResult, VlmSettings } from './types'
import type { SaveBody } from './vlmForm'

// What Settings › AI services reads and writes (/api/vlm/*). The settings are
// shared with V3.5; the key and the service account never come back.

/** Under the key the dataset tag step reads its VLM status from, so one refresh reaches both. */
export const SETTINGS_KEY = ['vlm-settings', 'raw'] as const
/** Also the Jobs drawer's refresh key for an Ollama download. */
export const LOCAL_MODELS_KEY = ['vlm-local-models'] as const

export function useVlmSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async ({ signal }) => unwrap<VlmSettings>(await api.GET('/api/vlm/settings', { signal })),
    staleTime: 30_000,
  })
}

export function usePresets() {
  return useQuery({
    queryKey: ['vlm-presets'],
    queryFn: async ({ signal }) => unwrap<{ presets: Record<string, Preset> }>(await api.GET('/api/vlm/presets', { signal })).presets ?? {},
    staleTime: Infinity,
  })
}

/** Ollama on this computer: installed, running, the recommended models and the ones it has. */
export function useLocalModels() {
  return useQuery({
    queryKey: LOCAL_MODELS_KEY,
    queryFn: async ({ signal }) => unwrap<LocalModels>(await api.GET('/api/vlm/local-models/recommended', { signal })),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  })
}

/** Everything that reads the VLM settings (this page, the tag panel, the dataset tag step). */
export function refreshVlmSettings(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['vlm-settings'] })
}

export async function saveVlmSettings(body: SaveBody): Promise<void> {
  unwrap(await api.POST('/api/vlm/settings', { body }))
  await refreshVlmSettings()
}

export async function detectProvider(endpoint: string): Promise<string> {
  return unwrap<{ provider: string }>(await api.POST('/api/vlm/detect-provider', { body: { endpoint } })).provider
}

export async function testConnection(): Promise<TestResult> {
  return unwrap<TestResult>(await api.POST('/api/vlm/test'))
}

export async function fetchModels(): Promise<string[]> {
  const res = unwrap<{ models?: unknown }>(await api.POST('/api/vlm/models'))
  return Array.isArray(res.models) ? res.models.filter((m): m is string => typeof m === 'string' && m !== '') : []
}

/** Ramps 1…maxLevel concurrent model-list requests and stores the highest that all succeeded. */
export async function probeConcurrency(maxLevel: number): Promise<ProbeResult> {
  return unwrap<ProbeResult>(await api.POST('/api/vlm/probe-concurrency', { body: { max_level: maxLevel, apply: true } }))
}

export async function pullModel(model: string): Promise<void> {
  unwrap(await api.POST('/api/vlm/local-models/pull', { body: { model } }))
}

export async function deleteModel(model: string): Promise<void> {
  unwrap(await api.POST('/api/vlm/local-models/delete', { body: { model } }))
  await queryClient.invalidateQueries({ queryKey: LOCAL_MODELS_KEY })
}

export async function startOllama(): Promise<void> {
  unwrap(await api.POST('/api/vlm/local-models/start-ollama'))
  await queryClient.invalidateQueries({ queryKey: LOCAL_MODELS_KEY })
}

export async function readChatLog(): Promise<ChatEvent[]> {
  const res = unwrap<{ events?: unknown }>(await api.GET('/api/vlm/caption-batch/debug-chat'))
  return Array.isArray(res.events) ? (res.events as ChatEvent[]) : []
}
