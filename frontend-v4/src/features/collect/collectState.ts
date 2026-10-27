import { create } from 'zustand'
import type { PairingLike } from './collectLogic'

// What the collect host shows: a pasted picture address waiting for a yes, and
// the browser extension asking to be paired. Both are answered in dialogs.

interface CollectState {
  /** A pasted address the program may download, once the user agrees. */
  offeredUrl: string | null
  offerUrl: (url: string) => void
  clearOffer: () => void
  /** The pairing request shown now. */
  pairing: PairingLike | null
  /** Requests closed (answered or not): not shown again until the extension asks anew. */
  dismissed: ReadonlySet<string>
  showPairing: (request: PairingLike) => void
  closePairing: () => void
}

export const useCollect = create<CollectState>((set, get) => ({
  offeredUrl: null,
  offerUrl: (url) => set({ offeredUrl: url }),
  clearOffer: () => set({ offeredUrl: null }),
  pairing: null,
  dismissed: new Set(),
  showPairing: (request) => {
    if (!get().pairing) set({ pairing: request })
  },
  closePairing: () => {
    const request = get().pairing
    if (!request) return
    set({ pairing: null, dismissed: new Set([...get().dismissed, request.id]) })
  },
}))
