import { describe, expect, it } from 'vitest'
import { isSettingKey } from '../../lib/resetSettings'
import {
  canApply,
  customLayout,
  customNotes,
  emptyDefinitions,
  parseStored,
  readDefinitions,
  sanitizeDefinitions,
  storageKey,
  storedText,
  withName,
  withoutAxis,
  withoutPicture,
  withPicked,
  type CustomAnswer,
  type Definitions,
} from './customAxes'

const defined = (patch: Partial<Definitions>): Definitions => ({ ...emptyDefinitions(), ...patch })

describe('my axes, kept per library', () => {
  it('uses the classic page key and format, so both interfaces share the definitions', () => {
    expect(storageKey('main')).toBe('sd-stylemap-custom-axes:main')
    expect(storageKey('')).toBe('sd-stylemap-custom-axes:main')
    const defs = defined({ x: { a: [1, 2], b: [3, 4], nameA: 'thick', nameB: 'flat' } })
    expect(JSON.parse(storedText(defs, true))).toEqual({ v: 1, applied: true, axes: defs })
    expect(parseStored(storedText(defs, true))).toEqual({ defs, applied: true })
  })

  it('are the user\'s work: "Reset all settings" leaves them', () => {
    expect(isSettingKey(storageKey('main'))).toBe(false)
    expect(isSettingKey(storageKey('training-2026'))).toBe(false)
  })

  it('keep only whole positive ids (once) and names of at most 40 characters', () => {
    const defs = sanitizeDefinitions({ x: { a: [1, '2', 2, -3, 1.5, 'x'], b: null, nameA: 'n'.repeat(60), extra: true }, w: { a: [9] } })
    expect(defs.x).toEqual({ a: [1, 2], b: [], nameA: 'n'.repeat(40), nameB: '' })
    expect(defs.y).toEqual({ a: [], b: [], nameA: '', nameB: '' })
  })

  it('read a damaged value as nothing, and "applied" only with an axis that can be applied', () => {
    expect(parseStored('not json')).toEqual({ defs: emptyDefinitions(), applied: false })
    expect(parseStored(null).applied).toBe(false)
    const short = defined({ x: { a: [1], b: [2, 3], nameA: '', nameB: '' } })
    expect(parseStored(storedText(short, true)).applied).toBe(false)
  })
})

describe('what can be applied', () => {
  it('needs two pictures at each end of at least one axis', () => {
    expect(canApply(emptyDefinitions())).toBe(false)
    const defs = defined({ x: { a: [1, 2], b: [3, 4], nameA: ' thick ', nameB: '' }, y: { a: [5], b: [], nameA: '', nameB: '' } })
    const read = readDefinitions(defs)
    expect(read.axes).toEqual({ x: { a: [1, 2], b: [3, 4] } })
    expect(read.names).toEqual({ x: { a: 'thick', b: '' } })
    expect(read.problems).toEqual(['y'])
    expect(canApply(defs)).toBe(true)
  })
})

describe('editing an axis', () => {
  it('a picked picture moves to the end it was added to (one end per picture)', () => {
    const start = defined({ x: { a: [1, 2], b: [3], nameA: '', nameB: '' } })
    const next = withPicked(start, 'x', 'b', [2, 4])
    expect(next.x.a).toEqual([1])
    expect(next.x.b).toEqual([3, 2, 4])
    expect(start.x.a).toEqual([1, 2])
  })

  it('removes a picture, renames an end (cut at 40) and clears an axis', () => {
    const start = defined({ z: { a: [1, 2], b: [3, 4], nameA: '', nameB: '' } })
    expect(withoutPicture(start, 'z', 'a', 1).z.a).toEqual([2])
    expect(withName(start, 'z', 'b', 'x'.repeat(50)).z.nameB).toHaveLength(40)
    expect(withoutAxis(start, 'z').z).toEqual({ a: [], b: [], nameA: '', nameB: '' })
  })
})

describe('the answer on the dots', () => {
  const rows = [
    [10, 0.1, 0.2, 0.3, 1],
    [20, 0.4, 0.5, 0.6, 2],
  ]
  const answer: CustomAnswer = { status: 'ok', ids: [10, 20], coords: [[1, 0, 0], [-1, 0.5, 0]] }

  it('moves every dot and keeps its other columns', () => {
    const layout = customLayout(rows, ['id', 'x', 'y', 'z', 'members'], answer)
    expect(layout?.rows).toEqual([
      [10, 1, 0, 0, 1],
      [20, -1, 0.5, 0, 2],
    ])
  })

  it('finds a lookup\'s moved dot by picture id, or by its server position', () => {
    const layout = customLayout(rows, undefined, answer)!
    expect(layout.remap([9, 9, 9], 20)).toEqual([-1, 0.5, 0])
    expect(layout.remap([0.1, 0.2, 0.3])).toEqual([1, 0, 0])
    // A dropped picture's estimated spot is not a dot of the map.
    expect(layout.remap([0.11, 0.2, 0.3])).toBeNull()
  })

  it('refuses an answer for other points (never half drawn)', () => {
    expect(customLayout(rows, undefined, { ...answer, ids: [10, 21] })).toBeNull()
    expect(customLayout(rows.slice(0, 1), undefined, answer)).toBeNull()
  })
})

describe('what the card says', () => {
  const defs = defined({ x: { a: [1, 2], b: [3, 4], nameA: '', nameB: '' }, y: { a: [5, 6], b: [7, 8], nameA: '', nameB: '' }, z: { a: [9], b: [], nameA: '', nameB: '' } })

  it('working, an error, and a short end', () => {
    expect(customNotes({ status: 'working', error: '', applied: true, result: null, defs }).map((n) => n.key)).toEqual(['stylemap.custom.working', 'stylemap.custom.needTwo'])
    expect(customNotes({ status: 'error', error: 'boom', applied: false, result: null, defs })).toEqual([{ key: 'stylemap.custom.error', params: { error: 'boom' }, tone: 'error' }])
  })

  it('tells the truth about each applied axis and about parallel axes', () => {
    const result: CustomAnswer = {
      status: 'ok',
      axes: {
        x: { applied: true, separable: false, agree: 3, total: 4, missing_ids: [11, 12] },
        y: { applied: false, reason: 'identical_ends' },
        z: null,
      },
      warnings: [{ code: 'axes_parallel', axes: ['x', 'y'], cos: 0.95 }],
    }
    const notes = customNotes({ status: 'ok', error: '', applied: true, result, defs })
    expect(notes.map((n) => [n.key, n.axis ?? n.pair?.join('') ?? ''])).toEqual([
      ['stylemap.custom.needTwo', ''],
      ['stylemap.custom.applied', ''],
      ['stylemap.custom.notSeparable', 'x'],
      ['stylemap.custom.missing', 'x'],
      ['stylemap.custom.identical', 'y'],
      ['stylemap.custom.parallel', 'xy'],
      ['stylemap.custom.hidden', ''],
    ])
    expect(notes.find((n) => n.key === 'stylemap.custom.notSeparable')?.params).toEqual({ agree: 3, total: 4 })
    expect(notes.find((n) => n.key === 'stylemap.custom.missing')?.params).toEqual({ n: 2 })
  })
})
