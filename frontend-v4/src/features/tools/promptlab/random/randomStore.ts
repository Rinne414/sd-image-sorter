import { create } from 'zustand'
import { useToasts } from '../../../../ui/toasts'
import { tr } from '../../../jobs/jobs'
import { plt } from '../plText'
import { DEFAULT_WEIGHT, type Setup } from './slots'
import { EMPTY_SETUP, readSetup, setupConfig, type RandomSetup } from './setup'

// Random mode's setup, kept across restarts (see setup.ts for what it holds).

const KEY = 'sd-v4-promptlab-random'

function load(): RandomSetup {
  try {
    return readSetup(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return { ...EMPTY_SETUP }
  }
}

export const useRandom = create<RandomSetup>(load)

useRandom.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(setupConfig(s)))
  } catch {
    // storage blocked: kept for this visit only
  }
})

export const setRandom = (patch: Partial<RandomSetup>) => useRandom.setState(patch)

export const weightOf = (s: Setup, cat: string) => s.weights[cat] ?? DEFAULT_WEIGHT

export function toggleLock(cat: string): void {
  const locked = { ...useRandom.getState().locked }
  if (locked[cat]) delete locked[cat]
  else locked[cat] = true
  setRandom({ locked })
}

export function setWeight(cat: string, weight: number): void {
  setRandom({ weights: { ...useRandom.getState().weights, [cat]: weight } })
}

export function toggleTagSet(id: string): void {
  const sets = useRandom.getState().tagSets
  setRandom({ tagSets: sets.includes(id) ? sets.filter((s) => s !== id) : [...sets, id] })
}

/** Empty every slot and unlock it (weights and options stay); Undo puts them back. */
export function clearSlots(): void {
  const { slots, locked } = useRandom.getState()
  setRandom({ slots: {}, locked: {} })
  useToasts.getState().push(plt('pl.rnd.cleared'), 'info', { label: tr('toast.undo'), run: () => setRandom({ slots, locked }) })
}
