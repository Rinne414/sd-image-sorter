import { describe, expect, it } from 'vitest'
import { imageSources, inspect, isPictureFile, locationName, locationsIn } from './localPicture'

const text = (part: Partial<{ uriList: string; html: string; plain: string }>) => ({ uriList: '', html: '', plain: '', ...part })
const QQ_SRC = 'file://L:\\Tencent Files\\12345\\nt_qq\\nt_data\\Pic\\2026-10\\Ori\\0123abcd.png'

describe('locationsIn', () => {
  it('reads the <img src> QQ puts in HTML', () => {
    expect(locationsIn(text({ html: `<html><body><!--StartFragment--><img src="${QQ_SRC}" /><!--EndFragment--></body></html>` })).paths).toEqual([QQ_SRC])
  })
  it('reads the same tag when it arrives as plain text', () => {
    expect(locationsIn(text({ plain: `<img src="${QQ_SRC}" />` })).paths).toEqual([QQ_SRC])
  })
  it('reads a uri-list, skipping comments and repeats', () => {
    const uri = 'file:///C:/My%20Pictures/a.png'
    expect(locationsIn(text({ uriList: `# dragged\r\n${uri}\r\n${uri}`, plain: uri })).paths).toEqual([uri])
  })
  it('reads plain paths, quoted or not, one per line', () => {
    expect(locationsIn(text({ plain: '"C:\\pics\\a.jpg"\nD:/b.webp\n\\\\nas\\share\\c.png' })).paths).toEqual(['C:\\pics\\a.jpg', 'D:/b.webp', '\\\\nas\\share\\c.png'])
  })
  it('decodes HTML entities in the src', () => {
    expect(imageSources('<img src="file:///C:/a&amp;b.png">')).toEqual(['file:///C:/a&b.png'])
  })
  it('tells a local non-picture and a web address apart from nothing', () => {
    expect(locationsIn(text({ plain: 'C:\\notes\\a.txt' }))).toEqual({ paths: [], otherLocal: true, web: false })
    expect(locationsIn(text({ html: '<img src="https://example.com/a.png">' }))).toEqual({ paths: [], otherLocal: false, web: true })
    expect(locationsIn(text({ plain: 'hello' }))).toEqual({ paths: [], otherLocal: false, web: false })
  })
})

describe('inspect', () => {
  const png = new File(['x'], 'a.png', { type: 'image/png' })
  const typeless = new File(['x'], 'b.PNG', { type: '' })
  const pdf = new File(['x'], 'c.pdf', { type: 'application/pdf' })

  it('keeps picture files, a blank MIME type counting by name', () => {
    expect(inspect([png, typeless, pdf], text({})).files).toEqual([png, typeless])
    expect(isPictureFile(new File(['x'], 'noext', { type: '' }))).toBe(false)
  })
  it('says why nothing is usable', () => {
    expect(inspect([pdf], text({})).reason).toBe('not-picture')
    expect(inspect([], text({ uriList: 'https://example.com/a.png' })).reason).toBe('web-only')
    expect(inspect([], text({})).reason).toBe('empty')
  })
  it('gives both the pasted bitmap and the location (the caller prefers the location)', () => {
    const found = inspect([png], text({ html: `<img src="${QQ_SRC}">` }))
    expect(found.files).toEqual([png])
    expect(found.paths).toEqual([QQ_SRC])
  })
})

describe('locationName', () => {
  it('is the decoded last name of a path or URL', () => {
    expect(locationName(QQ_SRC)).toBe('0123abcd.png')
    expect(locationName('file:///C:/My%20Pictures/%E5%9B%BE.png')).toBe('\u56fe.png')
  })
})
