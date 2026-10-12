import type { zhCNPixai } from './zh-CN.pixai'

export const enPixai: Record<keyof typeof zhCNPixai, string> = {
  'tagger.note.pixaiV10': 'Newer PixAI: better at characters and series, weak at artist styles; about 5× slower than v0.9 and needs about 7.5 GB of GPU memory',
  'tagging.pixaiPick': 'Best PixAI',
}
