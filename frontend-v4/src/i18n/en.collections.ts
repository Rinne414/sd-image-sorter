import type { zhCNCollections } from './zh-CN.collections'

export const enCollections: Record<keyof typeof zhCNCollections, string> = {
  'collections.folderOnly': 'Images added from a folder are not in the Library, so they cannot go into another batch.',
  'collections.folderLeftOut': 'Left in this batch: {n} images from a folder (not in the Library).',
}
