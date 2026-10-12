import { describe, expect, it } from 'vitest'
import {
  cardFor,
  cardStatus,
  censorCard,
  folderOf,
  groupCards,
  kindKey,
  messageKey,
  nameOf,
  preferredVariant,
  sizeHint,
  splitTaggers,
  summarize,
} from './modelCards'
import type { ModelCenterCard } from './types'

// The fourteen cards GET /api/models/status returns (services/model_service_inventory.py), in its order.
const IDS = [
  'wd14',
  'toriigate',
  'florence2',
  'oppai-oracle',
  'cl-tagger-v2',
  'tipo',
  'clip',
  'aesthetic',
  'artist',
  'lucida',
  'rembg',
  'censor-legacy',
  'censor-nudenet',
  'sam3',
]
const RECOMMENDED = new Set(['wd14', 'censor-nudenet', 'clip', 'aesthetic', 'artist', 'florence2', 'lucida'])

const cards = (overrides: Record<string, Partial<ModelCenterCard>> = {}): ModelCenterCard[] =>
  IDS.map((id) => ({ id, status: 'missing', recommended: RECOMMENDED.has(id), ...overrides[id] }))

describe('card status', () => {
  it('reads ready, missing and needs_restart; a card with no status word falls back to available', () => {
    expect(cardStatus({ id: 'a', status: 'ready' })).toBe('ready')
    expect(cardStatus({ id: 'a', status: 'missing' })).toBe('missing')
    expect(cardStatus({ id: 'a', status: 'needs_restart', available: false })).toBe('restart')
    expect(cardStatus({ id: 'a', available: true })).toBe('ready')
    expect(cardStatus({ id: 'a' })).toBe('missing')
  })

  it('counts ready, not ready and waiting for a restart, out of all cards', () => {
    const list = cards({ wd14: { status: 'ready' }, clip: { status: 'ready' }, sam3: { status: 'needs_restart' } })
    expect(summarize(list)).toEqual({ ready: 2, missing: 11, restart: 1, total: 14 })
  })
})

describe('groups', () => {
  it('puts the recommended cards first, each group in the backend order', () => {
    const { essentials, others } = groupCards(cards())
    expect(essentials.map((c) => c.id)).toEqual(['wd14', 'florence2', 'clip', 'aesthetic', 'artist', 'lucida', 'censor-nudenet'])
    expect(others.map((c) => c.id)).toEqual(['toriigate', 'oppai-oracle', 'cl-tagger-v2', 'tipo', 'rembg', 'censor-legacy', 'sam3'])
  })

  it('names every card and its kind in the language packs, and falls back to the backend name for a new card', () => {
    for (const id of IDS) expect(nameOf({ id }, (k) => k)).toBe(`mc.name.${id}`)
    expect(nameOf({ id: 'brand-new', name: 'Brand New' }, (k) => k)).toBe('Brand New')
    expect(kindKey('models.group.artistId')).toBe('mc.kind.artistId')
    expect(kindKey('models.group.somethingElse')).toBe('mc.kind.other')
    expect(kindKey(undefined)).toBe('mc.kind.other')
  })

  it('translates the backend status sentence when it has a key, and says nothing it cannot translate', () => {
    expect(messageKey({ id: 'wd14', message_key: 'models.wd14.readyCount' })).toBe('mc.msg.wd14.readyCount')
    expect(messageKey({ id: 'sam3', message_key: 'models.sam3.missingDepsCpuTorch' })).toBe('mc.msg.sam3.missingDepsCpuTorch')
    expect(messageKey({ id: 'x', message_key: 'models.unknown.thing' })).toBeNull()
    expect(messageKey({ id: 'x' })).toBeNull()
  })
})

describe('features lead to their card', () => {
  it('maps each feature and each censor detector to a card that exists', () => {
    const known = new Set(IDS)
    for (const feature of ['tagging', 'similar', 'aesthetic', 'artist', 'caption', 'censor', 'masks'] as const) {
      expect(known.has(cardFor(feature)), feature).toBe(true)
    }
    expect(cardFor('tagging')).toBe('wd14')
    expect(censorCard('nudenet')).toBe('censor-nudenet')
    expect(censorCard('both')).toBe('censor-nudenet')
    expect(censorCard('legacy')).toBe('censor-legacy')
    expect(censorCard('sam3')).toBe('sam3')
  })
})

describe('the tagger card', () => {
  const wd14: ModelCenterCard = {
    id: 'wd14',
    variants: ['wd-eva02-large-tagger-v3', 'wd-swinv2-tagger-v3', 'wd-vit-tagger-v3', 'camie-tagger-v2', 'pixai-tagger-v0.9', 'pixai-tagger-v1.0'],
    installed_variants: ['wd-swinv2-tagger-v3', 'pixai-tagger-v1.0'],
    default_variant: 'wd-swinv2-tagger-v3',
  }

  it('lists the WD14 versions in the version picker and the other taggers apart', () => {
    expect(splitTaggers(wd14)).toEqual({
      family: ['wd-eva02-large-tagger-v3', 'wd-swinv2-tagger-v3', 'wd-vit-tagger-v3'],
      others: ['camie-tagger-v2', 'pixai-tagger-v0.9', 'pixai-tagger-v1.0'],
    })
    expect(splitTaggers({ id: 'clip' })).toEqual({ family: [], others: [] })
  })

  it('starts on the recommended version, not the first (heavy) one', () => {
    expect(preferredVariant(wd14)).toBe('wd-swinv2-tagger-v3')
    expect(preferredVariant({ ...wd14, default_variant: 'gone' })).toBe('wd-eva02-large-tagger-v3')
    expect(preferredVariant({ id: 'clip' })).toBeNull()
  })

  it('gives the size of the chosen version, and a fixed size for the other cards', () => {
    expect(sizeHint(wd14, 'wd-eva02-large-tagger-v3')).toBe('1.2 GB')
    expect(sizeHint(wd14, 'pixai-tagger-v1.0')).toBe('2 GB')
    expect(sizeHint({ id: 'artist' }, null)).toBe('2.8 GB')
    expect(sizeHint({ id: 'censor-legacy' }, null)).toBeNull()
  })
})

describe('the folder to open', () => {
  it('is the folder itself, or the folder a model file sits in', () => {
    expect(folderOf('D:\\app\\data\\models\\clip\\Qdrant-clip-ViT-B-32-vision')).toBe('D:\\app\\data\\models\\clip\\Qdrant-clip-ViT-B-32-vision')
    expect(folderOf('D:\\app\\models\\wd14\\wd-swinv2-tagger-v3\\model.onnx')).toBe('D:\\app\\models\\wd14\\wd-swinv2-tagger-v3')
    expect(folderOf('/opt/app/models/aesthetic/sa_0_4_vit_l_14_linear.pth')).toBe('/opt/app/models/aesthetic')
    expect(folderOf('D:/app/models/sam3/facebook-sam3-modelscope/')).toBe('D:/app/models/sam3/facebook-sam3-modelscope')
    expect(folderOf('D:\\app\\data\\models\\artist\\kaloscope2.0')).toBe('D:\\app\\data\\models\\artist\\kaloscope2.0')
    expect(folderOf('D:\\app\\data\\models\\toriigate\\toriigate-0.5')).toBe('D:\\app\\data\\models\\toriigate\\toriigate-0.5')
  })
})
