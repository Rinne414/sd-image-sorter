import { describe, expect, it, vi } from 'vitest'
import { freshAddress, hardRefresh, type RefreshEnv } from './hardRefresh'

function env(over: Partial<RefreshEnv> = {}): RefreshEnv & { replace: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> } {
  return { href: 'http://127.0.0.1:8487/vopus/#/settings/about', now: () => 1234, replace: vi.fn(), reload: vi.fn(), ...over } as never
}

describe('freshAddress', () => {
  it('adds a new _t and keeps the page and the route', () => {
    expect(freshAddress('http://127.0.0.1:8487/vopus/#/settings/about', 99)).toBe('http://127.0.0.1:8487/vopus/?_t=99#/settings/about')
  })
  it('replaces an older _t and keeps other query values', () => {
    expect(freshAddress('http://h/vopus/?a=1&_t=5#/library', 7)).toBe('http://h/vopus/?a=1&_t=7#/library')
  })
})

describe('hardRefresh', () => {
  it('deletes every cache, unregisters every worker, then loads the new address', async () => {
    const deleted: string[] = []
    const unregister = vi.fn(async () => true)
    const e = env({
      caches: { keys: async () => ['a', 'b'], delete: async (k) => (deleted.push(k), true) },
      serviceWorker: { getRegistrations: async () => [{ unregister }, { unregister }] },
    })
    await hardRefresh(e)
    expect(deleted).toEqual(['a', 'b'])
    expect(unregister).toHaveBeenCalledTimes(2)
    expect(e.replace).toHaveBeenCalledWith('http://127.0.0.1:8487/vopus/?_t=1234#/settings/about')
    expect(e.reload).not.toHaveBeenCalled()
  })
  it('still reloads when the browser refuses cache access', async () => {
    const e = env({
      caches: { keys: async () => Promise.reject(new Error('denied')), delete: async () => true },
      serviceWorker: { getRegistrations: async () => Promise.reject(new Error('denied')) },
    })
    await hardRefresh(e)
    expect(e.replace).toHaveBeenCalledTimes(1)
  })
  it('falls back to a plain reload when the address cannot be replaced', async () => {
    const e = env({ replace: vi.fn(() => { throw new Error('no') }) })
    await hardRefresh(e)
    expect(e.reload).toHaveBeenCalledTimes(1)
  })
})
