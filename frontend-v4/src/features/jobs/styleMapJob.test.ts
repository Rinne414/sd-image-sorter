import { describe, expect, it } from 'vitest'
import { readProgress } from './progress'

const read = (raw: Record<string, unknown>, prev?: ReturnType<typeof readProgress>) => readProgress('stylemap', raw, {}, prev)

describe('the Style Map index job', () => {
  it('reads a running job with its counts', () => {
    const p = read({ running: true, step: 'extracting', processed: 4, total: 10, written: 3, errors: 1, current_item: 'a.png' })
    expect(p).toMatchObject({ status: 'running', current: 4, total: 10, succeeded: 3, failedCount: 1, currentItem: 'a.png', paused: false })
  })

  it('says it is paused, or loading its model', () => {
    expect(read({ running: true, paused: true, step: 'extracting' })).toMatchObject({ status: 'running', paused: true })
    expect(read({ running: true, paused: true }).currentItem).toBeTruthy()
    expect(read({ running: true, step: 'loading_runtime' }).currentItem).toBeTruthy()
  })

  it('keeps a stop asked for until the backend ends', () => {
    const prev = { ...read({ running: true }), status: 'cancelling' as const }
    expect(read({ running: true }, prev).status).toBe('cancelling')
  })

  it('ends as done, stopped or failed with the reason', () => {
    expect(read({ running: false, step: 'done', written: 7 })).toMatchObject({ status: 'done', succeeded: 7 })
    expect(read({ running: false, step: 'cancelled' }).status).toBe('cancelled')
    expect(read({ running: false, step: 'error', message: 'No model' })).toMatchObject({ status: 'error', message: 'No model' })
    expect(read({ running: false, step: 'idle' }).status).toBe('done')
  })
})
