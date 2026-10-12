import { describe, expect, test } from 'vitest'
import { isFinished, readProgress } from './progress'

describe('character purity in the drawer', () => {
  test('the model download counts bytes while it runs, and is done once the files are there', () => {
    const running = readProgress('purityget', { available: false, preparing: true, download: { active: true, filename: 'ccip.onnx', downloaded: 50, total: 200 } })
    expect(running).toMatchObject({ status: 'running', unit: 'bytes', current: 50, total: 200, currentItem: 'ccip.onnx' })
    expect(readProgress('purityget', { available: true, preparing: false, download: { active: false } }).status).toBe('done')
  })

  test('a failed download says why; a download that ended without the files is not success', () => {
    expect(readProgress('purityget', { available: false, preparing: false, prepare_error: 'no network', download: {} })).toMatchObject({ status: 'error', message: 'no network' })
    const ended = readProgress('purityget', { available: false, preparing: false, prepare_error: null, missing_files: ['a.onnx'], download: {} })
    expect(ended).toMatchObject({ status: 'error', message: 'a.onnx' })
  })

  test('the analysis: starting is running; images read and ones that failed are counted', () => {
    const p = readProgress('purity', { job_id: 'j1', status: 'starting', current: 0, total: 8, extracted: 0, failed: 0 }, { purityJobId: 'j1' })
    expect(p).toMatchObject({ status: 'running', total: 8 })
    const done = readProgress('purity', { job_id: 'j1', status: 'done', current: 8, total: 8, extracted: 7, failed: 1 }, { purityJobId: 'j1' })
    expect(done).toMatchObject({ status: 'done', succeeded: 7, failedCount: 1 })
    expect(isFinished(done.status)).toBe(true)
  })

  test('another run in its place, or an error, is not success', () => {
    expect(readProgress('purity', { job_id: 'other', status: 'running' }, { purityJobId: 'j1' }).status).toBe('error')
    expect(readProgress('purity', { job_id: 'j1', status: 'error', message: 'onnx failed' }, { purityJobId: 'j1' })).toMatchObject({ status: 'error', message: 'onnx failed' })
    expect(readProgress('purity', { job_id: 'j1', status: 'cancelled' }, { purityJobId: 'j1' }).status).toBe('cancelled')
  })
})
