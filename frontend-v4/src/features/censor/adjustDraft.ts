import { create } from 'zustand'
import { ADJUST_KEYS, ADJUST_RANGE, NO_ADJUST, type AdjustKey, type AdjustValues } from './ops'

// The Adjust tab's sliders before they are applied: shown live on the picture,
// turned into an adjust op by "apply". Presets are V3.5's.

export type PresetId = 'reset' | 'vivid' | 'warm' | 'cool' | 'bw' | 'hdr'

export const PRESETS: Record<PresetId, AdjustValues> = {
  reset: NO_ADJUST,
  vivid: { ...NO_ADJUST, brightness: 5, contrast: 20, saturation: 40, sharpen: 30 },
  warm: { ...NO_ADJUST, brightness: 5, contrast: 10, saturation: 15, temperature: 30, vignette: 10 },
  cool: { ...NO_ADJUST, contrast: 10, saturation: 10, temperature: -30, vignette: 10 },
  bw: { ...NO_ADJUST, contrast: 15, saturation: -100, sharpen: 10 },
  hdr: { ...NO_ADJUST, brightness: -5, contrast: 40, saturation: 20, sharpen: 40, temperature: 5, vignette: 30 },
}

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[]

interface DraftState {
  values: AdjustValues
  set: (key: AdjustKey, value: number) => void
  preset: (id: PresetId) => void
}

export const useAdjustDraft = create<DraftState>((set) => ({
  values: NO_ADJUST,
  set: (key, value) =>
    set((s) => {
      const [lo, hi] = ADJUST_RANGE[key]
      return { values: { ...s.values, [key]: Math.min(hi, Math.max(lo, Math.round(value))) } }
    }),
  preset: (id) => set({ values: { ...PRESETS[id] } }),
}))

export const resetAdjustDraft = () => useAdjustDraft.setState({ values: NO_ADJUST })

export { ADJUST_KEYS }
