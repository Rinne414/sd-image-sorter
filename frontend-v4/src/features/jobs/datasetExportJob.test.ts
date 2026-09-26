import { describe, expect, test } from 'vitest'
import { readProgress } from './progress'

describe('a dataset check and export in the Jobs drawer', () => {
  test('checking: counted, with what it is doing', () => {
    const p = readProgress('dsexport', { status: 'running', phase: 'check', current: 3, total: 40, exported: 0, failed: 0, failures: [], current_item: 'Checking · a.png', message: '' })
    expect(p).toMatchObject({ status: 'running', current: 3, total: 40, succeeded: 0, failedCount: 0, currentItem: 'Checking · a.png' })
  })

  test('done: the pairs written and the ones that failed, by name', () => {
    const p = readProgress('dsexport', {
      status: 'done',
      phase: 'export',
      current: 40,
      total: 40,
      exported: 38,
      failed: 2,
      failures: [{ name: 'b.png', reason: 'failed to copy' }, { name: 'c.png', reason: 'caption render failed' }],
      current_item: null,
      message: '',
    })
    expect(p).toMatchObject({ status: 'done', succeeded: 38, failedCount: 2 })
    expect(p.failures).toEqual([
      { id: null, name: 'b.png', reason: 'failed to copy' },
      { id: null, name: 'c.png', reason: 'caption render failed' },
    ])
  })

  test('stopped by the check: an error that says why', () => {
    const p = readProgress('dsexport', { status: 'error', phase: 'check', current: 40, total: 40, exported: 0, failed: 0, failures: [], current_item: null, message: '3 problems stop the export' })
    expect(p).toMatchObject({ status: 'error', message: '3 problems stop the export' })
  })

  test('a page that no longer runs it (reloaded) reports an error, never a running job', () => {
    expect(readProgress('dsexport', null).status).toBe('error')
  })
})
