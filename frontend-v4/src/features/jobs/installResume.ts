import { create } from 'zustand'
import type { InstallTarget } from './installJob'

// The model downloads still to do (localStorage `sd-v4-model-resume`): what a
// "Download models…" run had left when a model needed an app restart, or when
// the tab closed mid-run. `restart` marks a list that continues by itself once
// the app comes back with a different boot id.

export const RESUME_KEY = 'sd-v4-model-resume'

export interface ResumeList {
  items: InstallTarget[]
  restart: boolean
  /** The server's boot id when the list was saved (null: not known). */
  bootId: string | null
  savedAt: number
}

type Raw = Record<string, unknown>

function readItem(value: unknown): InstallTarget | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Raw
  if (typeof raw.card !== 'string' || !raw.card) return null
  const item: InstallTarget = {
    card: raw.card,
    variant: typeof raw.variant === 'string' && raw.variant ? raw.variant : null,
    label: typeof raw.label === 'string' && raw.label ? raw.label : raw.card,
  }
  return typeof raw.source === 'string' && raw.source ? { ...item, source: raw.source } : item
}

const same = (a: InstallTarget, b: InstallTarget) => a.card === b.card && a.variant === b.variant

/** `front` first, then the rest of `list`, each model once. */
export function withTargets(front: readonly InstallTarget[], list: readonly InstallTarget[]): InstallTarget[] {
  const out: InstallTarget[] = []
  for (const item of [...front, ...list]) if (!out.some((o) => same(o, item))) out.push(item)
  return out
}

export function loadResume(): ResumeList | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESUME_KEY) ?? 'null') as Raw | null
    if (!parsed || typeof parsed !== 'object') return null
    const read = (Array.isArray(parsed.items) ? parsed.items : []).map(readItem).filter((i): i is InstallTarget => i !== null)
    const items = withTargets([], read)
    if (!items.length) return null
    return {
      items,
      restart: parsed.restart === true,
      bootId: typeof parsed.bootId === 'string' ? parsed.bootId : null,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    }
  } catch {
    return null
  }
}

/** The saved list, kept in step with storage so the Model Center's banner follows it. */
export const useResume = create<{ list: ResumeList | null }>(() => ({ list: loadResume() }))

export function saveResume(list: Omit<ResumeList, 'savedAt'>): void {
  if (!list.items.length) return clearResume()
  const saved: ResumeList = { ...list, savedAt: Date.now() }
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(saved))
  } catch {
    // storage blocked: the list lives until the tab closes
  }
  useResume.setState({ list: saved })
}

export function clearResume(): void {
  try {
    localStorage.removeItem(RESUME_KEY)
  } catch {
    // storage blocked
  }
  useResume.setState({ list: null })
}

/** At start-up: a list waiting for a restart continues (its code loads only then). */
export function resumeModelDownloads(): void {
  const list = loadResume()
  useResume.setState({ list })
  if (list?.restart) void import('../settings/models/bulkRun').then((m) => m.resumeAfterRestart())
}
