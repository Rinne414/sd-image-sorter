import { create } from 'zustand'
import { api, unwrap } from '../../../api/client'
import { AUTO_CHECK_KEY, readAutoCheck, type UpdateStatus } from './updateState'

// The last update check, shared by About & updates and the top bar's
// "新版本 x.y.z". One check after start (unless switched off); the backend
// keeps a check for 15 minutes, "Check again" asks it to look now.

/** The check after start waits this long, so it never competes with the first screen. */
export const AUTO_CHECK_DELAY_MS = 30_000

interface UpdatesState {
  /** null until something was checked. */
  status: UpdateStatus | null
  checking: boolean
  /** Check once after start. */
  auto: boolean
  check: (force: boolean) => Promise<void>
  setAuto: (on: boolean) => void
  /** The update source changed: what was found no longer holds. */
  forget: () => void
}

function storedAuto(): boolean {
  try {
    return readAutoCheck(localStorage.getItem(AUTO_CHECK_KEY))
  } catch {
    return true
  }
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  status: null,
  checking: false,
  auto: storedAuto(),
  check: async (force) => {
    if (get().checking) return
    set({ checking: true })
    try {
      const status = unwrap<UpdateStatus>(await api.GET('/api/updates/status', { params: { query: { force } } }))
      set({ status, checking: false })
    } catch (error) {
      // the backend itself did not answer: shown like a failed check
      set({ status: { error: (error as Error).message }, checking: false })
    }
  },
  setAuto: (on) => {
    try {
      if (on) localStorage.removeItem(AUTO_CHECK_KEY)
      else localStorage.setItem(AUTO_CHECK_KEY, '0')
    } catch {
      // storage blocked: the choice lasts for this session only
    }
    set({ auto: on })
  },
  forget: () => set({ status: null }),
}))

let scheduled = false

/** Once per page load: check after AUTO_CHECK_DELAY_MS if the switch is on and nothing was checked yet. */
export function scheduleAutoCheck(): void {
  if (scheduled) return
  scheduled = true
  window.setTimeout(() => {
    const s = useUpdates.getState()
    if (s.auto && !s.status && !s.checking) void s.check(false)
  }, AUTO_CHECK_DELAY_MS)
}
