import { create } from 'zustand'
import { parseScaleSetting, scaleFor, UI_SCALE_KEY, type Scale, type ScaleSetting } from '../../lib/uiScale'

// The interface zoom as app state. index.html set it before first paint; this
// store changes it (Settings › Appearance, Ctrl K) and keeps "auto" in step
// with the window as it is resized.

const RESIZE_DEBOUNCE_MS = 150

function readSetting(): ScaleSetting {
  try {
    return parseScaleSetting(localStorage.getItem(UI_SCALE_KEY))
  } catch {
    return 'auto'
  }
}

function apply(scale: Scale): void {
  const root = document.documentElement
  root.style.setProperty('--ui-zoom', String(scale))
  root.style.zoom = scale === 1 ? '' : String(scale)
}

interface UiScaleState {
  setting: ScaleSetting
  /** The zoom in effect. */
  scale: Scale
  /** Window width in screen px (unchanged by the zoom). */
  windowWidth: number
  setSetting: (setting: ScaleSetting) => void
}

const initial = readSetting()

export const useUiScale = create<UiScaleState>((set) => ({
  setting: initial,
  scale: scaleFor(initial, window.innerWidth),
  windowWidth: window.innerWidth,
  setSetting: (setting) => {
    try {
      localStorage.setItem(UI_SCALE_KEY, String(setting))
    } catch {
      // storage blocked: the choice lasts for this session only
    }
    const scale = scaleFor(setting, window.innerWidth)
    apply(scale)
    set({ setting, scale })
  },
}))

let timer: number | undefined
window.addEventListener('resize', () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    const { setting } = useUiScale.getState()
    const scale = scaleFor(setting, window.innerWidth)
    apply(scale)
    useUiScale.setState({ scale, windowWidth: window.innerWidth })
  }, RESIZE_DEBOUNCE_MS)
})
