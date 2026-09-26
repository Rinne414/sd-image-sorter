import { create } from 'zustand'
import type { Batch, BatchKind, BatchTemplate } from '../../api/types'

// Which batch dialog is open. The selection bar, Ctrl K, the Batch page and
// Home all open the same dialogs through here; the ids are copied on open so
// a change underneath cannot alter what the dialog applies to.

/** Where a new batch was asked for, which decides what happens after it is made. */
export type CreateOrigin = 'selection' | 'adding' | 'page'

export type BatchDialog =
  | { type: 'create'; kind: BatchKind; template: BatchTemplate | null; imageIds: number[]; origin: CreateOrigin }
  | { type: 'delete'; batch: { id: number; name: string; item_count: number; kind: BatchKind; orphaned: boolean } }
  | { type: 'template'; batch: Batch }
  | { type: 'copy'; batch: { id: number; name: string } }

interface State {
  dialog: BatchDialog | null
  show: (dialog: BatchDialog) => void
  close: () => void
}

export const useBatchDialog = create<State>((set) => ({
  dialog: null,
  show: (dialog) =>
    set({ dialog: dialog.type === 'create' ? { ...dialog, imageIds: [...dialog.imageIds] } : dialog }),
  close: () => set({ dialog: null }),
}))

/** Ask for a new batch's name (kind or template), for these images. */
export function askNewBatch(kind: BatchKind, imageIds: number[], origin: CreateOrigin, template: BatchTemplate | null = null): void {
  useBatchDialog.getState().show({ type: 'create', kind: template?.kind ?? kind, template, imageIds, origin })
}
