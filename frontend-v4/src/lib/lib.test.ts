import { describe, expect, test } from 'vitest'
import { parseQuery, toImageParams } from './query'
import { segmentPrompt, promptTagKeys } from './prompt'
import { readGeneration, toParameterText } from './meta'

describe('parseQuery', () => {
  test('free text goes to search, key:value tokens become filters', () => {
    const q = parseQuery('silver hair tag:school_uniform gen:novelai ★4 rating:nsfw')
    expect(q.filter.text).toBe('silver hair')
    expect(q.filter.tags).toEqual(['school_uniform'])
    expect(q.filter.generators).toEqual(['nai'])
    expect(q.filter.minStars).toBe(4)
    expect(q.filter.ratings).toEqual(['questionable', 'explicit'])
    expect(q.warnings).toEqual([])
  })

  test('negated tags, quoted values and chinese keys', () => {
    const q = parseQuery('-tag:"long hair" 标签:smile 星>=3')
    expect(q.filter.excludeTags).toEqual(['long_hair'])
    expect(q.filter.tags).toEqual(['smile'])
    expect(q.filter.minStars).toBe(3)
  })

  test('unknown keys stay in the free text; bad rating warns', () => {
    const q = parseQuery('foo:bar rating:blue')
    expect(q.filter.text).toBe('foo:bar')
    expect(q.warnings).toEqual(['rating:blue'])
  })

  test('stars> is exclusive', () => {
    expect(parseQuery('stars>3').filter.minStars).toBe(4)
  })

  test('params merge the rail scope and drop empty values', () => {
    const q = parseQuery('gen:nai')
    const p = toImageParams(q.filter, { generators: ['comfyui'], folder: 'L:/x', favoritesCollectionId: null }, 'newest')
    expect(p).toEqual({ sort_by: 'newest', generators: 'comfyui,nai', folder: 'L:/x' })
  })
})

describe('segmentPrompt', () => {
  test('a1111 weights and loras', () => {
    const segs = segmentPrompt('1girl, (silver hair:1.2), <lora:foo:0.8>')
    expect(segs.filter((s) => s.kind === 'tag').map((s) => s.key)).toEqual(['1girl', 'silver hair'])
    expect(segs.find((s) => s.kind === 'weight')?.text).toBe(':1.2')
    expect(segs.find((s) => s.kind === 'lora')?.text).toBe('<lora:foo:0.8>')
    expect(segs.map((s) => s.text).join('')).toBe('1girl, (silver hair:1.2), <lora:foo:0.8>')
  })

  test('novelai v4 weights, braces and artist prefixes', () => {
    const src = '-3::artist collaboration::, {{2koma}}, artist:ningen_mame\nBREAK'
    const segs = segmentPrompt(src)
    expect(segs[0]).toEqual({ kind: 'weight', text: '-3::' })
    const tags = segs.filter((s) => s.kind === 'tag')
    expect(tags.map((s) => s.key)).toEqual(['artist collaboration', '2koma', 'ningen mame'])
    expect(tags[2]?.forcedCategory).toBe('artist')
    expect(segs.some((s) => s.kind === 'keyword' && s.text === 'BREAK')).toBe(true)
    expect(segs.map((s) => s.text).join('')).toBe(src)
  })

  test('keys are unique', () => {
    expect(promptTagKeys(segmentPrompt('smile, Smile, smile'))).toEqual(['smile'])
  })
})

describe('readGeneration', () => {
  test('reads normalised params and keeps the rest as extra', () => {
    const g = readGeneration({
      metadata_json: JSON.stringify({
        _parsed: {
          generation_params: { steps: 28, sampler: 'k_euler_ancestral', seed: 3940766012, cfg_scale: 5.0, noise_schedule: 'karras', sm: false },
          character_prompts: [{ index: 0, prompt: 'girl', negative_prompt: 'lowres' }],
        },
      }),
      checkpoint: 'NovelAI Diffusion V4',
      loras: '[]',
      width: 1216,
      height: 832,
    })
    expect(g.seed).toBe('3940766012')
    expect(g.cfg).toBe('5')
    expect(g.scheduler).toBe('karras')
    expect(g.size).toBe('1216×832')
    expect(g.characters).toHaveLength(1)
    expect(g.extra).toEqual([['sm', 'false']])
    expect(toParameterText('a', 'b', g)).toContain('Seed: 3940766012')
  })

  test('survives missing or broken metadata', () => {
    const g = readGeneration({ metadata_json: '{oops', checkpoint: null, loras: 'a, b', width: null, height: null })
    expect(g.seed).toBeNull()
    expect(g.loras).toEqual(['a', 'b'])
  })
})
