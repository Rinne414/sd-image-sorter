import { create } from 'zustand'
import type { ToolId } from '../../lib/route'
import { useApp } from '../../state/store'

// Images handed from the library to a tool ("送到工具 ▸"): the tool page
// takes them once, when it opens. The ids are copied when sent, so later
// picking in the library does not change what the tool got.

interface Handoff {
  tool: ToolId
  ids: number[]
}

export const useHandoff = create<{ pending: Handoff | null }>(() => ({ pending: null }))

/** Hand these images to a tool and open it. */
export function sendToTool(tool: ToolId, ids: readonly number[]): void {
  useHandoff.setState({ pending: { tool, ids: [...ids] } })
  useApp.getState().openTool(tool)
}

/** For the tool's page: the images handed to it, once (null when none are waiting). */
export function takeHandoff(tool: ToolId): number[] | null {
  const pending = useHandoff.getState().pending
  if (!pending || pending.tool !== tool) return null
  useHandoff.setState({ pending: null })
  return pending.ids
}
