import { useEffect } from 'react'
import { create } from 'zustand'
import type { ToolId } from '../../../lib/route'
import { takeHandoff, useHandoff } from '../handoff'
import type { IntakeOrigin } from './intakeFiles'

// The one image a tool (Reader, Reverse prompt) is showing: a file brought in
// (kept until another replaces it, also while the user is on another page),
// or a library image read from the database by id. Each tool has its own.

export type ImageSource =
  | { kind: 'library'; id: number }
  | { kind: 'upload'; file: File; url: string; origin: IntakeOrigin; seq: number }

/** One count for every tool, so each upload's parse has its own cache entry. */
let uploads = 0

export function createSourceStore() {
  const useSource = create<{ source: ImageSource | null }>(() => ({ source: null }))
  const replace = (next: ImageSource | null) => {
    const prev = useSource.getState().source
    if (prev?.kind === 'upload') URL.revokeObjectURL(prev.url)
    useSource.setState({ source: next })
  }
  return {
    useSource,
    openUpload(file: File, origin: IntakeOrigin): void {
      uploads += 1
      replace({ kind: 'upload', file, url: URL.createObjectURL(file), origin, seq: uploads })
    },
    openLibraryImage(id: number): void {
      const prev = useSource.getState().source
      if (prev?.kind === 'library' && prev.id === id) return
      replace({ kind: 'library', id })
    },
    clear(): void {
      replace(null)
    },
  }
}

export const sourceKey = (s: ImageSource): string => (s.kind === 'library' ? `lib-${s.id}` : `up-${s.seq}`)

/** Images sent to this tool from the library ("送到工具 ▸"): the last one sent is opened. */
export function useSourceHandoff(tool: ToolId, open: (id: number) => void): void {
  const pending = useHandoff((s) => s.pending)
  useEffect(() => {
    if (pending?.tool !== tool) return
    const last = takeHandoff(tool)?.at(-1)
    if (last !== undefined) open(last)
  }, [pending, tool, open])
}
