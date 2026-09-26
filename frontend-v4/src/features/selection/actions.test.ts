import { describe, expect, it, vi } from 'vitest'
import type { BatchSummary, BatchTemplate } from '../../api/types'
import { groupTags } from '../../lib/tagGroups'
import {
  bulkActions,
  bySection,
  cardMenu,
  imageActions,
  menuTarget,
  paletteText,
  runnable,
  say,
  type BulkOps,
  type ImageAction,
  type ImageOps,
} from './actions'

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key

function bulkOps(): BulkOps {
  return { rate: vi.fn(), favorite: vi.fn(), dialog: vi.fn(), censor: vi.fn(), newBatch: vi.fn(), addToBatch: vi.fn(), compare: vi.fn() }
}

function imageOps(): ImageOps {
  return { open: vi.fn(), togglePick: vi.fn(), copy: vi.fn(), openFolder: vi.fn(), findSimilar: vi.fn() }
}

const batch = { id: 7, name: 'Summer', kind: 'pixiv' } as BatchSummary
const template = { id: 3, name: 'Weekly', kind: 'custom' } as BatchTemplate

const ids = (list: readonly ImageAction[]) => list.map((a) => a.id)
const find = (list: readonly ImageAction[], id: string) => {
  const hit = runnable(list).find((a) => a.id === id) ?? list.find((a) => a.id === id)
  if (!hit) throw new Error(`no action ${id}`)
  return hit
}

describe('right-click target', () => {
  it('an unpicked card acts on itself, even when other images are picked', () => {
    expect(menuTarget(5, [])).toEqual({ ids: [5], picks: false })
    expect(menuTarget(5, [1, 2])).toEqual({ ids: [5], picks: false })
  })

  it('a picked card acts on every pick, in pick order', () => {
    expect(menuTarget(2, [3, 2, 9])).toEqual({ ids: [3, 2, 9], picks: true })
  })

  it('the only pick is just that card', () => {
    expect(menuTarget(4, [4])).toEqual({ ids: [4], picks: false })
  })
})

