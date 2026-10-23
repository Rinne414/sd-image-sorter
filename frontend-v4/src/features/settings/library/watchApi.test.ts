import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryClient } from '../../../api/queryClient'
import { useToasts } from '../../../ui/toasts'
import type { LibraryRoot } from './types'
import { setRootWatch, startFolderWatch, useFolderWatch } from './watchApi'

const root: LibraryRoot = { id: 4, path: 'D:/ComfyUI/output', image_count: 10, exists: true, last_scanned_at: null, watch: 0 }

type Call = { url: string; method: string; body: unknown }

function stubServer(answers: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined })
    const answer = answers.shift() ?? { status: 200, body: { paused: false, generation: 0, roots: [] } }
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  })
  return calls
}

describe('folder watching from Vopus and /next/', () => {
  const timers: Array<() => void> = []
  beforeEach(() => {
    vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void) => timers.push(fn),
      clearTimeout: vi.fn(),
    })
    useToasts.setState({ toasts: [] } as never)
    useFolderWatch.setState({ status: null })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    timers.length = 0
  })

  it('turns watching on for one folder and says so', async () => {
    const calls = stubServer([{ status: 200, body: { ...root, watch: 1 } }])
    expect(await setRootWatch(root, true)).toBe(true)
    expect(calls[0]).toEqual({ url: '/api/library-roots/4/watch', method: 'PATCH', body: { watch: true } })
    expect(calls[1]?.url).toBe('/api/watch/status')
    const toasts = useToasts.getState().toasts as Array<{ message?: string; text?: string }>
    expect(JSON.stringify(toasts)).toContain('output')
  })

  it('a refused switch reports the reason and changes nothing', async () => {
    stubServer([{ status: 404, body: { detail: { code: 'library_root_not_found', message: 'Library folder not found' } } }])
    expect(await setRootWatch(root, true)).toBe(false)
    expect(JSON.stringify(useToasts.getState().toasts)).toContain('Library folder not found')
  })

  it('refreshes the gallery when watched folders bring new pictures, not on the first look', async () => {
    const watched = { root_id: 4, path: root.path, mode: 'native', state: 'watching', error: null, imported: 0, last_import_at: null }
    stubServer([
      { status: 200, body: { paused: false, generation: 2, roots: [watched] } },
      { status: 200, body: { paused: false, generation: 2, roots: [watched] } },
      { status: 200, body: { paused: false, generation: 3, roots: [{ ...watched, imported: 1 }] } },
    ])
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()
    const stop = startFolderWatch()
    await vi.waitFor(() => expect(useFolderWatch.getState().status?.generation).toBe(2))
    timers.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(invalidate).not.toHaveBeenCalled()
    timers.shift()?.()
    await vi.waitFor(() => expect(useFolderWatch.getState().status?.generation).toBe(3))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['images'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['library-roots'] })
    stop()
    invalidate.mockRestore()
  })
})
