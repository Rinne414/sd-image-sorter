import { create } from 'zustand'
import { useToasts } from '../../../../ui/toasts'
import { fetchCategories } from '../labApi'
import { setMode } from '../labStore'
import { plt } from '../plText'
import type { Violation } from '../types'
import { generateBody } from './generateBody'
import { generate, validate } from './randomApi'
import { setRandom, useRandom } from './randomStore'
import { drawSlots, newSeed, parseSeed, placeTags, seedsFor, slotTags, withAffixes, type Rule, type Slots } from './slots'

// Running Random mode: draw and write prompts, check conflicts, and take tags
// sent from Stats.

export interface RandomResult {
  seed: number
  prompt: string
  negative: string
  violations: Violation[]
}

interface Run {
  running: boolean
  results: RandomResult[]
  error: string | null
  /** The last conflict check of the slots (null: not checked since they changed). */
  check: { violations: Violation[] } | { error: string } | null
}

export const useRandomRun = create<Run>(() => ({ running: false, results: [], error: null, check: null }))

// A change to the slots makes an earlier check stale.
useRandom.subscribe((s, prev) => {
  if (s.slots !== prev.slots && useRandomRun.getState().check) useRandomRun.setState({ check: null })
})

const words = (text: string) => text.split(',').map((w) => w.trim()).filter(Boolean)

/** One prompt from these slots: the backend writes it, the fixed words go around it, then it is checked. */
async function writeOne(slots: Slots, seed: number): Promise<RandomResult> {
  const s = useRandom.getState()
  const res = await generate(generateBody({ ...s, slots }, { quality: s.quality, negative: s.negative, tagSets: s.tagSets }, seed))
  const prompt = withAffixes(res.positive_prompt, s.prepend, s.append)
  const tags = words(prompt)
  const violations = tags.length ? (await validate(tags)).violations : []
  return { seed, prompt, negative: res.negative_prompt, violations }
}

async function run(draws: { slots: Slots; seed: number }[]): Promise<void> {
  useRandomRun.setState({ running: true, error: null })
  try {
    const results = await Promise.all(draws.map((d) => writeOne(d.slots, d.seed)))
    useRandomRun.setState({ running: false, results })
  } catch (error) {
    useRandomRun.setState({ running: false, error: (error as Error).message })
  }
}

function baseSeed(): number {
  return parseSeed(useRandom.getState().seed) ?? newSeed()
}

/** Redraw the unlocked slots (seed, seed + 1, … for several) and write a prompt from each draw. */
export async function randomize(pool: Record<string, string[]>, rules: readonly Rule[]): Promise<void> {
  const s = useRandom.getState()
  const draws = seedsFor(baseSeed(), s.count).map((seed) => ({ seed, slots: drawSlots(pool, s, seed, rules) }))
  setRandom({ slots: draws[0]?.slots ?? s.slots })
  await run(draws)
}

/** One prompt from the slots as they are. */
export async function generateNow(): Promise<void> {
  await run([{ slots: useRandom.getState().slots, seed: baseSeed() }])
}

/** Check the slots and fixed words against the rules. */
export async function checkSlots(): Promise<void> {
  const s = useRandom.getState()
  const tags = [...words(s.prepend), ...slotTags(s.slots), ...words(s.append)]
  try {
    const violations = tags.length ? (await validate(tags)).violations : []
    useRandomRun.setState({ check: { violations } })
  } catch (error) {
    useRandomRun.setState({ check: { error: (error as Error).message } })
  }
}

/** Tags from Stats: each into the slot of its category, then Random opens. */
export async function sendToRandom(tags: readonly string[]): Promise<void> {
  const categories = await fetchCategories(tags)
  const { slots, added } = placeTags(
    useRandom.getState().slots,
    tags.map((tag) => ({ tag, category: categories.get(tag) ?? 'unknown' })),
  )
  setMode('random')
  if (!added) {
    useToasts.getState().push(plt('pl.alreadyInRandom'))
    return
  }
  setRandom({ slots })
  useToasts.getState().push(plt('pl.sentToRandom', { tags: tags.join(', ') }))
}

export function keepSeed(seed: number): void {
  setRandom({ seed: String(seed) })
  useToasts.getState().push(plt('pl.rnd.seedKept', { seed: String(seed) }))
}
