import { describe, expect, it } from 'vitest'
import { convertPrompt, detectFormat, formatWeight, naiToSd, sdToNai } from './promptFormat'

describe('detectFormat', () => {
  it('trusts the generator first', () => {
    expect(detectFormat({ generator: 'nai', text: '(a:1.2)' })).toBe('nai')
    expect(detectFormat({ generator: 'comfyui', text: '1.2::a::' })).toBe('sd')
    expect(detectFormat({ generator: 'forge', text: '' })).toBe('sd')
  })

  it('reads the syntax when the generator says nothing', () => {
    expect(detectFormat({ generator: 'unknown', text: 'a, 1.3::b::' })).toBe('nai')
    expect(detectFormat({ generator: null, text: 'a, {b}' })).toBe('nai')
    expect(detectFormat({ generator: null, text: 'a <lora:x:0.5>' })).toBe('sd')
    expect(detectFormat({ generator: null, text: '(a:1.1), b' })).toBe('sd')
    expect(detectFormat({ generator: null, text: 'a, b' })).toBe('unknown')
    expect(detectFormat({ generator: null, text: 'a', hasCharacters: true })).toBe('nai')
  })
})

describe('conversion', () => {
  it('writes weights with at most three decimals', () => {
    expect(formatWeight(1.1025)).toBe('1.103')
    expect(formatWeight('1.20')).toBe('1.2')
    expect(formatWeight('x')).toBe('')
  })

  it('turns NovelAI weights and brackets into SD weights', () => {
    expect(naiToSd('1girl, 1.2::silver hair::, {smile}')).toBe('1girl, (silver hair:1.2), (smile:1.05)')
    expect(naiToSd('[[blurry]]')).toBe('(blurry:0.907)')
  })

  it('turns SD weights, brackets and LoRA tags into NovelAI weights', () => {
    expect(sdToNai('1girl, (silver hair:1.2), ((smile))')).toBe('1girl, 1.2::silver hair::, 1.21::smile::')
    expect(sdToNai('a <lora:style:0.8>')).toBe('a 0.8::style::')
  })

  it('leaves text alone for the original view, the same syntax, or an unknown source', () => {
    expect(convertPrompt('(a:1.2)', 'sd', 'original')).toBe('(a:1.2)')
    expect(convertPrompt('(a:1.2)', 'sd', 'sd')).toBe('(a:1.2)')
    expect(convertPrompt('a, b', 'unknown', 'nai')).toBe('a, b')
    expect(convertPrompt('(a:1.2)', 'sd', 'nai')).toBe('1.2::a::')
    expect(convertPrompt('1.2::a::', 'nai', 'sd')).toBe('(a:1.2)')
  })
})
