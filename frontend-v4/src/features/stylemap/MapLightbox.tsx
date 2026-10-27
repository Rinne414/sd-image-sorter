import { create } from 'zustand'
import { rawJson } from '../../api/raw'
import type { ImageSummary } from '../../api/types'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { Lightbox } from '../lightbox/Lightbox'
import { imagesByIds } from '../similar/similarApi'
import { mapQuery } from './mapRequest'
import { mapOnScreen } from './mapStore'
import type { MembersAnswer } from './types'

// A click on a dot opens its picture in the lightbox. A dot that stands for
// several near-identical pictures opens all of them (the strip shows the
// rest), at the dot's own picture.

/** The page's lightbox is the library's; this one belongs to the map. */
export const MAP_LIGHTBOX = 'stylemap'

const useViewing = create<{ images: ImageSummary[] }>(() => ({ images: [] }))

const noop = () => undefined

/** Every picture a dot stands for (just the dot's own when nothing is merged into it). */
async function membersOf(id: number, members: number): Promise<number[]> {
  const map = mapOnScreen()
  if (members <= 1 || !map) return [id]
  try {
    const body = { space: map.scope.space, map_id: map.mapId, rep_ids: [id] }
    const answer = await rawJson<MembersAnswer>('POST', `/api/style-map/members?${mapQuery({ ...map.scope, token: null })}`, { body })
    const ids = answer?.status === 'ok' && answer.ids?.length ? answer.ids : [id]
    return ids.includes(id) ? ids : [id, ...ids]
  } catch {
    return [id]
  }
}

/** Open a dot's picture (and the pictures merged into it) up close. */
export async function openPicture(id: number, members = 1): Promise<void> {
  try {
    const ids = await membersOf(id, members)
    const images = await imagesByIds(ids)
    if (!images.some((img) => img.id === id)) {
      useToasts.getState().push(tr('stylemap.near.errGone'), 'error')
      return
    }
    useViewing.setState({ images })
    useApp.getState().openLightbox(id, MAP_LIGHTBOX)
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
  }
}

export function MapLightbox() {
  const images = useViewing((s) => s.images)
  if (!images.length) return null
  return <Lightbox images={images} total={images.length} hasMore={false} fetchMore={noop} pickable={false} owner={MAP_LIGHTBOX} />
}
