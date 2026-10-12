import { create } from 'zustand'
import type { MaskShape } from './detection'

// The detection settings, all remembered (owner: "settings are remembered").
// The detector stays unset until the user picks one: until then the backend's
// recommendation is used, and a choice once made is never reset on load.

export type DetectorId = 'both' | 'nudenet' | 'legacy' | 'sam3'
export const DETECTORS: readonly DetectorId[] = ['both', 'nudenet', 'legacy', 'sam3']

/** Body parts the privacy detectors report (the backend folds aliases like "penis" into these). */
export const TARGETS = ['breasts', 'pussy', 'dick', 'anus', 'buttocks', 'cum'] as const
export type Target = (typeof TARGETS)[number]
const DEFAULT_TARGETS: Target[] = ['breasts', 'pussy', 'dick', 'anus', 'buttocks']

export const CONFIDENCE_MIN = 0.05
export const CONFIDENCE_MAX = 0.95
const DEFAULT_CONFIDENCE = 0.5

const KEY = {
  detector: 'sd-v4-censor-detect-model',
  targets: 'sd-v4-censor-detect-targets',
  confidence: 'sd-v4-censor-detect-confidence',
  shape: 'sd-v4-censor-detect-shape',
  prompt: 'sd-v4-censor-detect-prompt',
  yolo: 'sd-v4-censor-detect-yolo',
  customPath: 'sd-v4-censor-detect-custom-path',
} as const

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
    // storage blocked: the setting just won't be remembered
  }
}

function readDetector(): DetectorId | null {
  const v = read(KEY.detector)
  return (DETECTORS as readonly string[]).includes(v ?? '') ? (v as DetectorId) : null
}

function readTargets(): Target[] {
  try {
    const v: unknown = JSON.parse(read(KEY.targets) ?? 'null')
    if (Array.isArray(v)) return TARGETS.filter((t) => v.includes(t))
  } catch {
    // unreadable: the defaults
  }
  return DEFAULT_TARGETS
}

const roundConfidence = (v: number) => Math.round(Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, v)) * 100) / 100

function readConfidence(): number {
  const raw = read(KEY.confidence)
  const v = Number(raw)
  return raw !== null && Number.isFinite(v) ? roundConfidence(v) : DEFAULT_CONFIDENCE
}

interface DetectSettings {
  /** null: not chosen yet (the backend's recommendation applies). */
  detector: DetectorId | null
  targets: Target[]
  confidence: number
  maskShape: MaskShape
  /** SAM3 words, comma separated: what the SAM3 detector and text segmentation look for. */
  prompt: string
  /** Installed YOLO file ('' = the backend's default privacy model). */
  yolo: string
  /** A YOLO file typed in by hand; wins over `yolo` when set. */
  customPath: string
  setDetector: (detector: DetectorId) => void
  toggleTarget: (target: Target) => void
  setConfidence: (value: number) => void
  setMaskShape: (shape: MaskShape) => void
  setPrompt: (prompt: string) => void
  setYolo: (path: string) => void
  setCustomPath: (path: string) => void
}

export const useDetectSettings = create<DetectSettings>((set, get) => ({
  detector: readDetector(),
  targets: readTargets(),
  confidence: readConfidence(),
  maskShape: read(KEY.shape) === 'box' ? 'box' : 'precise',
  prompt: read(KEY.prompt) ?? '',
  yolo: read(KEY.yolo) ?? '',
  customPath: read(KEY.customPath) ?? '',
  setDetector: (detector) => {
    write(KEY.detector, detector)
    set({ detector })
  },
  toggleTarget: (target) => {
    const now = get().targets
    const targets = now.includes(target) ? now.filter((t) => t !== target) : TARGETS.filter((t) => t === target || now.includes(t))
    write(KEY.targets, JSON.stringify(targets))
    set({ targets })
  },
  setConfidence: (value) => {
    const confidence = roundConfidence(value)
    write(KEY.confidence, String(confidence))
    set({ confidence })
  },
  setMaskShape: (maskShape) => {
    write(KEY.shape, maskShape)
    set({ maskShape })
  },
  setPrompt: (prompt) => {
    write(KEY.prompt, prompt)
    set({ prompt })
  },
  setYolo: (yolo) => {
    write(KEY.yolo, yolo)
    set({ yolo })
  },
  setCustomPath: (customPath) => {
    write(KEY.customPath, customPath)
    set({ customPath })
  },
}))

/** The detector a run uses: the user's choice, else the backend's recommendation, else NudeNet (downloadable). */
export function effectiveDetector(chosen: DetectorId | null, recommended: string | null | undefined): DetectorId {
  if (chosen) return chosen
  return (DETECTORS as readonly string[]).includes(recommended ?? '') ? (recommended as DetectorId) : 'nudenet'
}

/** The SAM3 words as a list: split on commas (ASCII or Chinese), blanks and repeats dropped. */
export function promptWords(prompt: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of prompt.split(/[,，]/)) {
    const word = raw.trim()
    if (word && !seen.has(word.toLowerCase())) {
      seen.add(word.toLowerCase())
      out.push(word)
    }
  }
  return out
}

/** Add a common word to the prompt unless it is there already. */
export function addPromptWord(prompt: string, word: string): string {
  const words = promptWords(prompt)
  return words.some((w) => w.toLowerCase() === word.toLowerCase()) ? words.join(', ') : [...words, word].join(', ')
}

/** Does this detector take the body-part targets? (SAM3 finds what its words say instead.) */
export const usesTargets = (detector: DetectorId) => detector !== 'sam3'
