import { describe, expect, it } from 'vitest'
import { failureNote, fileProblem, listNote, locateCount, locateEmptyNote, MAX_UPLOAD_BYTES, neighbourDot, neighbourFlags, noVectorNote, placeNote, ringsOf, stepActive } from './lookups'

describe('the nearest pictures', () => {
  it('says why a lookup failed in the user\'s words', () => {
    expect(failureNote(404, '').key).toBe('stylemap.near.errGone')
    expect(failureNote(413, '').key).toBe('stylemap.near.errTooLarge')
    expect(failureNote(409, '').key).toBe('stylemap.near.errBusy')
    expect(failureNote(400, 'Could not read image').key).toBe('stylemap.near.errNotImage')
    expect(failureNote(500, 'boom')).toEqual({ key: 'stylemap.near.err', params: { error: 'boom' }, tone: 'error' })
    expect(failureNote(502, '').params).toEqual({ error: 'HTTP 502' })
  })

  it('refuses a file the server would refuse anyway, before sending it', () => {
    expect(fileProblem({ type: 'text/plain', size: 10 })?.key).toBe('stylemap.near.errNotImage')
    expect(fileProblem({ type: 'image/png', size: MAX_UPLOAD_BYTES + 1 })?.key).toBe('stylemap.near.errTooLarge')
    expect(fileProblem({ type: '', size: 10 })).toBeNull()
    expect(fileProblem({ type: 'image/webp', size: 10 })).toBeNull()
  })

  it('offers the right index for a picture without data', () => {
    expect(noVectorNote('clip')).toMatchObject({ key: 'stylemap.near.noClip', action: 'buildClip' })
    expect(noVectorNote('csd')).toMatchObject({ key: 'stylemap.near.noVector', action: 'build' })
  })

  it('says where a library picture is when it has no dot of its own', () => {
    expect(placeNote({ in_filter: false })).toMatchObject({ key: 'stylemap.near.outsideOne', action: 'showAll' })
    expect(placeNote({ in_filter: true, located: false })?.key).toBe('stylemap.near.unplacedOne')
    expect(placeNote({ in_filter: true, located: true, merged: true })?.key).toBe('stylemap.near.mergedOne')
    expect(placeNote({ in_filter: true, located: true })).toBeNull()
    expect(placeNote(null)).toBeNull()
  })

  it('rings the query point and one ring per dot, far ones dashed', () => {
    const rings = ringsOf({
      status: 'ok',
      query: { x: 0, y: 0, z: 0 },
      neighbors: [
        { id: 1, score: 0.9, located: true, x: 1, y: 1, z: 1 },
        { id: 2, score: 0.9, located: true, merged: true, x: 1, y: 1, z: 1 },
        { id: 3, score: 0.2, located: true, weak: true, x: 2, y: 2, z: 2 },
        { id: 4, score: 0.8, located: false, in_filter: false },
      ],
    })
    expect(rings.map((r) => r.kind)).toEqual(['query', 'near', 'far'])
    expect(ringsOf(null)).toEqual([])
  })

  it('flags each neighbour and finds its dot', () => {
    expect(neighbourFlags({ id: 1, score: 0.1, weak: true, merged: true, in_filter: true, located: true })).toEqual(['stylemap.near.far', 'stylemap.near.merged'])
    expect(neighbourFlags({ id: 1, score: 0.1, in_filter: false })).toEqual(['stylemap.near.outside'])
    expect(neighbourFlags({ id: 1, score: 0.1, in_filter: true, located: false })).toEqual(['stylemap.near.unplaced'])
    expect(neighbourDot({ id: 1, score: 1, located: true, x: 1, y: 2, z: 3 })).toEqual([1, 2, 3])
    expect(neighbourDot({ id: 1, score: 1, located: false })).toBeNull()
  })

  it('explains the list: an estimate for a file, a plain note for a library picture', () => {
    const answer = { status: 'ok', query: { x: 0, y: 0, z: 0 }, neighbors: [{ id: 1, score: 1 }], weak_threshold: 0.3 }
    expect(listNote(answer, false)).toMatchObject({ key: 'stylemap.near.note', params: { threshold: '0.30' } })
    expect(listNote(answer, true).key).toBe('stylemap.near.libraryNote')
    expect(listNote({ ...answer, query: null }, false).key).toBe('stylemap.near.noPlace')
    expect(listNote({ ...answer, neighbors: [] }, false).key).toBe('stylemap.near.nothing')
  })
})

describe('find a picture', () => {
  it('says why nothing was found, in the order the user can act on it', () => {
    expect(locateEmptyNote({ status: 'ok', outside_filter: 3, without_data: 2 })).toMatchObject({ key: 'stylemap.locate.outside', params: { count: 3 }, action: 'showAll' })
    expect(locateEmptyNote({ status: 'ok', without_data: 2 })).toMatchObject({ key: 'stylemap.locate.noData', params: { count: 2 } })
    expect(locateEmptyNote({ status: 'ok' }).key).toBe('stylemap.locate.none')
  })

  it('counts the matches, saying when only the first are shown', () => {
    const results = [{ id: 1, x: 0, y: 0, z: 0 }]
    expect(locateCount({ status: 'ok', results, total: 1 })).toMatchObject({ key: 'stylemap.locate.count', params: { total: 1 } })
    expect(locateCount({ status: 'ok', results, total: 80 })).toMatchObject({ key: 'stylemap.locate.countMore', params: { shown: 1, total: 80 } })
    expect(locateCount({ status: 'ok', results: [] })).toBeNull()
  })

  it('moves the active row around the list', () => {
    expect(stepActive(-1, 1, 3)).toBe(0)
    expect(stepActive(2, 1, 3)).toBe(0)
    expect(stepActive(0, -1, 3)).toBe(2)
    expect(stepActive(0, 1, 0)).toBe(-1)
  })
})
