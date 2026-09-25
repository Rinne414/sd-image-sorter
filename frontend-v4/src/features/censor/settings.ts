import { create } from 'zustand'
import {
  BLOCK_MAX,
  BLOCK_MIN,
  OPACITY_MAX,
  OPACITY_MIN,
  SIZE_MAX,
  SIZE_MIN,
  STYLES,
  type CensorStyle,
  type Tool,
} from './ops'

// The censor tool settings. Everything but the tool is remembered (owner:
// "settings are remembered"); the editor always opens on the brush so a first
// stroke is never an invisible eraser stroke.

const KEY = {
  style: 'sd-v4-censor-style',
  size: 'sd-v4-censor-size',
  block: 'sd-v4-censor-block',
  color: 'sd-v4-censor-pen-color',
  opacity: 'sd-v4-censor-pen-opacity',
} as const

export const SIZE_STEP = 5

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // storage blocked: the setting just won't be remembered
  }
}

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)))

function readInt(key: string, fallback: number, lo: number, hi: number): number {
  const v = Number(read(key))
  return read(key) !== null && Number.isFinite(v) ? clampInt(v, lo, hi) : fallback
}

function readStyle(): CensorStyle {
  const v = read(KEY.style)
  return (STYLES as readonly string[]).includes(v ?? '') ? (v as CensorStyle) : 'mosaic'
}

function readColor(): string {
  const v = read(KEY.color)
  return v && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '#000000'
}

interface CensorSettings {
  tool: Tool
  style: CensorStyle
  size: number
  block: number
  color: string
  opacity: number
  setTool: (tool: Tool) => void
  setStyle: (style: CensorStyle) => void
  setSize: (size: number) => void
  setBlock: (block: number) => void
  setColor: (color: string) => void
  setOpacity: (opacity: number) => void
}

export const useCensorSettings = create<CensorSettings>((set) => ({
  tool: 'brush',
  style: readStyle(),
  size: readInt(KEY.size, 30, SIZE_MIN, SIZE_MAX),
  block: readInt(KEY.block, 16, BLOCK_MIN, BLOCK_MAX),
  color: readColor(),
  opacity: readInt(KEY.opacity, 100, OPACITY_MIN, OPACITY_MAX),
  setTool: (tool) => set({ tool }),
  setStyle: (style) => {
    write(KEY.style, style)
    set({ style })
  },
  setSize: (value) => {
    const size = clampInt(value, SIZE_MIN, SIZE_MAX)
    write(KEY.size, size)
    set({ size })
  },
  setBlock: (value) => {
    const block = clampInt(value, BLOCK_MIN, BLOCK_MAX)
    write(KEY.block, block)
    set({ block })
  },
  setColor: (value) => {
    if (!/^#[0-9a-f]{6}$/i.test(value)) return
    const color = value.toLowerCase()
    write(KEY.color, color)
    set({ color })
  },
  setOpacity: (value) => {
    const opacity = clampInt(value, OPACITY_MIN, OPACITY_MAX)
    write(KEY.opacity, opacity)
    set({ opacity })
  },
}))
