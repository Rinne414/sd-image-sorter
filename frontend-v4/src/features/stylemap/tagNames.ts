import type { MessageKey } from '../../i18n'
import { zhCNStyleMap } from '../../i18n/zh-CN.stylemap'

// A style tag as the axes and landmarks name it: the curated name of the
// language packs (every tag of the backend's style list has one), else the
// English tag with underscores read as spaces.

const PREFIX = 'stylemap.tag.'

export function tagKey(tag: string): MessageKey | null {
  const key = `${PREFIX}${tag}`
  return key in zhCNStyleMap ? (key as MessageKey) : null
}

export const plainTag = (tag: string): string => tag.replace(/_\(medium\)$/, '').replace(/_/g, ' ')

export function tagName(t: (key: MessageKey) => string, tag: string): string {
  const key = tagKey(tag)
  return key ? t(key) : plainTag(tag)
}
