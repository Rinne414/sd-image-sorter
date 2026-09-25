import { create } from 'zustand'
import { useT } from '../i18n'
import styles from './toasts.module.css'

const LIFETIME_MS = 6000
const MAX_TOASTS = 4

type Tone = 'info' | 'error'

interface Toast {
  id: number
  text: string
  tone: Tone
}

interface ToastState {
  toasts: Toast[]
  push: (text: string, tone?: Tone) => void
  dismiss: (id: number) => void
}

let nextId = 1

/** Short messages for things the user did not see happen (a save that failed, a job that ended). */
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (text, tone = 'info') => {
    if (get().toasts.some((t) => t.text === text)) return
    const id = nextId++
    set({ toasts: [...get().toasts, { id, text, tone }].slice(-MAX_TOASTS) })
    window.setTimeout(() => get().dismiss(id), LIFETIME_MS)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export function Toasts() {
  const t = useT()
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  if (!toasts.length) return null
  return (
    <div className={styles.stack} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={styles.toast} data-tone={toast.tone}>
          <span>{toast.text}</span>
          <button type="button" className={styles.close} onClick={() => dismiss(toast.id)} aria-label={t('toast.close')}>
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
