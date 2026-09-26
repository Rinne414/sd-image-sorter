import { taggerInfo } from '../../tagging/taggers'
import { isModelKey, type ModelKey } from './modelText'
import type { ModelCenterCard } from './types'

// Pure reading of the Model Center cards: their status, the two groups, their
// words in the language packs, which card each feature needs, and the tagger
// card's versions.

export type CardStatus = 'ready' | 'missing' | 'restart'

export function cardStatus(card: ModelCenterCard): CardStatus {
  if (card.status === 'needs_restart') return 'restart'
  if (card.status === 'ready') return 'ready'
  if (card.status) return 'missing'
  return card.available ? 'ready' : 'missing'
}

export interface Summary {
  ready: number
  missing: number
  restart: number
  total: number
}

export function summarize(cards: readonly ModelCenterCard[]): Summary {
  const count = (s: CardStatus) => cards.filter((c) => cardStatus(c) === s).length
  return { ready: count('ready'), missing: count('missing'), restart: count('restart'), total: cards.length }
}

/** Recommended cards first (the essentials), then the rest, each in the backend's order. */
export function groupCards(cards: readonly ModelCenterCard[]): { essentials: ModelCenterCard[]; others: ModelCenterCard[] } {
  return { essentials: cards.filter((c) => c.recommended), others: cards.filter((c) => !c.recommended) }
}

type Say = (key: ModelKey) => string

/** The card's name in the app's language; a card this V4 does not know keeps the backend's name. */
export function nameOf(card: Pick<ModelCenterCard, 'id' | 'name'>, say: Say): string {
  const key = `mc.name.${card.id}`
  return isModelKey(key) ? say(key) : card.name || card.id
}

/** What the card is for, if the packs say. */
export function purposeKey(id: string): ModelKey | null {
  const key = `mc.use.${id}`
  return isModelKey(key) ? key : null
}

/** The label above the card's name (tagging, captions, …) from the backend's group_key. */
export function kindKey(groupKey: string | undefined): ModelKey {
  const key = `mc.kind.${(groupKey ?? '').replace(/^models\.group\./, '')}`
  return isModelKey(key) ? key : 'mc.kind.other'
}

/** The backend's status sentence, translated; null when there is no translation (nothing English is shown in Chinese). */
export function messageKey(card: ModelCenterCard): ModelKey | null {
  if (!card.message_key?.startsWith('models.')) return null
  const key = `mc.msg.${card.message_key.slice('models.'.length)}`
  return isModelKey(key) ? key : null
}

export type ModelFeature = 'tagging' | 'similar' | 'aesthetic' | 'artist' | 'caption' | 'censor' | 'masks'

const FEATURE_CARD: Record<ModelFeature, string> = {
  tagging: 'wd14',
  similar: 'clip',
  aesthetic: 'aesthetic',
  artist: 'artist',
  caption: 'florence2',
  censor: 'censor-nudenet',
  masks: 'lucida',
}

/** The card that "Which one should I pick?" opens for a feature. */
export function cardFor(feature: ModelFeature): string {
  return FEATURE_CARD[feature]
}

const DETECTOR_CARD: Record<string, string> = { nudenet: 'censor-nudenet', both: 'censor-nudenet', legacy: 'censor-legacy', sam3: 'sam3' }

/** The card behind a censor detector choice. */
export function censorCard(detector: string): string {
  return DETECTOR_CARD[detector] ?? 'censor-nudenet'
}

/** The tagger card: the WD14 versions (the version picker) and the other taggers it can fetch. */
export function splitTaggers(card: ModelCenterCard): { family: string[]; others: string[] } {
  const all = card.variants ?? []
  return { family: all.filter((v) => v.startsWith('wd-')), others: all.filter((v) => !v.startsWith('wd-')) }
}

/** The version a card starts on: the recommended default, else the first WD14 one. */
export function preferredVariant(card: ModelCenterCard): string | null {
  const { family } = splitTaggers(card)
  if (!family.length) return null
  return card.default_variant && family.includes(card.default_variant) ? card.default_variant : (family[0] ?? null)
}

// Download sizes: routers/models.py BULK_MODEL_BUNDLE, and the inventory's own
// messages for the cards outside the bundle. The privacy YOLO's size depends on
// the file the user picks on Civitai, so none is claimed.
const SIZE: Record<string, string> = {
  toriigate: '9.6 GB',
  florence2: '465 MB',
  'oppai-oracle': '947 MB',
  'cl-tagger-v2': '2.7 GB',
  clip: '600 MB',
  aesthetic: '1.7 GB',
  artist: '2.8 GB',
  lucida: '885 MB',
  rembg: '170 MB',
  'censor-nudenet': '12 MB',
  sam3: '3.3 GB',
}

/** About how much preparing the card downloads (for the tagger: the chosen version). */
export function sizeHint(card: Pick<ModelCenterCard, 'id'>, variant: string | null): string | null {
  if (card.id === 'wd14' && variant) return taggerInfo(variant).sizeHint
  return SIZE[card.id] ?? null
}

// A model file ends in a word-like extension (.onnx, .pth, .pt, .csv); version
// folders such as kaloscope2.0 or toriigate-0.5 end in digits and stay folders.
const FILE_NAME = /[\\/][^\\/]+\.[A-Za-z][A-Za-z0-9]{0,11}$/

/** The folder to open for a card's path: the path itself, or the folder its model file sits in. */
export function folderOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return FILE_NAME.test(trimmed) ? trimmed.replace(/[\\/][^\\/]+$/, '') : trimmed
}

/** Only web links from the backend's card data become links. */
export function safeUrl(url: string | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null
}
