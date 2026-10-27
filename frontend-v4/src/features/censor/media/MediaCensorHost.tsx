import { lazy, Suspense, useEffect, useState } from 'react'
import { useMediaDialog } from './mediaStore'

// Mounted once in each shell. Nothing of the dialog is loaded until it is
// first opened; after that it stays mounted, so the "download the model
// first?" question it may leave behind still gets shown.

const Loaded = lazy(() => import('./MediaCensorDialog'))

export function MediaCensorHost() {
  const open = useMediaDialog((s) => s.open)
  const [wanted, setWanted] = useState(false)
  useEffect(() => {
    if (open) setWanted(true)
  }, [open])
  return wanted ? (
    <Suspense fallback={null}>
      <Loaded />
    </Suspense>
  ) : null
}
