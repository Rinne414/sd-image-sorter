import { create } from 'zustand'
import { cleanSetup, type SortSetup } from './savedSetup'

// The Sort page's own settings: named presets (per library), the key
// cooldown, the confirmation sound, focus mode and the information column.
// Cooldown, sound and focus share V3.5's keys (same origin), so switching
// apps keeps them; presets hold V4's setup shape and live under V4's own key.

export interface SortPreset extends SortSetup {
  name: string
}

const presetKey = (libraryId: string) => `sd-v4-sort-presets:${libraryId}`
const COOLDOWN_KEY = 'manual_sort_cooldown_ms_v1'
const SOUND_KEY = 'sort-audio-enabled'
const FOCUS_KEY = 'manual_sort_zen_v1'
const INFO_KEY = 'sd-v4-sort-info'

/** Allowed cooldown between two keys, as V3.5 offers it. */
export const COOLDOWN_MIN_MS = 100
export const COOLDOWN_MAX_MS = 2000
export const COOLDOWN_STEP_MS = 50

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage blocked: the setting lasts until the page closes
  }
}

export function loadPresets(libraryId: string): SortPreset[] {
  try {
    const raw = JSON.parse(read(presetKey(libraryId)) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.flatMap((p: unknown) => {
      const name = p && typeof p === 'object' ? (p as { name?: unknown }).name : null
      return typeof name === 'string' && name.trim() ? [{ ...cleanSetup(p), name: name.trim() }] : []
    })
  } catch {
    return []
  }
}

/** Save under `name`; a preset with the same name is replaced where it stood. */
export function savePreset(libraryId: string, name: string, setup: SortSetup): SortPreset[] {
  const preset: SortPreset = { ...cleanSetup(setup), name: name.trim() }
  const list = loadPresets(libraryId)
  const at = list.findIndex((p) => p.name === preset.name)
  const next = at >= 0 ? list.map((p, i) => (i === at ? preset : p)) : [...list, preset]
  write(presetKey(libraryId), JSON.stringify(next))
  return next
}

export function deletePreset(libraryId: string, name: string): SortPreset[] {
  const next = loadPresets(libraryId).filter((p) => p.name !== name)
  write(presetKey(libraryId), JSON.stringify(next))
  return next
}

/** The setup part of a preset (what loading it restores). */
export function presetSetup(preset: SortPreset): SortSetup {
  const { mode, folders, operation } = preset
  return { mode, folders, operation }
}

function clampCooldown(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, Math.round(ms)))
}

interface PrefsState {
  /** 0: off. */
  cooldownMs: number
  sound: boolean
  focus: boolean
  info: boolean
  setCooldown: (ms: number) => void
  setSound: (on: boolean) => void
  setFocus: (on: boolean) => void
  setInfo: (on: boolean) => void
}

export const useSortPrefs = create<PrefsState>((set) => ({
  cooldownMs: clampCooldown(Number(read(COOLDOWN_KEY) ?? 0)),
  sound: read(SOUND_KEY) === 'true',
  focus: read(FOCUS_KEY) === '1',
  info: read(INFO_KEY) === '1',
  setCooldown: (ms) => {
    const cooldownMs = clampCooldown(ms)
    write(COOLDOWN_KEY, String(cooldownMs))
    set({ cooldownMs })
  },
  setSound: (sound) => {
    write(SOUND_KEY, sound ? 'true' : 'false')
    set({ sound })
  },
  setFocus: (focus) => {
    write(FOCUS_KEY, focus ? '1' : '0')
    set({ focus })
  },
  setInfo: (info) => {
    write(INFO_KEY, info ? '1' : '0')
    set({ info })
  },
}))

/** Exposed for the tests: the clamp every stored cooldown goes through. */
export { clampCooldown }
