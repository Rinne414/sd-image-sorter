import { describe, expect, it } from 'vitest'
import { en } from '../../i18n/en'
import { zhCN } from '../../i18n/zh-CN'
import { TOOL_IDS } from '../../lib/route'
import { sendTargets, toolById, TOOLS } from './registry'

const CJK = /[一-鿿]/

describe('toolsRegistry', () => {
  it('lists every tool once, in the menu order', () => {
    expect(TOOLS.map((t) => t.id)).toEqual([...TOOL_IDS])
    for (const id of TOOL_IDS) expect(toolById(id).id).toBe(id)
  })

  it('every tool has a Chinese and an English name and its page', () => {
    for (const tool of TOOLS) {
      expect(zhCN[tool.label], tool.label).toMatch(CJK)
      expect(en[tool.label], tool.label).toBeTruthy()
      expect(en[tool.label], tool.label).not.toMatch(CJK)
      expect(tool.page, tool.id).toBeTruthy()
    }
  })

  it('"send to tool" offers one-image tools only for one image, and never a tool that takes none', () => {
    expect(sendTargets(1).map((t) => t.id)).toEqual(['reader', 'reverse', 'promptlab', 'artist', 'privacy'])
    expect(sendTargets(3).map((t) => t.id)).toEqual(['artist', 'privacy'])
    expect(sendTargets(0)).toEqual([])
  })
})
