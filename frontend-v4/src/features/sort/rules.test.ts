import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readProgress } from '../jobs/progress'
import { sortRunKind } from '../jobs/sortRulesJob'
import { cleanRule, conditionParams, isEverything, knownReason, loadRecord, readRun, runBody, saveRecord, type RunRecord } from './rules'
import { cleanSetup } from './savedSetup'

const TOKEN = 'a'.repeat(32)

const progress = (over: Record<string, unknown> = {}) => ({
  status: 'running',
  current: 3,
  total: 10,
  moved: 2,
  errors: 1,
  recent_errors: [{ image_id: 7, filename: '7.png', error: 'Image file not found' }],
  error_items: [{ image_id: 7, filename: '7.png', error: 'Image file not found' }],
  error_items_total: 1,
  run_token: TOKEN,
  run_kind: 'sort',
  operation: 'move',
  message: '',
  ...over,
})

describe('the condition', () => {
  it('is the library search language, without the rail scope', () => {
    expect(conditionParams('tag:1girl gen:nai -tag:sketch', 'newest')).toMatchObject({ tags: '1girl', generators: 'nai', exclude_tags: 'sketch', sort_by: 'newest' })
    expect(conditionParams('', 'newest')).toEqual({ sort_by: 'newest' })
  })

  it('knows when it narrows nothing', () => {
    expect(isEverything('')).toBe(true)
    expect(isEverything('   ')).toBe(true)
    expect(isEverything('tag:1girl')).toBe(false)
    expect(isEverything('sunset')).toBe(false)
  })
})

describe('the run request', () => {
  it('moves exactly the chosen ids, split as asked', () => {
    expect(runBody([3, 1], { query: 'x', destination: 'D:/out', splitBy: 'rating' }, 'copy')).toMatchObject({
      image_ids: [3, 1],
      destination_folder: 'D:/out',
      operation: 'copy',
      split_by: 'rating',
    })
    expect(runBody([1], { query: '', destination: 'D:/out', splitBy: 'none' }, 'move').split_by).toBeNull()
  })

  it('keeps a rule safe in the saved setup and in presets', () => {
    expect(cleanRule({ query: 'tag:a', destination: '  ', splitBy: 'moon' })).toEqual({ query: 'tag:a', destination: null, splitBy: 'none' })
    expect(cleanSetup({ mode: 'rules', rule: { query: 'gen:nai', destination: 'D:/x', splitBy: 'generator' } })).toMatchObject({
      mode: 'rules',
      rule: { query: 'gen:nai', destination: 'D:/x', splitBy: 'generator' },
    })
    expect(cleanSetup({ mode: 'rules' }).rule).toEqual({ query: '', destination: null, splitBy: 'none' })
  })
})

describe('the run as the progress tells it', () => {
  it('reads our run, its failures and its kind', () => {
    const run = readRun(progress(), TOKEN)
    expect(run).toMatchObject({ status: 'running', kind: 'sort', current: 3, total: 10, succeeded: 2, failed: 1 })
    expect(run.failures).toEqual([{ name: '7.png', reason: 'Image file not found' }])
    expect(readRun(progress({ status: 'done', run_kind: 'undo', moved: 9 }), TOKEN)).toMatchObject({ status: 'done', kind: 'undo', succeeded: 9 })
  })

  it('says "lost" when the backend shows another run now', () => {
    expect(readRun(progress({ run_token: 'b'.repeat(32) }), TOKEN).status).toBe('lost')
    expect(readRun(progress({ status: 'idle' }), TOKEN).status).toBe('lost')
    expect(readRun(null, TOKEN).status).toBe('lost')
  })

  it('counts every failure, beyond the ones listed by name', () => {
    expect(readRun(progress({ errors: 1, error_items_total: 350 }), TOKEN).failed).toBe(350)
  })

  it('reads for the Jobs drawer the same way, and ends a job whose run was replaced', () => {
    expect(readProgress('sortrules', progress(), { runToken: TOKEN })).toMatchObject({ status: 'running', succeeded: 2, failedCount: 1 })
    expect(readProgress('sortundo', progress({ run_token: 'c'.repeat(32) }), { runToken: TOKEN }).status).toBe('idle')
    expect(sortRunKind(progress())).toBe('sortrules')
    expect(sortRunKind(progress({ run_kind: 'undo' }))).toBe('sortundo')
    expect(sortRunKind({ status: 'running' })).toBeNull()
  })

  it('words the reasons an undo gives, and passes other reasons through', () => {
    expect(knownReason('It was moved again since; left where it is now')).toEqual({ key: 'movedAgain' })
    expect(knownReason('The copy was changed since; kept')).toEqual({ key: 'copyChanged' })
    expect(knownReason("another file named '3.png' is already in 'src'. Move or rename it, then undo again.")).toEqual({ key: 'occupied', folder: 'src' })
    expect(knownReason('Permission denied')).toBeNull()
  })
})

describe('the last run, remembered per library', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('restores the run of this library only, and forgets it on request', () => {
    const record: RunRecord = { token: TOKEN, operation: 'copy', destination: 'D:/out', splitBy: 'generator', total: 4, phase: 'sort', open: true }
    saveRecord('main', record)
    expect(loadRecord('main')).toEqual(record)
    expect(loadRecord('other')).toBeNull()
    saveRecord('main', null)
    expect(loadRecord('main')).toBeNull()
  })

  it('refuses a record without a proper run token', () => {
    store.set('sd-v4-sort-rules-run:main', JSON.stringify({ token: '../../etc', operation: 'move' }))
    expect(loadRecord('main')).toBeNull()
    store.set('sd-v4-sort-rules-run:main', '{junk')
    expect(loadRecord('main')).toBeNull()
  })
})
