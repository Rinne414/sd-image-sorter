import { describe, expect, it } from 'vitest'
import { failureKind, isFinal } from './saveErrors'

const http = (status: number, message = '') => Object.assign(new Error(message), { status })

describe('why a save failed', () => {
  it('too large and refused data are final; the network and server errors are worth retrying', () => {
    expect(failureKind(http(413, 'The picture has 400,000,000 pixels'))).toBe('tooLarge')
    expect(failureKind(http(400, 'The upload is not a readable picture'))).toBe('invalid')
    expect(failureKind(http(422))).toBe('invalid')
    expect(failureKind(http(500, 'Internal server error'))).toBe('server')
    expect(failureKind(new TypeError('Failed to fetch'))).toBe('network')
    expect(failureKind(new Error('?'))).toBe('server')
    expect(isFinal('tooLarge')).toBe(true)
    expect(isFinal('invalid')).toBe(true)
    expect(isFinal('server')).toBe(false)
    expect(isFinal('network')).toBe(false)
  })
})
