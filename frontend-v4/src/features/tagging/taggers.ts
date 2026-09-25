import type { MessageKey } from '../../i18n'

// What V4 says about each tagger. The backend's descriptions are English-only,
// so the notes live in the language packs. Sizes are the first-download sizes
// V3.5's installer quotes; unknown sizes are simply not shown.

export interface TaggerInfo {
  label: string
  note: MessageKey
  /** Model card in /api/models/status and the variant it installs. */
  card: string
  variant: string | null
  sizeHint: string | null
}

const WD = (label: string, note: MessageKey, size: string): TaggerInfo => ({ label, note, card: 'wd14', variant: null, sizeHint: size })

const CATALOG: Record<string, TaggerInfo> = {
  'wd-swinv2-tagger-v3': WD('WD SwinV2 v3', 'tagger.note.swinv2', '446 MB'),
  'wd-eva02-large-tagger-v3': WD('WD EVA02 Large v3', 'tagger.note.eva02', '1.2 GB'),
  'wd-convnext-tagger-v3': WD('WD ConvNeXt v3', 'tagger.note.convnext', '446 MB'),
  'wd-vit-tagger-v3': WD('WD ViT v3', 'tagger.note.vit', '446 MB'),
  'wd-vit-large-tagger-v3': WD('WD ViT Large v3', 'tagger.note.vitLarge', '446 MB'),
  'camie-tagger-v2': { label: 'Camie v2', note: 'tagger.note.camie', card: 'wd14', variant: null, sizeHint: null },
  'pixai-tagger-v0.9': { label: 'PixAI v0.9', note: 'tagger.note.pixai', card: 'wd14', variant: null, sizeHint: null },
  'oppai-oracle-v1.1': { label: 'OppaiOracle v1.1', note: 'tagger.note.oppai', card: 'oppai-oracle', variant: null, sizeHint: '947 MB' },
  'cl-tagger-v2': { label: 'CL Tagger v2', note: 'tagger.note.cl', card: 'cl-tagger-v2', variant: null, sizeHint: '2.7 GB' },
}

/** Captioners, not taggers: the backend refuses them for tag mode. */
const NOT_TAGGERS = new Set(['toriigate-0.5'])

export function isTagger(name: string): boolean {
  return !NOT_TAGGERS.has(name)
}

export function taggerInfo(name: string): TaggerInfo {
  const known = CATALOG[name]
  if (known) return { ...known, variant: known.card === 'wd14' ? name : null }
  return { label: name, note: 'tagger.note.custom', card: 'wd14', variant: name, sizeHint: null }
}

export interface ModelCard {
  id: string
  status?: string
  available?: boolean
  variants?: string[] | null
  installed_variants?: string[] | null
}

/**
 * ready: on disk. download: known to be missing. check: the status cannot tell
 * (the first run checks and downloads if needed). restart: the app must restart first.
 */
export type Readiness = 'ready' | 'download' | 'check' | 'restart'

export function readiness(info: TaggerInfo, cards: ModelCard[] | undefined): Readiness {
  const card = cards?.find((c) => c.id === info.card)
  if (!card) return 'check'
  if (card.status === 'needs_restart') return 'restart'
  if (info.variant) {
    if (card.installed_variants?.includes(info.variant)) return 'ready'
    // The card lists only the variants it knows how to report on.
    return card.variants?.includes(info.variant) ? 'download' : 'check'
  }
  return card.status === 'ready' || card.available === true ? 'ready' : 'download'
}
