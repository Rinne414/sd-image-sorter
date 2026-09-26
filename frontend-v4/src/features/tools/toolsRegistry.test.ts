import { describe, expect, it } from 'vitest'
import { en } from '../../i18n/en'
import { zhCN } from '../../i18n/zh-CN'
import { TOOL_IDS } from '../../lib/route'
import { sendTargets, toolById, TOOLS, type ToolEntry } from './registry'

const CJK = /[一-鿿]/

describe('toolsRegistry', () => {
  it('lists every tool once, in the menu order', () => {
    expect(TOOLS.map((t) => t.id)).toEqual([...TOOL_IDS])
    for (const id of TOOL_IDS) expect(toolById(id).id).toBe(id)
  })

  it('every tool has a Chinese and an English name and one line of what it does', () => {
    for (const tool of TOOLS) {
      for (const key of [tool.label, tool.what]) {
        expect(zhCN[key], key).toMatch(CJK)
        expect(en[key], key).toBeTruthy()
        expect(en[key], key).not.toMatch(CJK)
      }
    }
  })

  it('a ready tool has its page; one still being built has none', () => {
    for (const tool of TOOLS) expect(!!tool.page, tool.id).toBe(tool.ready)
  })

  it('"send to tool" offers only built tools, and one-image tools only for one image', () => {
    const tools: ToolEntry[] = [
      { id: 'reader', label: 'tools.reader', what: 'tools.reader.what', accepts: 'one', ready: true },
      { id: 'reverse', label: 'tools.reverse', what: 'tools.reverse.what', accepts: 'one', ready: false },
      { id: 'artist', label: 'tools.artist', what: 'tools.artist.what', accepts: 'many', ready: true },
      { id: 'lexicon', label: 'tools.lexicon', what: 'tools.lexicon.what', accepts: null, ready: true },
      { id: 'privacy', label: 'tools.privacy', what: 'tools.privacy.what', accepts: 'many', ready: false },
    ]
    expect(sendTargets(1, tools).map((t) => t.id)).toEqual(['reader', 'artist'])
    expect(sendTargets(3, tools).map((t) => t.id)).toEqual(['artist'])
    expect(sendTargets(0, tools)).toEqual([])
  })

  it('today no tool is built in V4 yet, so nothing is offered', () => {
    expect(sendTargets(1)).toEqual(TOOLS.filter((t) => t.ready && t.accepts !== null))
  })
})
