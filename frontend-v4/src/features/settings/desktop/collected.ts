import { queryClient } from '../../../api/queryClient'
import { COLLECT_CHANNEL } from './shell'

// Quick collect runs in its own small window. When it adds pictures it says so
// on a BroadcastChannel and every window of the program refreshes its gallery.

/** What a gallery shows after pictures arrive (the same set an import refreshes). */
const ARRIVAL_KEYS = ['images', 'image-count', 'libraries', 'generators', 'folders', 'library-health', 'library-roots']

/** Refresh the gallery when Quick collect adds pictures. Returns the cleanup (the app mounts it once). */
export function listenForCollected(): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined
  const channel = new BroadcastChannel(COLLECT_CHANNEL)
  channel.addEventListener('message', (event: MessageEvent) => {
    if ((event.data as { type?: unknown } | null)?.type !== 'collected') return
    for (const key of ARRIVAL_KEYS) void queryClient.invalidateQueries({ queryKey: [key] })
  })
  return () => channel.close()
}
