import { describe, expect, it } from 'vitest'
import { panelPlace } from './filterPanelPlace'

const button = (left: number, bottom: number) => ({ left, right: left + 60, bottom })

describe('where the filter panel opens: under its button, on screen', () => {
  it('starts at the button when there is room', () => {
    expect(panelPlace(button(300, 86), { width: 1920, height: 1080 })).toEqual({ left: 300, top: 92, width: 720, maxHeight: 620 })
  })

  it('moves left to stay on screen, and narrows on a small window', () => {
    expect(panelPlace(button(900, 86), { width: 1366, height: 768 }).left).toBe(1366 - 12 - 720)
    const small = panelPlace(button(40, 86), { width: 600, height: 400 })
    expect(small).toMatchObject({ left: 12, width: 576 })
    expect(small.maxHeight).toBe(400 - 92 - 12)
  })
})
