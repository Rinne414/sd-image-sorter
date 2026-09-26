import type { ProjectSettings } from '../datasetSettings'
import { tagKey } from './captionContent'
import { styledTag, type TagStyle } from './tagStyle'

// The batch's two tag lists, set from the tag frequency list. A tag is on one
// list at a time, as in V3.5's vocabulary panel: putting it on one takes it
// off the other. Both return new settings; the ones passed in stay as they were.

const without = (list: readonly string[], key: string) => list.filter((tag) => tagKey(tag) !== key)

/** The tag into (or out of) the common tags, written in the batch's tag style. */
export function withCommonTag(settings: ProjectSettings, tag: string, add: boolean, style: TagStyle): ProjectSettings {
  const key = tagKey(tag)
  const render = settings.caption_render
  const common = without(render.common_tags, key)
  return {
    ...settings,
    caption_render: {
      ...render,
      common_tags: add ? [...common, styledTag(tag, style)] : common,
      blacklist: add ? without(render.blacklist, key) : render.blacklist,
    },
  }
}

/** The tag onto (or off) the blacklist, as it is written in the captions. */
export function withBlacklistedTag(settings: ProjectSettings, tag: string, add: boolean): ProjectSettings {
  const key = tagKey(tag)
  const render = settings.caption_render
  const blacklist = without(render.blacklist, key)
  return {
    ...settings,
    caption_render: {
      ...render,
      blacklist: add ? [...blacklist, tag] : blacklist,
      common_tags: add ? without(render.common_tags, key) : render.common_tags,
    },
  }
}
