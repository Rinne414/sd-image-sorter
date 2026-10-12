import { describe, expect, it } from 'vitest'
import { parseRoute, routeHash, SETTINGS_TABS, TOOL_IDS, type Route } from './route'

describe('settingsRoute', () => {
  it('reads every settings tab and every tool from the address, and writes the same address back', () => {
    for (const tab of SETTINGS_TABS) {
      const route: Route = { page: 'settings', tab }
      expect(routeHash(route)).toBe(`#/settings/${tab}`)
      expect(parseRoute(routeHash(route))).toEqual(route)
    }
    for (const tool of TOOL_IDS) {
      const route: Route = { page: 'tools', tool }
      expect(routeHash(route)).toBe(`#/tools/${tool}`)
      expect(parseRoute(routeHash(route))).toEqual(route)
    }
  })

  it('an unknown or missing settings tab opens Appearance', () => {
    expect(parseRoute('#/settings')).toEqual({ page: 'settings', tab: 'appearance' })
    expect(parseRoute('#/settings/')).toEqual({ page: 'settings', tab: 'appearance' })
    expect(parseRoute('#/settings/nope')).toEqual({ page: 'settings', tab: 'appearance' })
  })

  it('an unknown or missing tool opens the first tool', () => {
    expect(parseRoute('#/tools')).toEqual({ page: 'tools', tool: TOOL_IDS[0] })
    expect(parseRoute('#/tools/nope')).toEqual({ page: 'tools', tool: TOOL_IDS[0] })
  })

  it('keeps the existing pages and batch addresses', () => {
    expect(parseRoute('')).toEqual({ page: 'library', batchId: null })
    expect(parseRoute('#/library')).toEqual({ page: 'library', batchId: null })
    expect(parseRoute('#/home')).toEqual({ page: 'home', batchId: null })
    expect(parseRoute('#/sort')).toEqual({ page: 'sort', batchId: null })
    expect(parseRoute('#/batch')).toEqual({ page: 'batch', batchId: null })
    expect(parseRoute('#/batch/12')).toEqual({ page: 'batch', batchId: 12 })
    expect(parseRoute('#/whatever')).toEqual({ page: 'library', batchId: null })
    expect(routeHash({ page: 'batch', batchId: 12 })).toBe('#/batch/12')
    expect(routeHash({ page: 'batch', batchId: null })).toBe('#/batch')
    expect(routeHash({ page: 'sort', batchId: null })).toBe('#/sort')
  })
})
