import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT, exportBody, namesBody } from './exportSettings'
import { stampTemplate, TEMPLATE_TOKENS } from './names'

// {date} and {time} as V3.5's rename had them: YYYYMMDD and HHMMSS, the
// moment the names are made (V4: the export), not the file's own date.

describe('date and time tokens', () => {
  const when = new Date(2026, 8, 7, 4, 5, 6)

  it('writes the date as YYYYMMDD and the time as HHMMSS, in local time', () => {
    expect(stampTemplate('p_{date}_{time}', when)).toBe('p_20260907_040506')
  })

  it('uses the local calendar day just after midnight (not the UTC one)', () => {
    expect(stampTemplate('{date}', new Date(2026, 8, 27, 0, 30, 0))).toBe('20260927')
    expect(stampTemplate('{time}', new Date(2026, 8, 27, 23, 59, 59))).toBe('235959')
  })

  it('fills every use and leaves the other tokens to the server', () => {
    expect(stampTemplate('{batch}-{date}-{n:03}-{date}{original}', when)).toBe('{batch}-20260907-{n:03}-20260907{original}')
  })

  it('leaves look-alike or broken tokens alone, so the server still names them', () => {
    expect(stampTemplate('{dates}_{Date}_{date_}_{time', when)).toBe('{dates}_{Date}_{date_}_{time')
  })

  it('returns a template without them unchanged', () => {
    expect(stampTemplate('{batch}_{n:02}', when)).toBe('{batch}_{n:02}')
  })

  it('offers both next to the template input', () => {
    expect(TEMPLATE_TOKENS).toContain('{date}')
    expect(TEMPLATE_TOKENS).toContain('{time}')
  })

  it('sends the stamped template in the names preview and in the export', () => {
    const settings = { ...DEFAULT_EXPORT, name_template: '{batch}_{date}_{time}_{n:02}' }
    expect(namesBody(settings, 'block', when).name_template).toBe('{batch}_20260907_040506_{n:02}')
    expect(exportBody(settings, 'skip', when).name_template).toBe('{batch}_20260907_040506_{n:02}')
  })
})
