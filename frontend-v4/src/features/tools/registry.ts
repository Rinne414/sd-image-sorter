import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { MessageKey } from '../../i18n'
import type { ToolId } from '../../lib/route'

// Every tool, in the order of the Tools menu. The menu, the tool pages, Ctrl K
// and "送到工具 ▸" (right-click, selection bar, Ctrl K) are all built from
// this list. A tool built in V4 changes only its own line: ready: true and
// its page as a lazy import, e.g.
//   page: lazy(() => import('./reader/ReaderPage').then((m) => ({ default: m.ReaderPage }))),
// Until then its page says to use it in V3.5.

export interface ToolEntry {
  id: ToolId
  label: MessageKey
  /** One line: what it does. */
  what: MessageKey
  /** What it takes from the library through "送到工具": one image, several, or none. */
  accepts: 'one' | 'many' | null
  /** Built in V4. */
  ready: boolean
  page?: LazyExoticComponent<ComponentType>
}

export const TOOLS: readonly ToolEntry[] = [
  { id: 'reader', label: 'tools.reader', what: 'tools.reader.what', accepts: 'one', ready: true, page: lazy(() => import('./reader/ReaderPage').then((m) => ({ default: m.ReaderPage }))) },
  { id: 'reverse', label: 'tools.reverse', what: 'tools.reverse.what', accepts: 'one', ready: true, page: lazy(() => import('./reverse/ReversePage').then((m) => ({ default: m.ReversePage }))) },
  { id: 'promptlab', label: 'tools.promptlab', what: 'tools.promptlab.what', accepts: 'one', ready: true, page: lazy(() => import('./promptlab/PromptLabPage').then((m) => ({ default: m.PromptLabPage }))) },
  { id: 'artist', label: 'tools.artist', what: 'tools.artist.what', accepts: 'many', ready: true, page: lazy(() => import('./artist/ArtistPage').then((m) => ({ default: m.ArtistPage }))) },
  { id: 'lexicon', label: 'tools.lexicon', what: 'tools.lexicon.what', accepts: null, ready: false },
  { id: 'privacy', label: 'tools.privacy', what: 'tools.privacy.what', accepts: 'many', ready: true, page: lazy(() => import('./privacy/PrivacyPage').then((m) => ({ default: m.PrivacyPage }))) },
]

export function toolById(id: ToolId, tools: readonly ToolEntry[] = TOOLS): ToolEntry {
  const tool = tools.find((t) => t.id === id)
  if (!tool) throw new Error(`no tool ${id}`)
  return tool
}

/** The tools "送到工具" offers for this many images: built ones that take that many. */
export function sendTargets(count: number, tools: readonly ToolEntry[] = TOOLS): ToolEntry[] {
  if (count < 1) return []
  return tools.filter((t) => t.ready && (t.accepts === 'many' || (t.accepts === 'one' && count === 1)))
}
