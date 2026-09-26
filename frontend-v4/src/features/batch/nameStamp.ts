import { useEffect, useMemo } from 'react'
import { create } from 'zustand'

// The moment {date} and {time} show as in the name previews: one for every
// preview on screen, so the Name step and the censor step agree, taken again
// each time the Name step opens. The export itself uses the moment it starts
// (or, after a confirmation, the moment that confirmation listed).

const useStamp = create<{ at: number }>(() => ({ at: Date.now() }))

export function useNameStamp(): Date {
  const at = useStamp((s) => s.at)
  return useMemo(() => new Date(at), [at])
}

/** Take the preview moment again while the calling screen opens. */
export function useFreshNameStamp(): Date {
  useEffect(() => useStamp.setState({ at: Date.now() }), [])
  return useNameStamp()
}
