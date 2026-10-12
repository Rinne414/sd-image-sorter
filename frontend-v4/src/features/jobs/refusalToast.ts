import { translate, useLang } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { restartApp } from '../settings/restart'
import { isStaleLock } from './busyText'

/**
 * An error toast for a refused start. When the AI lock outlived its job
 * (the text says waiting will not help), the toast carries "Restart the app…":
 * the same restart as About's, which asks first and names any running work.
 */
export function pushRefusal(text: string, error: unknown): void {
  const action = isStaleLock(error)
    ? { label: translate(useLang.getState().lang, 'about.support.restart'), run: () => void restartApp() }
    : undefined
  useToasts.getState().push(text, 'error', action)
}
