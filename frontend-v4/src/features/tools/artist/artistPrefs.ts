import { create } from 'zustand'

// The style tool's settings: model source (and a local file's path), the
// confidence floor, the graphics card, and whether images that already have a
// result are skipped. They are remembered as they change, in the key V3.5
// already uses, so both apps and right-click "识别画风" share them.

const KEY = 'sd-image-sorter-artist-defaults-v1'

export type ModelSource = 'huggingface' | 'modelscope' | 'local'
export const MODEL_SOURCES: readonly ModelSource[] = ['huggingface', 'modelscope', 'local']

export interface ArtistPrefs {
  modelSource: ModelSource
  modelPath: string
  /** 0 to 0.25; it can only tighten what the backend keeps. */
  threshold: number
  useGpu: boolean
  skipExisting: boolean
}

export const THRESHOLD_MAX = 0.25

export const DEFAULT_PREFS: ArtistPrefs = { modelSource: 'huggingface', modelPath: '', threshold: 0.03, useGpu: true, skipExisting: true }

type Raw = Record<string, unknown>

export function parsePrefs(value: unknown): ArtistPrefs {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PREFS }
  const raw = value as Raw
  const source = MODEL_SOURCES.find((s) => s === raw.modelSource) ?? DEFAULT_PREFS.modelSource
  const threshold = typeof raw.threshold === 'number' && raw.threshold >= 0 && raw.threshold <= THRESHOLD_MAX ? raw.threshold : DEFAULT_PREFS.threshold
  return {
    modelSource: source,
    modelPath: typeof raw.modelPath === 'string' ? raw.modelPath.trim() : '',
    threshold,
    useGpu: typeof raw.useGpu === 'boolean' ? raw.useGpu : DEFAULT_PREFS.useGpu,
    skipExisting: typeof raw.skipExisting === 'boolean' ? raw.skipExisting : DEFAULT_PREFS.skipExisting,
  }
}

/** V3.5's shape (version 1), plus the skip choice V3.5 ignores. */
export function toStored(prefs: ArtistPrefs): Raw {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    modelSource: prefs.modelSource,
    modelPath: prefs.modelPath.trim(),
    threshold: prefs.threshold,
    useGpu: prefs.useGpu,
    skipExisting: prefs.skipExisting,
  }
}

export interface ModelConfig {
  model_source: ModelSource
  model_path: string | null
  use_gpu: boolean
}

/** What the identify request says about the model; null when a local source has no path. */
export function modelConfig(prefs: ArtistPrefs): ModelConfig | null {
  const local = prefs.modelSource === 'local'
  const path = prefs.modelPath.trim()
  if (local && !path) return null
  return { model_source: prefs.modelSource, model_path: local ? path : null, use_gpu: prefs.useGpu }
}

function load(): ArtistPrefs {
  try {
    const text = localStorage.getItem(KEY)
    return parsePrefs(text ? JSON.parse(text) : null)
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

function save(prefs: ArtistPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(toStored(prefs)))
  } catch {
    // storage blocked: the settings last until the page closes
  }
}

export const useArtistPrefs = create<ArtistPrefs>(() => load())

export function setArtistPrefs(patch: Partial<ArtistPrefs>): void {
  useArtistPrefs.setState(patch)
  save(useArtistPrefs.getState())
}

export function resetArtistPrefs(): void {
  useArtistPrefs.setState({ ...DEFAULT_PREFS })
  try {
    localStorage.removeItem(KEY)
  } catch {
    // storage blocked
  }
}
