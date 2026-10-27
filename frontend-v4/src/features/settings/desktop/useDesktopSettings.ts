import { useCallback, useEffect, useState } from 'react'
import { desktopShell, type DesktopSettingKey, type DesktopSettings, type SdDesktop } from './shell'

/**
 * The desktop program's own settings (kept by the shell, not by this page).
 * `settings` stays null until the shell has answered; `change` resolves to an
 * error text when the shell refused, null when it took the change.
 */
export function useDesktopSettings(): {
  shell: SdDesktop | null
  settings: DesktopSettings | null
  change: (key: DesktopSettingKey, value: boolean | string) => Promise<string | null>
} {
  const [shell] = useState(() => desktopShell())
  const [settings, setSettings] = useState<DesktopSettings | null>(null)

  useEffect(() => {
    if (!shell) return
    let alive = true
    const read = () => {
      shell
        .getSettings()
        .then((s) => alive && setSettings(s))
        .catch(() => undefined) // the shell answers only the program's own page: nothing to show otherwise
    }
    read()
    window.addEventListener('focus', read)
    return () => {
      alive = false
      window.removeEventListener('focus', read)
    }
  }, [shell])

  const change = useCallback(
    async (key: DesktopSettingKey, value: boolean | string): Promise<string | null> => {
      if (!shell) return null
      try {
        setSettings(await shell.setSetting(key, value))
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    [shell],
  )

  return { shell, settings, change }
}
