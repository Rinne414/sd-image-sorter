import { useMemo } from 'react'
import type { Batch } from '../../api/types'
import { removeFromBatch, reorderBatch } from './batchApi'
import { removeEntries, reorderEntries, useBatchProject } from './datasetApi'
import { entriesFromItems, entriesFromProject, type Entry } from './entries'

/** A batch's images as the Pick and Order steps use them, whatever the kind. */
export interface BatchEntries {
  entries: Entry[]
  /** The images come from a Dataset Maker project (folder images possible). */
  isDataset: boolean
  loading: boolean
  error: string | null
  remove: (keys: readonly string[]) => void
  reorder: (keys: readonly string[]) => void
}

/** The Library image ids of these keys, in the order of the keys. */
const libraryIds = (entries: readonly Entry[], keys: readonly string[]): number[] => {
  const byKey = new Map(entries.map((entry) => [entry.key, entry.imageId]))
  return keys.flatMap((key) => {
    const id = byKey.get(key)
    return id === undefined || id === null ? [] : [id]
  })
}

export function useBatchEntries(batch: Batch): BatchEntries {
  const isDataset = batch.kind === 'dataset'
  const project = useBatchProject(batch)
  const view = project.data
  const entries = useMemo(
    () => (isDataset ? (view ? entriesFromProject(view) : []) : entriesFromItems(batch.items)),
    [isDataset, view, batch.items],
  )

  if (isDataset) {
    const names = new Map(entries.map((entry) => [entry.key, entry.filename]))
    return {
      entries,
      isDataset,
      loading: !view && !project.isError,
      error: project.isError ? project.error.message : null,
      remove: (keys) => void removeEntries(batch.id, keys, names),
      reorder: (keys) => void reorderEntries(batch.id, keys),
    }
  }
  return {
    entries,
    isDataset,
    loading: false,
    error: null,
    remove: (keys) => void removeFromBatch(batch, libraryIds(entries, keys)),
    reorder: (keys) => void reorderBatch(batch.id, libraryIds(entries, keys)),
  }
}
