import { describe, expect, it } from 'vitest'
import { en } from '../../i18n/en'
import { zhCN } from '../../i18n/zh-CN'
import { moveCursor } from '../batch/batchLogic'
import { groupMove } from '../batch/orderLogic'
import { keyAction, type KeyLike } from '../sort/sortModes'
import type { SortMode } from '../sort/sortSession'
import { HELP_PAGES, helpTopic, PICK_ROWS, SORT_ROWS, type HelpRow } from './helpTopics'

const NAMED: Record<string, string> = { '←': 'ArrowLeft', '→': 'ArrowRight', '↑': 'ArrowUp', '↓': 'ArrowDown', Space: ' ', Esc: 'Escape' }

/** A printed key ("Ctrl+Shift+Z", "→", "W") as the key press it stands for. */
function press(printed: string): KeyLike {
  const parts = printed.split('+')
  const last = parts.pop() ?? ''
  const key = NAMED[last] ?? (last.length === 1 ? last.toLowerCase() : last)
  return { key, ctrlKey: parts.includes('Ctrl'), shiftKey: parts.includes('Shift'), altKey: parts.includes('Alt') }
}

const MODES: Record<'slots' | 'bracket' | 'cull', SortMode> = { slots: 'slot', bracket: 'bracket', cull: 'cull' }

/** What a row's label means in sortModes terms. */
function expected(row: HelpRow, key: string): string {
  switch (row.label) {
    case 'help.key.slot':
      return `slot:${key}`
    case 'help.key.pickLeft':
      return 'pick:a'
    case 'help.key.pickRight':
      return 'pick:b'
    default:
      return row.label.replace('help.key.', '')
  }
}

function actual(e: KeyLike, mode: SortMode): string | null {
  const a = keyAction(e, mode)
  if (!a) return null
  if (a.kind === 'slot') return `slot:${a.slot}`
  if (a.kind === 'pick') return `pick:${a.side}`
  return a.kind
}

describe('help topics', () => {
  it('every page has a purpose in both languages, and every row a label', () => {
    for (const page of HELP_PAGES) {
      const topic = helpTopic(page)
      for (const key of [topic.name, topic.purpose]) {
        expect(zhCN[key], key).toBeTruthy()
        expect(en[key], key).toBeTruthy()
      }
      expect(topic.groups.length, page).toBeGreaterThan(0)
      for (const group of topic.groups) for (const row of group.rows) expect(zhCN[row.label], row.label).toBeTruthy()
    }
  })

  it('the sort rows say what sortModes does with each key', () => {
    for (const [id, mode] of Object.entries(MODES) as [keyof typeof MODES, SortMode][]) {
      for (const row of [...SORT_ROWS[id], ...SORT_ROWS.sortAll]) {
        if (row.label === 'help.key.info') continue // I is the page's own key, not a sorting action
        for (const printed of row.keys) {
          const e = press(printed)
          expect(actual(e, mode), `${id} ${printed}`).toBe(expected(row, e.key))
        }
      }
    }
  })

  it('no sorting key is left out of the sort rows', () => {
    const candidates = [...'abcdefghijklmnopqrstuvwxyz'.split(''), ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Enter']
    for (const [id, mode] of Object.entries(MODES) as [keyof typeof MODES, SortMode][]) {
      const listed = new Set([...SORT_ROWS[id], ...SORT_ROWS.sortAll].flatMap((r) => r.keys.map((k) => press(k)).filter((e) => !e.ctrlKey).map((e) => e.key)))
      for (const key of candidates) {
        if (keyAction({ key }, mode)) expect(listed.has(key), `${id}: ${JSON.stringify(key)} does something but is not listed`).toBe(true)
      }
    }
  })

  it('the pick rows are keys the pick grid moves or reorders with', () => {
    const [move, reorder] = PICK_ROWS
    for (const printed of move?.keys ?? []) expect(moveCursor(4, 9, 3, press(printed).key), printed).not.toBe(4)
    for (const printed of reorder?.keys ?? []) {
      const e = press(printed)
      expect(e.altKey, printed).toBe(true)
      expect(groupMove(e.key), printed).not.toBeNull()
    }
  })

  it('the library help keeps the library sheet, and the batch help has the censor keys', () => {
    expect(helpTopic('library').groups.map((g) => g.id)).toEqual(['browse', 'mark', 'lightbox', 'app'])
    const batch = helpTopic('batch').groups
    expect(batch.map((g) => g.id)).toEqual(['pick', 'censor-tools', 'censor-edit', 'censor-review', 'censor-view', 'app'])
    expect(batch.find((g) => g.id === 'censor-tools')?.rows.some((r) => r.keys.includes('B'))).toBe(true)
  })
})
