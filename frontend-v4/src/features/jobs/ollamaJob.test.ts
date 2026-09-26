import { beforeEach, describe, expect, it } from 'vitest'
import { useLang } from '../../i18n'
import { isFinished, readProgress } from './progress'

// An Ollama model download in the Jobs drawer (GET /api/vlm/local-models/pull/progress).

const MODEL = 'qwen2.5-vl:7b'
const read = (raw: Record<string, unknown>) => readProgress('ollama', raw, { ollamaModel: MODEL })

beforeEach(() => useLang.setState({ lang: 'en' }))

describe('an Ollama download in the drawer', () => {
  it('reads a running pull as a percentage, with the step in words', () => {
    const p = read({ pulling: true, model: MODEL, percent: 45.6, status: 'pulling 6a0746a1ec1a' })
    expect(p).toMatchObject({ status: 'running', current: 46, total: 100, unit: 'percent', currentItem: 'Downloading files' })
  })

  it('names the other steps of a pull', () => {
    const step = (status: string) => read({ pulling: true, model: MODEL, percent: 0, status }).currentItem
    expect(step('starting')).toBe('Starting')
    expect(step('pulling manifest')).toBe('Reading the manifest')
    expect(step('verifying sha256 digest')).toBe('Checking the files')
    expect(step('writing manifest')).toBe('Writing the manifest')
  })

  it('speaks Chinese when the app does', () => {
    useLang.setState({ lang: 'zh-CN' })
    expect(read({ pulling: true, model: MODEL, percent: 3, status: 'pulling abc' }).currentItem).toBe('下载文件')
  })

  it('is done when the pull of our model stopped without an error', () => {
    const p = read({ pulling: false, model: MODEL, percent: 100, status: 'success' })
    expect(p).toMatchObject({ status: 'done', current: 100, total: 100, succeeded: 1 })
    expect(isFinished(p.status)).toBe(true)
  })

  it('reports the error of a failed pull without its prefix', () => {
    expect(read({ pulling: false, model: MODEL, percent: 12, status: 'error: HTTP 404' })).toMatchObject({ status: 'error', message: 'HTTP 404' })
  })

  it('stays within 0-100 whatever the percent says', () => {
    expect(read({ pulling: true, model: MODEL, percent: 140 }).current).toBe(100)
    expect(read({ pulling: true, model: MODEL, percent: -3 }).current).toBe(0)
  })

  it('treats another model (or a restarted app) as our pull being gone', () => {
    expect(read({ pulling: true, model: 'gemma3:4b', percent: 5 }).status).toBe('idle')
    expect(read({ pulling: false, model: '', percent: 0, status: '' }).status).toBe('idle')
  })

  it('reads a pull found running at start-up (no model asked for) as it is', () => {
    expect(readProgress('ollama', { pulling: true, model: 'gemma3:4b', percent: 20, status: 'pulling x' })).toMatchObject({ status: 'running', current: 20 })
  })
})
