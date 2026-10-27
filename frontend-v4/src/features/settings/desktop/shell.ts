// The desktop program's window talks to the page through window.sdDesktop
// (desktop/src/preload.js). In a plain browser it does not exist and the page
// says so; Quick collect works in both (a small popup in a browser).

export interface DesktopSettings {
  startAtLogin: boolean
  closeToTray: boolean
  shortcut: string
  shortcutOk: boolean
  /** Why the shortcut is not active: 'refused' (another program has it); anything else means not a usable combination. */
  shortcutReason?: string
}

export type DesktopSettingKey = 'startAtLogin' | 'closeToTray' | 'shortcut'

export interface SdDesktop {
  getSettings: () => Promise<DesktopSettings>
  setSetting: (key: DesktopSettingKey, value: boolean | string) => Promise<DesktopSettings>
  openQuickCollect?: () => unknown
}

export const QUICK_COLLECT_URL = '/static/quick-collect.html'
export const COLLECT_CHANNEL = 'sd-image-sorter-collect'

type WithBridge = { sdDesktop?: SdDesktop }

/** The shell's bridge, or null in a plain browser. */
export function desktopShell(win: WithBridge = window as WithBridge): SdDesktop | null {
  const bridge = win.sdDesktop
  return bridge && typeof bridge.getSettings === 'function' && typeof bridge.setSetting === 'function' ? bridge : null
}

/** Quick collect: the shell's own small window, or a popup in a browser. */
export function openQuickCollect(): void {
  const bridge = (window as WithBridge).sdDesktop
  if (bridge?.openQuickCollect) {
    void bridge.openQuickCollect()
    return
  }
  window.open(QUICK_COLLECT_URL, 'sd-quick-collect', 'popup,width=380,height=480')
}
