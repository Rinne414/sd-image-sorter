import { describe, expect, test } from 'vitest'
import { hintVersion, notesLead, plainNotes, readAutoCheck, readUpdate, webLink, type UpdateStatus } from './updateState'

const checked = (fields: Partial<UpdateStatus>): UpdateStatus => ({
  current_version: '3.5.1',
  latest_version: '3.5.1',
  has_update: false,
  release_url: 'https://github.com/o/r/releases/tag/v3.5.1',
  release_notes: '',
  asset: null,
  error: null,
  update_unavailable_reason: null,
  is_default_github_channel: true,
  checked_at: 1_700_000_000,
  ...fields,
})

describe('readUpdate', () => {
  test('before any check it knows nothing about the latest version', () => {
    expect(readUpdate(null)).toEqual({ kind: 'unchecked' })
  })

  test('a failed check is an error, never "you are on the latest" (its latest_version is only the current one)', () => {
    const view = readUpdate(checked({ error: 'Failed to reach the default GitHub update channel: timed out' }))
    expect(view).toEqual({ kind: 'error', reason: 'Failed to reach the default GitHub update channel: timed out', defaultChannel: true })
    expect(readUpdate(checked({ error: 'x', is_default_github_channel: false }))).toMatchObject({ defaultChannel: false })
    // the backend itself did not answer: only the reason is known
    expect(readUpdate({ error: 'Internal Server Error' })).toEqual({ kind: 'error', reason: 'Internal Server Error', defaultChannel: true })
  })

  test('nothing newer: latest, with when it was checked and through which source', () => {
    expect(readUpdate(checked({}))).toEqual({ kind: 'latest', current: '3.5.1', checkedAt: 1_700_000_000, defaultChannel: true })
    expect(readUpdate(checked({ is_default_github_channel: false }))).toMatchObject({ kind: 'latest', defaultChannel: false })
  })

  test('only http(s) release links are kept', () => {
    expect(readUpdate(checked({ has_update: true, latest_version: '3.6.0', release_url: 'javascript:alert(1)' }))).toMatchObject({ url: null })
    expect(webLink('https://github.com/o/r')).toBe('https://github.com/o/r')
    expect(webLink('file:///C:/x')).toBeNull()
    expect(webLink(null)).toBeNull()
  })

  test('a newer version with a package for this computer can be installed', () => {
    const view = readUpdate(
      checked({
        latest_version: '3.6.0',
        has_update: true,
        release_notes: '## v3.6.0 — x',
        release_url: 'https://github.com/o/r/releases/tag/v3.6.0',
        asset: { name: 'sd-image-sorter-v3.6.0-app-patch.zip', size_bytes: 42_000_000 },
      }),
    )
    expect(view).toEqual({
      kind: 'available',
      current: '3.5.1',
      latest: '3.6.0',
      notes: '## v3.6.0 — x',
      url: 'https://github.com/o/r/releases/tag/v3.6.0',
      sizeBytes: 42_000_000,
    })
  })

  test('a newer version without an in-app package: download it from the release page', () => {
    const view = readUpdate(
      checked({
        latest_version: '3.6.0',
        has_update: false,
        update_unavailable_reason: 'no package',
        release_notes: 'notes',
        release_url: 'https://github.com/o/r/releases/tag/v3.6.0',
      }),
    )
    expect(view).toEqual({ kind: 'manual', current: '3.5.1', latest: '3.6.0', notes: 'notes', url: 'https://github.com/o/r/releases/tag/v3.6.0' })
  })

  test('the top bar names the new version only when there is one', () => {
    expect(hintVersion(null)).toBeNull()
    expect(hintVersion(checked({}))).toBeNull()
    expect(hintVersion(checked({ error: 'offline' }))).toBeNull()
    expect(hintVersion(checked({ latest_version: '3.6.0', has_update: true, asset: { name: 'a.zip' } }))).toBe('3.6.0')
    expect(hintVersion(checked({ latest_version: '3.6.0', update_unavailable_reason: 'no package' }))).toBe('3.6.0')
  })
})

describe('release notes', () => {
  test('markdown headings and bold marks are dropped, blank runs collapse', () => {
    expect(plainNotes('## v3.6.0 — 标题 / Title\r\n\r\n\r\n**Fast**: yes\n### Fixed')).toBe('v3.6.0 — 标题 / Title\n\nFast: yes\nFixed')
  })

  test('short notes are shown whole', () => {
    expect(notesLead('## v3.6.0\n\n修好了。')).toEqual({ lead: 'v3.6.0\n\n修好了。', more: false })
  })

  test('long notes stop at the last sentence end that fits', () => {
    const zh = '扫描 8 万张图更稳。数据库更小。' + '第一次启动只装核心依赖，重型 AI 包按需准备，'.repeat(8)
    const { lead, more } = notesLead(zh, 60)
    expect(lead).toBe('扫描 8 万张图更稳。数据库更小。')
    expect(more).toBe(true)
    const en = 'Scans are safer. The database is smaller. ' + 'First launch installs only the core packages and prepares the rest on demand '.repeat(4)
    expect(notesLead(en, 80).lead).toBe('Scans are safer. The database is smaller.')
    // "3.6.0" is not a sentence end
    expect(notesLead('Version 3.6.0 is out with many many many fixes for everyone who asked', 30).lead).not.toMatch(/3\.$/)
  })

  test('without a sentence end in reach, it cuts at a space and says there is more', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve thirteen'
    expect(notesLead(text, 30)).toEqual({ lead: 'one two three four five six…', more: true })
  })

  test('the summary above the first rule is the lead (how releases are written)', () => {
    const notes = '## v3.6.0 — 标题 / Title\n\n中文摘要。\n\nEnglish summary.\n\n---\n\n## Fixed\n\n- **Scan**: steadier.'
    expect(notesLead(notes)).toEqual({ lead: 'v3.6.0 — 标题 / Title\n\n中文摘要。\n\nEnglish summary.', more: true })
    // a long summary is still cut at a sentence end
    const long = '中文摘要第一句。' + '很长的第二句'.repeat(40) + '\n\n---\n\nrest'
    expect(notesLead(long, 50)).toEqual({ lead: '中文摘要第一句。', more: true })
  })

  test('a line break ends a sentence too (the title line)', () => {
    const text = 'v3.6.0 — 大图库稳定性 / Large Library Stability\n' + 'x'.repeat(300)
    expect(notesLead(text, 200).lead).toBe('v3.6.0 — 大图库稳定性 / Large Library Stability')
  })
})

describe('auto check setting', () => {
  test('on unless it was switched off', () => {
    expect(readAutoCheck(null)).toBe(true)
    expect(readAutoCheck('1')).toBe(true)
    expect(readAutoCheck('0')).toBe(false)
    expect(readAutoCheck('junk')).toBe(true)
  })
})
