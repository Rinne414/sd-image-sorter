import createClient from 'openapi-fetch'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// The app's stores read the address and storage when they load: a bare page for them (tests run in node).
vi.hoisted(() => {
  const store = new Map<string, string>()
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  }
  const location = { pathname: '/v4/', search: '', hash: '' }
  const window = Object.assign(new EventTarget(), { location })
  Object.assign(globalThis, { window, location, localStorage: fake, sessionStorage: fake })
})

import { translate, useLang } from '../i18n'
import { ApiError, unwrap } from './client'

// The answers go through a real openapi-fetch client (the same parsing the app's
// `api` does), with the server's response made here.
const answer = async (body: BodyInit | null, init: ResponseInit) => {
  const client = createClient<Record<string, never>>({ baseUrl: 'http://127.0.0.1:1', fetch: async () => new Response(body, init) })
  return (client as unknown as { POST: (url: string) => Promise<{ data?: unknown; error?: unknown; response: Response }> }).POST('/api/x')
}

const INCOMPLETE = () => translate('en', 'error.badAnswer')

beforeEach(() => useLang.setState({ lang: 'en' }))

describe('unwrap: a success that carries no answer', () => {
  test('a 200 with an empty body is an incomplete answer, not "nothing" (the caller reads fields from it)', async () => {
    const bare = await answer('', { status: 200 })
    const sized = await answer('', { status: 200, headers: { 'Content-Length': '0' } })
    expect(() => unwrap(bare)).toThrow(INCOMPLETE())
    expect(() => unwrap(sized)).toThrow(INCOMPLETE())
  })

  test('a 200 whose JSON is null is an incomplete answer too', async () => {
    const empty = await answer('null', { status: 200, headers: { 'Content-Type': 'application/json' } })
    expect(() => unwrap(empty)).toThrow(INCOMPLETE())
  })

  test('a 204 No Content stays a legitimate empty answer', async () => {
    expect(unwrap(await answer(null, { status: 204 }))).toBeUndefined()
  })

  test('a normal answer comes back as it is, including falsy JSON values', async () => {
    const json = { 'Content-Type': 'application/json' }
    expect(unwrap(await answer('{"items":[1]}', { status: 200, headers: json }))).toEqual({ items: [1] })
    expect(unwrap(await answer('[]', { status: 200, headers: json }))).toEqual([])
    expect(unwrap(await answer('0', { status: 200, headers: json }))).toBe(0)
    expect(unwrap(await answer('false', { status: 201, headers: json }))).toBe(false)
  })

  test('a refusal is still an ApiError with the server reason', async () => {
    const refused = await answer('{"detail":"busy"}', { status: 409, headers: { 'Content-Type': 'application/json' } })
    expect(() => unwrap(refused)).toThrow(ApiError)
    expect(() => unwrap(refused)).toThrow('busy')
  })
})
