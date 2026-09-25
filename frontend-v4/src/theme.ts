import { create } from 'zustand'

// Dark ("darkroom") and light ("proof") themes. "system" follows Windows.
// index.html applies the same rule before first paint, so there is no flash.

export type ThemeMode = 'system' | 'dark' | 'light'
export type Theme = 'dark' | 'light'

const KEY = 'sd-v4-theme'
const media = window.matchMedia('(prefers-color-scheme: light)')

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
  } catch {
    // storage blocked
  }
  return 'system'
}

function resolve(mode: ThemeMode): Theme {
  if (mode === 'system') return media.matches ? 'light' : 'dark'
  return mode
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

interface ThemeState {
  mode: ThemeMode
  theme: Theme
  setMode: (mode: ThemeMode) => void
  /** dark -> light -> system -> dark */
  cycle: () => void
}

const initialMode = readMode()

export const useTheme = create<ThemeState>((set, get) => ({
  mode: initialMode,
  theme: resolve(initialMode),
  setMode: (mode) => {
    try {
      localStorage.setItem(KEY, mode)
    } catch {
      // storage blocked: the choice lasts for this session only
    }
    const theme = resolve(mode)
    apply(theme)
    set({ mode, theme })
  },
  cycle: () => {
    const order: ThemeMode[] = ['dark', 'light', 'system']
    const next = order[(order.indexOf(get().mode) + 1) % order.length] ?? 'dark'
    get().setMode(next)
  },
}))

apply(resolve(initialMode))

media.addEventListener('change', () => {
  const { mode } = useTheme.getState()
  if (mode !== 'system') return
  const theme = resolve('system')
  apply(theme)
  useTheme.setState({ theme })
})
