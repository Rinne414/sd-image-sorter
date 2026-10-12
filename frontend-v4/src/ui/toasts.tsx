import { create } from 'zustand'
import { useT } from '../i18n'
import styles from './toasts.module.css'
import { Icon } from './Icon'

const LIFETIME_MS = 6000
const MAX_TOASTS = 4

type Tone = 'info' | 'error'

interface ToastAction {
  label: string
  run: () => void
}

interface Toast {
  id: number
  text: string
  tone: Tone
  action?: ToastAction
}

interface ToastState {
  toasts: Toast[]
  push: (text: string, tone?: Tone, action?: ToastAction) => void
  dismiss: (id: number) => void
}

let nextId = 1

/** Short messages for things the user did not see happen (a save that failed, a job that ended). */
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (text, tone = 'info', action) => {
    if (get().toasts.some((t) => t.text === text)) return
    const id = nextId++
    const toast: Toast = action ? { id, text, tone, action } : { id, text, tone }
    set({ toasts: [...get().toasts, toast].slice(-MAX_TOASTS) })
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
          <span className={styles.text}>{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                toast.action?.run()
                dismiss(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button type="button" className={styles.close} onClick={() => dismiss(toast.id)} aria-label={t('toast.close')}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
