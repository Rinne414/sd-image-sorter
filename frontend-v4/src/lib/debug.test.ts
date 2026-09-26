import { describe, expect, test } from 'vitest'
import { debugMiddleware, readDebug } from './debug'

type Params = Parameters<NonNullable<ReturnType<typeof debugMiddleware>['onRequest']>>[0]

const call = (id: string, method: string, url: string) => ({ id, request: new Request(url, { method }) }) as unknown as Params

function setup(on: boolean) {
  const lines: unknown[][] = []
  let now = 1_000
  const mw = debugMiddleware({ isOn: () => on, log: (...args) => lines.push(args), now: () => now })
  return { mw, lines, advance: (ms: number) => (now += ms) }
}

describe('debug log', () => {
  test('stored "1" turns it on; anything else is off', () => {
    expect(readDebug('1')).toBe(true)
    expect(readDebug(null)).toBe(false)
    expect(readDebug('true')).toBe(false)
  })

  test('on: each request is written with its method, path, status and time', async () => {
    const { mw, lines, advance } = setup(true)
    const req = call('r1', 'POST', 'http://127.0.0.1:8521/api/updates/channel/proxy?x=1')
    await mw.onRequest!(req)
    advance(37)
    await mw.onResponse!({ ...req, response: new Response('{}', { status: 400 }) })
    expect(lines).toEqual([['[sd-v4] POST /api/updates/channel/proxy?x=1 → 400 · 37 ms']])
  })

  test('on: a request that never got an answer is written too', async () => {
    const { mw, lines, advance } = setup(true)
    const req = call('r2', 'GET', 'http://127.0.0.1:8521/api/stats')
    await mw.onRequest!(req)
    advance(5)
    const error = new TypeError('Failed to fetch')
    await mw.onError!({ ...req, error })
    expect(lines).toEqual([['[sd-v4] GET /api/stats failed · 5 ms', error]])
  })

  test('off: nothing is written and requests pass untouched', async () => {
    const { mw, lines } = setup(false)
    const req = call('r3', 'GET', 'http://127.0.0.1:8521/api/stats')
    expect(await mw.onRequest!(req)).toBeUndefined()
    expect(await mw.onResponse!({ ...req, response: new Response('{}') })).toBeUndefined()
    expect(lines).toEqual([])
  })
})
