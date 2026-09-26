import { useEffect } from 'react'
import { useLibraries } from '../../api/queries'
import { translate, useLang } from '../../i18n'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { replacementLibrary } from './missingLibrary'

/**
 * Keep the tab on a library that exists. When the list no longer holds it
 * (deleted in another tab or in V3.5, or a stale id stored at launch), switch
 * to one that does and say so: a request must never name a library that is
 * gone (an import would index images under it). Coming back to the window
 * reads the list again, since another window is where it gets deleted.
 */
export function useLibraryExists(): void {
  const { data, refetch } = useLibraries()

  useEffect(() => {
    const onFocus = () => void refetch()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refetch])

  // Only a new list decides. A switch to a library made a moment ago waits
  // for the list that holds it, and the store's id (not this render's) counts:
  // an arrival from V3.5 may have switched in the same commit.
  useEffect(() => {
    const s = useApp.getState()
    const next = replacementLibrary(s.libraryId, data)
    if (!next || !data) return
    s.setLibrary(next)
    const lang = useLang.getState().lang
    const lib = data.libraries.find((l) => l.id === next)
    const name = lib?.is_default && lib.name === 'Main library' ? translate(lang, 'rail.mainLibrary') : (lib?.name ?? next)
    useToasts.getState().push(translate(lang, 'libraries.gone', { name }), 'info')
  }, [data])
}
