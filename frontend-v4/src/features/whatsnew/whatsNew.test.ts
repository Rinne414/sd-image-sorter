import { describe, expect, it } from 'vitest'
import { shouldShowWhatsNew, type WhatsNew } from './whatsNew'

const state = (over: Partial<WhatsNew> = {}): WhatsNew => ({
  available: true,
  version: '9.9.9',
  summary_zh: '摘要',
  summary_en: 'Summary',
  notes_url: 'https://example.invalid/notes',
  updated: false,
  ...over,
})

describe('the what is new notice', () => {
  it('says nothing on a fresh install', () => {
    expect(shouldShowWhatsNew(null, state())).toBe(false)
  })
  it('shows once after the window saw an older version', () => {
    expect(shouldShowWhatsNew('9.9.8', state())).toBe(true)
    expect(shouldShowWhatsNew('9.9.9', state())).toBe(false)
  })
  it('shows when the backend saw an older run, even with nothing remembered here', () => {
    expect(shouldShowWhatsNew(null, state({ updated: true }))).toBe(true)
  })
  it('never shows notes that belong to another version', () => {
    expect(shouldShowWhatsNew('9.9.8', state({ available: false }))).toBe(false)
  })
})
