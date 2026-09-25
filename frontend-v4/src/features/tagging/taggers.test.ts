import { describe, expect, test } from 'vitest'
import { isTagger, readiness, taggerInfo, type ModelCard } from './taggers'

const cards: ModelCard[] = [
  {
    id: 'wd14',
    status: 'ready',
    available: true,
    variants: ['wd-eva02-large-tagger-v3', 'wd-swinv2-tagger-v3', 'wd-vit-tagger-v3'],
    installed_variants: ['wd-swinv2-tagger-v3'],
  },
  { id: 'oppai-oracle', status: 'missing', available: false },
  { id: 'cl-tagger-v2', status: 'needs_restart', available: false },
]

describe('tagger readiness', () => {
  test('a WD variant is ready only when that variant is installed', () => {
    expect(readiness(taggerInfo('wd-swinv2-tagger-v3'), cards)).toBe('ready')
    expect(readiness(taggerInfo('wd-eva02-large-tagger-v3'), cards)).toBe('download')
  })

  test('a tagger the card cannot report on is checked on first use, not called missing', () => {
    expect(readiness(taggerInfo('camie-tagger-v2'), cards)).toBe('check')
    expect(readiness(taggerInfo('something-custom'), cards)).toBe('check')
  })

  test('own cards: ready, missing, or waiting for a restart', () => {
    expect(readiness(taggerInfo('oppai-oracle-v1.1'), cards)).toBe('download')
    expect(readiness(taggerInfo('cl-tagger-v2'), cards)).toBe('restart')
    expect(readiness(taggerInfo('oppai-oracle-v1.1'), undefined)).toBe('check')
  })

  test('captioners are not offered as taggers', () => {
    expect(isTagger('toriigate-0.5')).toBe(false)
    expect(isTagger('wd-swinv2-tagger-v3')).toBe(true)
  })
})