describe('bulk actions', () => {
  it('the selection bar gets batch, rate, favourite, tag and move up front, the rest under More', () => {
    const list = bulkActions({ ids: [1], favorited: false, batches: [], templates: [], ops: bulkOps() })
    expect(ids(list.filter((a) => a.bar === 'main'))).toEqual(['batch', 'rate', 'favorite', 'tag', 'move'])
    expect(ids(list.filter((a) => a.bar === 'more'))).toEqual(['censor', 'copy', 'edit-tags', 'export', 'move-library', 'remove', 'trash'])
  })

  it('every action applies to the ids it was built for', () => {
    const ops = bulkOps()
    const list = bulkActions({ ids: [4, 8], favorited: false, batches: [batch], templates: [template], ops })
    for (const a of runnable(list)) a.run?.()
    expect(ops.dialog).toHaveBeenCalledWith('move', [4, 8])
    expect(ops.dialog).toHaveBeenCalledWith('trash', [4, 8])
    expect(ops.censor).toHaveBeenCalledWith([4, 8])
    expect(ops.favorite).toHaveBeenCalledWith([4, 8], true)
    expect(ops.rate).toHaveBeenCalledWith([4, 8], 5)
    expect(ops.rate).toHaveBeenCalledWith([4, 8], 0)
    expect(ops.newBatch).toHaveBeenCalledWith('pixiv', [4, 8], null)
    expect(ops.newBatch).toHaveBeenCalledWith('custom', [4, 8], template)
    expect(ops.addToBatch).toHaveBeenCalledWith(batch, [4, 8])
    for (const d of ['tag', 'edit-tags', 'export', 'move-library', 'copy', 'remove']) expect(ops.dialog).toHaveBeenCalledWith(d, [4, 8])
  })

  it('compare exists only for exactly two images, and compares those two', () => {
    const ops = bulkOps()
    expect(ids(bulkActions({ ids: [1], favorited: false, batches: [], templates: [], ops }))).not.toContain('compare')
    expect(ids(bulkActions({ ids: [1, 2, 3], favorited: false, batches: [], templates: [], ops }))).not.toContain('compare')
    const two = bulkActions({ ids: [7, 3], favorited: false, batches: [], templates: [], ops })
    const compare = find(two, 'compare')
    expect(compare.bar).toBe('more')
    compare.run?.()
    expect(ops.compare).toHaveBeenCalledWith(7, 3)
    // still before the danger group
    expect(ids(bySection(two)).slice(-2)).toEqual(['remove', 'trash'])
  })

  it('favourite takes them out when every one already is a favourite', () => {
    const ops = bulkOps()
    const fav = find(bulkActions({ ids: [1], favorited: true, batches: [], templates: [], ops }), 'favorite')
    expect(say(t, fav.label)).toBe('card.unfavorite')
    fav.run?.()
    expect(ops.favorite).toHaveBeenCalledWith([1], false)
  })

  it('remove and trash are the danger group, and sorting by section puts them last', () => {
    const list = bulkActions({ ids: [1], favorited: false, batches: [], templates: [], ops: bulkOps() })
    const sorted = bySection(list)
    expect(ids(sorted.slice(-2))).toEqual(['remove', 'trash'])
    expect(sorted.slice(-2).every((a) => a.danger)).toBe(true)
    expect(sorted.slice(0, -2).some((a) => a.danger)).toBe(false)
  })

  it('Ctrl K reads the children with their own wording', () => {
    const list = bulkActions({ ids: [1], favorited: false, batches: [batch], templates: [template], ops: bulkOps() })
    const words = runnable(list).map((a) => paletteText(t, a))
    expect(words).toContain('palette.cmd.picksToNew.pixiv')
    expect(words).toContain('lib.palette.picksToTemplate(name=Weekly)')
    expect(words).toContain('palette.cmd.picksTo(name=Summer)')
    expect(words).toContain('lib.palette.rate(n=3)')
    expect(words).toContain('lib.palette.rateClear')
    expect(words).toContain('palette.cmd.trash')
  })
})

