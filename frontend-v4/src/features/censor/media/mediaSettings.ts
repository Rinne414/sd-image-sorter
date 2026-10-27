import { create } from 'zustand'

// How a GIF or video is censored, beyond what to find (that is the censor
// step's own detection settings). All remembered, under the censor prefix so
// "Reset all settings" clears them too.

export type MediaStyle = 'mosaic' | 'blur' | 'black'
export const MEDIA_STYLES: readonly MediaStyle[] = ['mosaic', 'blur', 'black']

export const BLOCK_MIN = 4
export const BLOCK_MAX = 64
export const EVERY_MIN = 1
export const EVERY_MAX = 60
export const HOLD_MIN = 0
export const HOLD_MAX = 600

const KEY = {
  style: 'sd-v4-censor-media-style',
  blockAuto: 'sd-v4-censor-media-block-auto',
  block: 'sd-v4-censor-media-block',
  every: 'sd-v4-censor-media-every',
  hold: 'sd-v4-censor-media-hold',
  output: 'sd-v4-censor-media-output',
  source: 'sd-v4-censor-media-source',
} as const

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | number | boolean): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // storage blocked: the setting just won't be remembered
  }
}

/** A whole number from storage kept inside its range; `fallback` when missing or unreadable. */
export function readWhole(raw: string | null, fallback: number, lo: number, hi: number): number {
  const v = Number(raw)
  return raw !== null && raw.trim() !== '' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback
}

export function readStyle(raw: string | null): MediaStyle {
  return (MEDIA_STYLES as readonly string[]).includes(raw ?? '') ? (raw as MediaStyle) : 'mosaic'
}

interface MediaSettings {
  style: MediaStyle
  /** The block size follows the picture's size (the backend's Auto). */
  blockAuto: boolean
  block: number
  /** The detector runs on every Nth frame; the frames between reuse its regions. */
  every: number
  /** Frames a region stays covered after the detector stops seeing it. */
  hold: number
  /** '' = the video-censor folder in the output folder. */
  output: string
  /** The last folder chosen as a source. */
  source: string
  setStyle: (style: MediaStyle) => void
  setBlockAuto: (auto: boolean) => void
  setBlock: (block: number) => void
  setEvery: (every: number) => void
  setHold: (hold: number) => void
  setOutput: (output: string) => void
  setSource: (source: string) => void
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)))

export const useMediaSettings = create<MediaSettings>((set) => ({
  style: readStyle(read(KEY.style)),
  blockAuto: read(KEY.blockAuto) !== 'false',
  block: readWhole(read(KEY.block), 16, BLOCK_MIN, BLOCK_MAX),
  every: readWhole(read(KEY.every), 2, EVERY_MIN, EVERY_MAX),
  hold: readWhole(read(KEY.hold), 8, HOLD_MIN, HOLD_MAX),
  output: read(KEY.output) ?? '',
  source: read(KEY.source) ?? '',
  setStyle: (style) => {
    write(KEY.style, style)
    set({ style })
  },
  setBlockAuto: (blockAuto) => {
    write(KEY.blockAuto, blockAuto)
    set({ blockAuto })
  },
  setBlock: (value) => {
    const block = clamp(value, BLOCK_MIN, BLOCK_MAX)
    write(KEY.block, block)
    set({ block })
  },
  setEvery: (value) => {
    const every = clamp(value, EVERY_MIN, EVERY_MAX)
    write(KEY.every, every)
    set({ every })
  },
  setHold: (value) => {
    const hold = clamp(value, HOLD_MIN, HOLD_MAX)
    write(KEY.hold, hold)
    set({ hold })
  },
  setOutput: (output) => {
    write(KEY.output, output)
    set({ output })
  },
  setSource: (source) => {
    write(KEY.source, source)
    set({ source })
  },
}))
