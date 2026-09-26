import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../../../api/client'
import { queryClient } from '../../../../api/queryClient'
import type { GeneratedPrompt, PromptPreset, TagSet, ValidateResult } from '../types'
import type { GenerateConfig } from './generateBody'
import type { Rule } from './slots'

// Random mode's reads and writes. The tag pool, tag sets, rules and presets
// belong to the whole app (not one library).

export const RANDOM_KEYS = {
  categories: ['prompt-categories'],
  sets: ['prompt-sets'],
  rules: ['prompt-exclusions'],
  presets: ['prompt-presets'],
} as const

export function usePool() {
  return useQuery({
    queryKey: RANDOM_KEYS.categories,
    queryFn: async ({ signal }) => unwrap<{ categories: Record<string, string[]> }>(await api.GET('/api/prompts/categories', { signal })).categories,
    staleTime: 5 * 60_000,
  })
}

export function useTagSets() {
  return useQuery({
    queryKey: RANDOM_KEYS.sets,
    queryFn: async ({ signal }) => unwrap<{ sets: TagSet[] }>(await api.GET('/api/prompts/sets', { signal })).sets,
    staleTime: 5 * 60_000,
  })
}

export function useRules() {
  return useQuery({
    queryKey: RANDOM_KEYS.rules,
    queryFn: async ({ signal }) => unwrap<{ rules: Rule[] }>(await api.GET('/api/prompts/exclusions', { signal })).rules,
    staleTime: 5 * 60_000,
  })
}

export function usePresets() {
  return useQuery({
    queryKey: RANDOM_KEYS.presets,
    queryFn: async ({ signal }) => unwrap<{ presets: PromptPreset[] }>(await api.GET('/api/prompts/presets', { signal })).presets,
    staleTime: 5 * 60_000,
  })
}

/** A user-made set or rule has a number id; built-in ones have text ids and cannot be deleted. */
export const isOwn = (id: number | string | null) => typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id))

export async function generate(body: GenerateConfig): Promise<GeneratedPrompt> {
  return unwrap<GeneratedPrompt>(await api.POST('/api/prompts/generate', { body }))
}

export async function validate(tags: string[]): Promise<ValidateResult> {
  return unwrap<ValidateResult>(await api.POST('/api/prompts/validate', { body: { tags } }))
}

/** Creating a set or rule makes the backend reload its tag pool too. */
function refresh(...keys: (keyof typeof RANDOM_KEYS)[]): void {
  for (const key of keys) void queryClient.invalidateQueries({ queryKey: RANDOM_KEYS[key] })
}

export async function savePreset(name: string, config: Record<string, unknown>): Promise<void> {
  unwrap(await api.POST('/api/prompts/presets', { body: { name, config } }))
  refresh('presets')
}

export async function deletePreset(id: number): Promise<void> {
  unwrap(await api.DELETE('/api/prompts/presets/{preset_id}', { params: { path: { preset_id: id } } }))
  refresh('presets')
}

export interface NewSet {
  name: string
  description: string
  category: string
  tags: string[]
}

export async function createSet(set: NewSet): Promise<number> {
  const body = { ...set, tags: set.tags.map((tag) => ({ tag, weight: 1, required: true })) }
  const res = unwrap<{ id: number }>(await api.POST('/api/prompts/sets', { body }))
  refresh('sets', 'categories')
  return res.id
}

export async function deleteSet(id: number | string): Promise<void> {
  unwrap(await api.DELETE('/api/prompts/sets/{set_ref}', { params: { path: { set_ref: String(id) } } }))
  refresh('sets', 'categories')
}

export interface NewRule {
  name: string
  description: string
  when: string[]
  not: string[]
}

export async function createRule(rule: NewRule): Promise<number> {
  const body = {
    rule_name: rule.name,
    description: rule.description,
    conditions: rule.when.map((tag) => ({ tag, type: 'present' })),
    targets: rule.not.map((tag) => ({ tag, category: '' })),
  }
  const res = unwrap<{ id: number }>(await api.POST('/api/prompts/exclusions', { body }))
  refresh('rules', 'categories')
  return res.id
}

export async function deleteRule(id: number | string): Promise<void> {
  unwrap(await api.DELETE('/api/prompts/exclusions/{rule_ref}', { params: { path: { rule_ref: String(id) } } }))
  refresh('rules', 'categories')
}
