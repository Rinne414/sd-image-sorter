import { useEffect } from 'react'
import { useLibraries } from '../../api/queries'
import { arrivalLibrary } from '../../lib/appSwitch'
import { takeCarriedLibrary } from '../../state/arrival'
import { useApp } from '../../state/store'

/**
 * Open the library V3.5 had open when it sent the user here. Waits for the
 * libraries list; an id it does not hold (or a list that failed) keeps V4's
 * own library, without a word.
 */
export function useLibraryArrival(): void {
  const libraries = useLibraries()
  const settled = libraries.data !== undefined || libraries.isError
  useEffect(() => {
    if (!settled) return
    const carried = takeCarriedLibrary()
    if (carried === null || !libraries.data) return
    const s = useApp.getState()
    const next = arrivalLibrary(carried, libraries.data.libraries.map((l) => l.id), s.libraryId)
    if (next) s.setLibrary(next)
  }, [settled, libraries.data])
}
