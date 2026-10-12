import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { MessageKey } from '../../i18n'
import type { ToolId } from '../../lib/route'

// Every tool, in the order of the Tools menu. The menu, the tool pages, Ctrl K
// and "送到工具 ▸" (right-click, selection bar, Ctrl K) are all built from
// this list; each tool's page is a lazy import.

export interface ToolEntry {
  id: ToolId
  label: MessageKey
  /** What it takes from the library through "送到工具": one image, several, or none. */
  accepts: 'one' | 'many' | null
  page: LazyExoticComponent<ComponentType>
}

export const TOOLS: readonly ToolEntry[] = [
  { id: 'reader', label: 'tools.reader', accepts: 'one', page: lazy(() => import('./reader/ReaderPage').then((m) => ({ default: m.ReaderPage }))) },
  { id: 'reverse', label: 'tools.reverse', accepts: 'one', page: lazy(() => import('./reverse/ReversePage').then((m) => ({ default: m.ReversePage }))) },
  { id: 'promptlab', label: 'tools.promptlab', accepts: 'one', page: lazy(() => import('./promptlab/PromptLabPage').then((m) => ({ default: m.PromptLabPage }))) },
  { id: 'artist', label: 'tools.artist', accepts: 'many', page: lazy(() => import('./artist/ArtistPage').then((m) => ({ default: m.ArtistPage }))) },
  { id: 'lexicon', label: 'tools.lexicon', accepts: null, page: lazy(() => import('./lexicon/LexiconPage').then((m) => ({ default: m.LexiconPage }))) },
  { id: 'privacy', label: 'tools.privacy', accepts: 'many', page: lazy(() => import('./privacy/PrivacyPage').then((m) => ({ default: m.PrivacyPage }))) },
]

export function toolById(id: ToolId, tools: readonly ToolEntry[] = TOOLS): ToolEntry {
  const tool = tools.find((t) => t.id === id)
  if (!tool) throw new Error(`no tool ${id}`)
  return tool
}

/** The tools "送到工具" offers for this many images: the ones that take that many. */
export function sendTargets(count: number, tools: readonly ToolEntry[] = TOOLS): ToolEntry[] {
  if (count < 1) return []
  return tools.filter((t) => t.accepts === 'many' || (t.accepts === 'one' && count === 1))
}
