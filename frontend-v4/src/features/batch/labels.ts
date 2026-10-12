import type { BatchKind, CollectionRow } from '../../api/types'
import type { MessageKey, Params } from '../../i18n'

type T = (key: MessageKey, params?: Params) => string

const KIND: Record<BatchKind, MessageKey> = {
  pixiv: 'batch.kind.pixiv',
  dataset: 'batch.kind.dataset',
  custom: 'batch.kind.custom',
}

const STEP: Record<string, MessageKey> = {
  pick: 'batch.step.pick',
  censor: 'batch.step.censor',
  order: 'batch.step.order',
  name: 'batch.step.name',
  export: 'batch.step.export',
  tag: 'batch.step.tag',
  edit: 'batch.step.edit',
  check: 'batch.step.check',
}

export const BATCH_KINDS: BatchKind[] = ['pixiv', 'dataset', 'custom']

export function kindLabel(kind: BatchKind, t: T): string {
  return t(KIND[kind])
}

/** Built-in step names are translated; a step id a template invented shows as written. */
export function stepLabel(id: string | null, t: T): string {
  if (id === null) return ''
  const key = STEP[id]
  return key ? t(key) : id
}

export function isKnownStep(id: string): boolean {
  return id in STEP
}

/** The built-in Favorites collection is named in English in the database. */
export function collectionName(collection: CollectionRow, t: T): string {
  return collection.slug === 'favorites' ? t('rail.favorites') : collection.name
}
