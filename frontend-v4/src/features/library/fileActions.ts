import { api, unwrap } from '../../api/client'
import { copyText } from '../../lib/format'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { say, type Msg } from '../selection/actions'

// Reaching the file on disk: open its folder in Explorer/Finder, copy its
// path, open any existing folder (a move or copy destination). Each says
// what went wrong in a toast; nothing here throws.

const toast = (text: string, tone: 'info' | 'error' = 'info') => useToasts.getState().push(text, tone)

/** Show an indexed image in its folder (the file selected on Windows and macOS). */
export async function openImageFolder(id: number): Promise<boolean> {
  try {
    unwrap(await api.POST('/api/open-folder', { body: { image_id: id } }))
    return true
  } catch (error) {
    toast(tr('lib.file.openFailed', { reason: (error as Error).message }), 'error')
    return false
  }
}

/** Open an existing folder by path (POST /api/open-path; not in the generated schema yet). */
export async function openFolderPath(path: string): Promise<boolean> {
  try {
    const res = await fetch('/api/open-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (res.status === 404) {
      toast(tr('lib.file.folderGone', { path }), 'error')
      return false
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { detail?: unknown; message?: unknown } | null
      const reason = typeof body?.detail === 'string' ? body.detail : typeof body?.message === 'string' ? body.message : res.statusText
      toast(tr('lib.file.openFailed', { reason }), 'error')
      return false
    }
    return true
  } catch (error) {
    toast(tr('lib.file.openFailed', { reason: (error as Error).message }), 'error')
    return false
  }
}

/** Copy and say what was copied, since a menu closes before anyone sees a change. */
export async function copyAndSay(value: string, what: Msg): Promise<boolean> {
  const ok = await copyText(value)
  toast(ok ? tr('lib.copy.done', { what: say(tr, what) }) : tr('lib.copy.failed'), ok ? 'info' : 'error')
  return ok
}