describe('image actions', () => {
  const facts = {
    prompt: '1girl, smile',
    negative: 'lowres',
    tags: ['1girl', 'smile', 'school uniform', 'masterpiece'],
    parameters: '1girl, smile\nNegative prompt: lowres\nSteps: 28',
  }
  const categories: Record<string, 'character' | 'expression' | 'outfit' | 'quality'> = {
    '1girl': 'character',
    smile: 'expression',
    'school uniform': 'outfit',
    masterpiece: 'quality',
  }
  const groups = groupTags(facts.tags, (tag) => categories[tag])

  it('opens, picks, copies each part, opens the folder and copies the path', () => {
    const ops = imageOps()
    const list = imageActions({ id: 9, picked: false, path: 'D:\\out\\a.png', facts, groups, ops })
    expect(ids(list)).toEqual(['open', 'pick', 'similar', 'near', 'copy', 'open-folder'])
    // "Copy" holds each part of the image, then the tag groups under their own heading
    const copyItems = find(list, 'copy').children ?? []
    expect(ids(copyItems.filter((c) => !c.group))).toEqual(['copy-prompt', 'copy-negative', 'copy-tags', 'copy-parameters', 'copy-path'])
    expect(copyItems.find((c) => c.group)?.id).toBe('copy-group-all')
    for (const a of runnable(list)) a.run?.()
    expect(ops.open).toHaveBeenCalledWith(9)
    expect(ops.findSimilar).toHaveBeenCalledWith(9, false)
    expect(ops.findSimilar).toHaveBeenCalledWith(9, true)
    expect(ops.togglePick).toHaveBeenCalledWith(9)
    expect(ops.openFolder).toHaveBeenCalledWith(9)
    expect(ops.copy).toHaveBeenCalledWith('lowres', { key: 'lib.copy.negative' })
    expect(ops.copy).toHaveBeenCalledWith('D:\\out\\a.png', { key: 'lib.file.path' })
    expect(ops.copy).toHaveBeenCalledWith('school uniform', { key: 'lib.copy.group.clothing' })
    expect(ops.copy).toHaveBeenCalledWith('1girl, smile', { key: 'lib.copy.group.appearance' })
  })

  it('by category: every group with its count; empty groups cannot be chosen', () => {
    const list = imageActions({ id: 9, picked: true, path: null, facts, groups, ops: imageOps() })
    const rows = (find(list, 'copy').children ?? []).filter((c) => c.group)
    expect(say(t, rows[0]!.group!)).toBe('lib.copy.byCategory')
    expect(rows[0]).toMatchObject({ id: 'copy-group-all', hint: '4' })
    expect(rows.find((r) => r.id === 'copy-group-appearance')).toMatchObject({ hint: '2', disabled: false })
    expect(rows.find((r) => r.id === 'copy-group-scenery')).toMatchObject({ hint: '0', disabled: true })
    expect(say(t, find(list, 'pick').label)).toBe('lib.menu.unpick')
    expect(paletteText(t, rows.find((r) => r.id === 'copy-group-pose')!)).toBe('lib.palette.copyGroup(group=lib.copy.group.pose)')
  })

  it('while the details load the copy entries wait; missing parts are not offered', () => {
    const loading = imageActions({ id: 9, picked: false, path: null, facts: null, groups: null, ops: imageOps() })
    const waiting = find(loading, 'copy').children ?? []
    expect(ids(waiting)).toEqual(['copy-loading'])
    expect(waiting[0]?.disabled).toBe(true)
    const bare = imageActions({ id: 9, picked: false, path: 'a.png', facts: { prompt: null, negative: null, tags: [], parameters: null }, groups: null, ops: imageOps() })
    expect(ids(find(bare, 'copy').children ?? [])).toEqual(['copy-path'])
  })
})

describe('the right-click menu', () => {
  const single = imageActions({ id: 2, picked: true, path: 'a.png', facts: null, groups: null, ops: imageOps() })

  it('on a pick it offers every selection-bar action, with the danger group separated at the bottom', () => {
    const bulk = bulkActions({ ids: [1, 2, 3], favorited: false, batches: [], templates: [], ops: bulkOps() })
    const plan = cardMenu({ ids: [1, 2, 3], picks: true }, bulk, single, 'a.png')
    expect(say(t, plan.header)).toBe('lib.menu.picks(n=3)')
    const inMenu = plan.groups.flatMap((g) => ids(g.actions))
    for (const a of bulk.filter((x) => x.bar)) expect(inMenu).toContain(a.id)
    const last = plan.groups.at(-1)!
    expect(ids(last.actions)).toEqual(['remove', 'trash'])
    expect(say(t, last.heading!)).toBe('lib.menu.picks(n=3)')
    // the clicked image's own entries have their own heading
    const own = plan.groups.find((g) => g.heading && say(t, g.heading) === 'lib.menu.thisImage')
    expect(ids(own!.actions)).toEqual(['open', 'pick'])
    // finding similar images stays with the clicked image, right under it
    const after = plan.groups[plan.groups.indexOf(own!) + 1]!
    expect(ids(after.actions)).toEqual(['similar', 'near'])
  })

  it('on an unpicked card it names the file and keeps danger last', () => {
    const bulk = bulkActions({ ids: [2], favorited: false, batches: [], templates: [], ops: bulkOps() })
    const plan = cardMenu({ ids: [2], picks: false }, bulk, single, 'a.png')
    expect(say(t, plan.header)).toBe('a.png')
    expect(ids(plan.groups[0]!.actions)).toEqual(['open', 'pick'])
    expect(ids(plan.groups.at(-1)!.actions)).toEqual(['remove', 'trash'])
    expect(plan.groups.slice(0, -1).flatMap((g) => g.actions).some((a) => a.danger)).toBe(false)
  })
})
