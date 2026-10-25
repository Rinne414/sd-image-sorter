import { describe, expect, test } from 'vitest'
import { useLang } from '../../i18n'
import { jobHeadline } from './headline'
import type { Job } from './jobs'
import { readProgress } from './progress'
import { refusalOfProgress, taggerRefusal } from './taggerRefusal'

// The tagger refuses to run on the CPU without enough free memory (PixAI v1.0
// needs about 6 GB); the job line says why in the UI language, with the
// numbers, instead of the backend's English sentence.

const ARGS = { code: 'tagger_cpu_memory_short_gpu_busy', model: 'pixai-tagger-v1.0', need_gb: '6', free_gb: '3.1' }
const stopped = { status: 'error', run_id: 5, current: 0, total: 40, tagged: 0, errors: 0, message: 'English sentence', message_key: 'cpu_memory_short', message_args: ARGS }

const job = (kind: 'tag' | 'smarttag', raw: Record<string, unknown>): Job => ({
  id: `${kind}-1`, kind, count: 40, destination: null, ids: [], adopted: false, pollErrors: 0, ctx: {}, label: null,
  progress: readProgress(kind, raw, kind === 'tag' ? { baseRunId: 4 } : {}),
})

describe('the tagger refusal', () => {
  test('is read from a tag run and said with its numbers in both languages', () => {
    useLang.setState({ lang: 'zh-CN' })
    const zh = jobHeadline(job('tag', stopped))
    expect(zh).toContain('已停下：另一个程序占着 pixai-tagger-v1.0 需要的显存')
    expect(zh).toContain('约 6 GB')
    expect(zh).toContain('只有 3.1 GB')
    expect(zh).not.toContain('English sentence')

    useLang.setState({ lang: 'en' })
    const en = jobHeadline(job('tag', stopped))
    expect(en).toMatch(/^Stopped: Another program is using the GPU memory pixai-tagger-v1\.0 needs/)
    expect(en).toContain('about 6 GB of free memory; 3.1 GB is free')
  })

  test('is read from a failed Smart Tag run too', () => {
    useLang.setState({ lang: 'en' })
    const raw = { status: 'failed', job_id: 'j1', processed: 0, total: 40, succeeded: 0, failed: 0, message: 'English sentence', message_key: 'cpu_memory_short', message_args: { ...ARGS, code: 'tagger_cpu_memory_short_gpu_stopped' } }
    expect(jobHeadline(job('smarttag', raw))).toContain('The pictures tagged so far are kept.')
  })

  test('any other error keeps the backend sentence', () => {
    useLang.setState({ lang: 'en' })
    const other = { ...stopped, message_key: 'error', message: 'Error: disk full' }
    expect(jobHeadline(job('tag', other))).toBe('Stopped by an error: Error: disk full')
    expect(refusalOfProgress({ message_key: 'cpu_memory_short', message_args: { code: 'tagger_new_cause' } })).toBeNull()
    expect(taggerRefusal('collect_site_refused', {})).toBeNull()
  })
})
