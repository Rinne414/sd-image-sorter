import { describe, expect, test } from 'vitest'
import { closeTopLayer, isTopLayer, layerCount, pushLayer } from './layers'

describe('layer stack', () => {
  test('Esc closes only the topmost layer, in reverse order of opening', () => {
    const closed: string[] = []
    const lightbox = () => closed.push('lightbox')
    const menu = () => closed.push('menu')
    const removeLightbox = pushLayer(lightbox)
    const removeMenu = pushLayer(menu)

    expect(isTopLayer(menu)).toBe(true)
    expect(isTopLayer(lightbox)).toBe(false)
    expect(closeTopLayer()).toBe(true)
    expect(closed).toEqual(['menu'])

    removeMenu()
    expect(isTopLayer(lightbox)).toBe(true)
    closeTopLayer()
    expect(closed).toEqual(['menu', 'lightbox'])
    removeLightbox()
    expect(layerCount()).toBe(0)
  })

  test('nothing open: Esc is left to the page', () => {
    expect(closeTopLayer()).toBe(false)
  })

  test('removing a layer twice is harmless', () => {
    const remove = pushLayer(() => {})
    remove()
    remove()
    expect(layerCount()).toBe(0)
  })
})
