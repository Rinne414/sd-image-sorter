import { describe, expect, test } from 'vitest'
import { zhCN } from '../../../i18n/zh-CN'
import { zhCNLibrarySettings } from '../../../i18n/zh-CN.library-settings'
import { enLibrarySettings } from '../../../i18n/en.library-settings'
import { format } from '../../../i18n'
import { readBusy, refusedWorks, worksText } from './clearIndex'
import type { LibKey } from '../libraryText'

const idleScan = { status: 'idle', run_id: 4, source: 'manual' }
const idleTag = { status: 'idle', pipeline_queue: { total_queued: 0, queued: [] } }
const idleScore = { running: false }

describe('readBusy', () => {
  test('nothing running: nothing in the way', () => {
    expect(readBusy(idleScan, idleTag, idleScore)).toEqual([])
    expect(readBusy({ ...idleScan, status: 'done' }, { ...idleTag, status: 'cancelled' }, idleScore)).toEqual([])
  })

  test('an import names its run and source, so it can be stopped', () => {
    expect(readBusy({ status: 'running', run_id: 9, source: 'library_rescan' }, idleTag, idleScore)).toEqual([
      { work: 'scan', runId: 9, source: 'library_rescan' },
    ])
    expect(readBusy({ status: 'starting', run_id: 3, source: 'manual' }, idleTag, idleScore)).toHaveLength(1)
  })

  test('tagging counts while it runs or while work waits in its queue; scoring while it runs', () => {
    expect(readBusy(idleScan, { ...idleTag, status: 'running' }, idleScore)).toEqual([{ work: 'tag' }])
    expect(readBusy(idleScan, { status: 'idle', pipeline_queue: { total_queued: 1, queued: [{}] } }, idleScore)).toEqual([{ work: 'tag' }])
    expect(readBusy(idleScan, idleTag, { running: true })).toEqual([{ work: 'aesthetic' }])
  })

  test('an answer it cannot read is an error, not "idle"', () => {
    expect(() => readBusy({ status: 'weird' }, idleTag, idleScore)).toThrow()
    expect(() => readBusy(idleScan, idleTag, {})).toThrow()
    expect(() => readBusy(null, idleTag, idleScore)).toThrow()
  })
})

describe('refusedWorks', () => {
  test('the backend job names become the work the user knows, once each', () => {
    const body = { code: 'gallery_clear_jobs_active', jobs: ['scan', 'gallery_tag', 'ai_queue', 'aesthetic', 'vlm_caption', 'smart_tag', 'mystery'] }
    expect(refusedWorks(body)).toEqual(['scan', 'tag', 'aesthetic', 'caption', 'smartTag', 'other:mystery'])
    expect(refusedWorks(null)).toEqual([])
  })
})

describe('worksText', () => {
  const t = (pack: Record<LibKey, string>) => (key: LibKey, params?: Record<string, string | number>) => format(pack[key], params)

  test('names the works in both languages', () => {
    expect(worksText(['scan', 'tag'], t(zhCNLibrarySettings))).toBe('导入、打标')
    expect(worksText(['scan', 'other:mystery'], t(enLibrarySettings))).toBe('Importing, Background work (mystery)')
  })

  test('the pack does not reuse a main-pack key', () => {
    const clash = Object.keys(zhCNLibrarySettings).filter((k) => k in zhCN && (zhCN as Record<string, string>)[k] !== (zhCNLibrarySettings as Record<string, string>)[k])
    expect(clash).toEqual([])
  })
})
