import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_TABS, TOOL_IDS } from '../../lib/route'
import { matches } from './commands'
import { shellCommands, type ShellOps } from './shellCommands'

function ops(): ShellOps {
  return { openTool: vi.fn(), openSettings: vi.fn(), setLang: vi.fn(), setScale: vi.fn(), openHelp: vi.fn() }
}

const find = (query: string, lang: 'zh-CN' | 'en' = 'zh-CN', o = ops()) => shellCommands(lang, o).filter((c) => matches(c, query))

describe('palette: tools, settings, language, zoom and help', () => {
  it('finds every tool and every settings tab in Chinese and in English, whatever the interface language', () => {
    for (const lang of ['zh-CN', 'en'] as const) {
      const list = shellCommands(lang, ops())
      for (const id of TOOL_IDS) expect(list.some((c) => c.id === `tool-${id}`)).toBe(true)
      for (const tab of SETTINGS_TABS) expect(list.some((c) => c.id === `settings-${tab}`)).toBe(true)
    }
    for (const lang of ['zh-CN', 'en'] as const) {
      expect(find('读图', lang).map((c) => c.id)).toContain('tool-reader')
      expect(find('reader', lang).map((c) => c.id)).toContain('tool-reader')
      expect(find('模型中心', lang).map((c) => c.id)).toContain('settings-models')
      expect(find('model center', lang).map((c) => c.id)).toContain('settings-models')
      expect(find('外观', lang).map((c) => c.id)).toContain('settings-appearance')
      expect(find('appearance', lang).map((c) => c.id)).toContain('settings-appearance')
    }
  })

  it('labels are in the interface language', () => {
    const zh = shellCommands('zh-CN', ops()).find((c) => c.id === 'tool-reader')
    const en = shellCommands('en', ops()).find((c) => c.id === 'tool-reader')
    expect(zh?.label).toBe('工具：读图')
    expect(en?.label).toBe('Tools: Reader')
  })

  it('the language command switches to the other language', () => {
    const o = ops()
    find('语言', 'zh-CN', o)[0]?.run()
    expect(o.setLang).toHaveBeenCalledWith('en')
    const o2 = ops()
    find('language', 'en', o2)[0]?.run()
    expect(o2.setLang).toHaveBeenCalledWith('zh-CN')
  })

  it('every zoom choice is there, by percent or "auto" in either language', () => {
    const o = ops()
    find('缩放 130%', 'zh-CN', o)[0]?.run()
    expect(o.setScale).toHaveBeenCalledWith(1.3)
    expect(find('zoom auto', 'zh-CN').map((c) => c.id)).toEqual(['scale-auto'])
    expect(find('缩放 自动', 'en').map((c) => c.id)).toEqual(['scale-auto'])
    expect(shellCommands('en', ops()).filter((c) => c.id.startsWith('scale-')).map((c) => c.label)).toEqual([
      'Interface zoom: Auto',
      'Interface zoom: 100%',
      'Interface zoom: 115%',
      'Interface zoom: 130%',
      'Interface zoom: 140%',
      'Interface zoom: 150%',
    ])
  })

  it('help for each page, found by "help" or "说明"', () => {
    const o = ops()
    const help = find('说明', 'en', o)
    expect(help.map((c) => c.id)).toEqual(['help-library', 'help-batch', 'help-sort', 'help-home', 'help-settings', 'help-tools'])
    find('help organize', 'zh-CN', o)[0]?.run()
    expect(o.openHelp).toHaveBeenCalledWith('sort')
  })

  it('opening a tool and a settings tab calls the right thing', () => {
    const o = ops()
    find('prompt lab', 'zh-CN', o)[0]?.run()
    expect(o.openTool).toHaveBeenCalledWith('promptlab')
    find('磁盘', 'en', o)[0]?.run()
    expect(o.openSettings).toHaveBeenCalledWith('disk')
  })
})
