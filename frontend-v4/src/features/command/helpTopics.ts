import type { MessageKey } from '../../i18n'
import type { Page } from '../../lib/route'
import { SHORTCUTS as CENSOR_KEYS, type ShortcutGroup as CensorGroup } from '../censor/keys'
import { SHORTCUT_GROUPS, SHORTCUTS as LIBRARY_KEYS } from '../library/keys'

// Ctrl K › 说明: for each page, what it is for and the keys it answers to.
// The library and censor rows come from the tables their key handlers are
// tested against; the sort rows are checked against sortModes.keyAction in
// helpTopics.test.ts, the pick rows against the pick grid's pure helpers.

export interface HelpRow {
  /** As printed on the key; one row may list several. */
  keys: string[]
  label: MessageKey
  /** A mouse gesture, shown translated instead of the keys. */
  gesture?: MessageKey
  /** When the key applies (e.g. only while reviewing detections). */
  note?: MessageKey
}

export interface HelpGroup {
  id: string
  label: MessageKey
  /** A part of the heading that is itself a message ({group} in the label). */
  part?: MessageKey
  rows: HelpRow[]
}

export interface HelpTopic {
  page: Page
  /** The page's name. */
  name: MessageKey
  purpose: MessageKey
  groups: HelpGroup[]
}

const LIBRARY_GESTURE: Record<string, MessageKey> = {
  ctrlClick: 'lib.keys.gesture.ctrlClick',
  shiftClick: 'lib.keys.gesture.shiftClick',
  rightClick: 'lib.keys.gesture.rightClick',
  doubleClick: 'lib.keys.gesture.doubleClick',
  drag: 'lib.keys.gesture.drag',
}

const CENSOR_GESTURE: Record<string, MessageKey> = {
  'Alt+click': 'censor.keys.altClick',
  'Ctrl+wheel': 'censor.keys.ctrlWheel',
  'Space+drag': 'censor.keys.spaceDrag',
}

const CENSOR_GROUPS: { id: CensorGroup; label: MessageKey }[] = [
  { id: 'tools', label: 'censor.keys.groupTools' },
  { id: 'edit', label: 'censor.keys.groupEdit' },
  { id: 'review', label: 'censor.keys.groupReview' },
  { id: 'view', label: 'censor.keys.groupView' },
]

const withGesture = (row: HelpRow, gesture: MessageKey | undefined): HelpRow => (gesture ? { ...row, gesture } : row)

function libraryGroups(): HelpGroup[] {
  return SHORTCUT_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    rows: LIBRARY_KEYS.filter((s) => s.group === g.id).map((s) => withGesture({ keys: s.keys, label: s.label }, s.pointer ? LIBRARY_GESTURE[s.keys[0] ?? ''] : undefined)),
  }))
}

const NOTE: Partial<Record<string, MessageKey>> = { review: 'help.onlyReview', outside: 'help.outsideReview' }

function censorGroups(): HelpGroup[] {
  return CENSOR_GROUPS.map((g) => ({
    id: `censor-${g.id}`,
    label: 'help.group.censor',
    part: g.label,
    rows: CENSOR_KEYS.filter((s) => s.group === g.id).map((s) => {
      const note = NOTE[s.when ?? '']
      const row = withGesture({ keys: s.keys, label: s.label }, s.when === 'pointer' ? CENSOR_GESTURE[s.keys[0] ?? ''] : undefined)
      return note ? { ...row, note } : row
    }),
  }))
}

/** The pick grid's keys (batch/pickHooks.ts usePickKeys). */
export const PICK_ROWS: readonly HelpRow[] = [
  { keys: ['←', '→', '↑', '↓', 'Home', 'End'], label: 'help.key.pickMove' },
  { keys: ['Alt+←', 'Alt+→', 'Alt+Home', 'Alt+End'], label: 'help.key.pickReorder' },
  { keys: ['Ctrl+A'], label: 'help.key.pickAll' },
  { keys: ['Enter'], label: 'help.key.pickOpen' },
  { keys: ['Delete'], label: 'help.key.pickRemove' },
  { keys: ['Esc'], label: 'help.key.pickClear' },
  { keys: ['Ctrl+Z'], label: 'help.key.orderUndo' },
]

/** The sort page's keys per way of sorting (sort/sortModes.ts keyAction). */
export const SORT_ROWS: Record<'slots' | 'bracket' | 'cull' | 'sortAll', readonly HelpRow[]> = {
  slots: [
    { keys: ['W', 'A', 'S', 'D'], label: 'help.key.slot' },
    { keys: ['Space', '→'], label: 'help.key.skip' },
    { keys: ['I'], label: 'help.key.info' },
  ],
  bracket: [
    { keys: ['←', 'A'], label: 'help.key.pickLeft' },
    { keys: ['→', 'D'], label: 'help.key.pickRight' },
    { keys: ['Space', '↑', 'W'], label: 'help.key.skip' },
  ],
  cull: [
    { keys: ['→', 'D', 'K'], label: 'help.key.keep' },
    { keys: ['←', 'A', 'X'], label: 'help.key.reject' },
    { keys: ['Space', '↑', '↓', 'W', 'S'], label: 'help.key.skip' },
    { keys: ['I'], label: 'help.key.info' },
  ],
  sortAll: [
    { keys: ['Z', 'Backspace', 'Ctrl+Z'], label: 'help.key.undo' },
    { keys: ['Y', 'Ctrl+Y', 'Ctrl+Shift+Z'], label: 'help.key.redo' },
  ],
}

/** Keys that work on every page. */
function appGroup(): HelpGroup {
  return libraryGroups().find((g) => g.id === 'app') ?? { id: 'app', label: 'lib.keys.group.app', rows: [] }
}

export function helpTopic(page: Page): HelpTopic {
  switch (page) {
    case 'library':
      return { page, name: 'nav.library', purpose: 'help.purpose.library', groups: libraryGroups() }
    case 'batch':
      return { page, name: 'nav.batch', purpose: 'help.purpose.batch', groups: [{ id: 'pick', label: 'help.group.pick', rows: [...PICK_ROWS] }, ...censorGroups(), appGroup()] }
    case 'sort':
      return {
        page,
        name: 'nav.sort',
        purpose: 'help.purpose.sort',
        groups: [
          ...(['slots', 'bracket', 'cull', 'sortAll'] as const).map((id) => ({ id, label: `help.group.${id}` as const, rows: [...SORT_ROWS[id]] })),
          appGroup(),
        ],
      }
    case 'home':
      return { page, name: 'nav.home', purpose: 'help.purpose.home', groups: [appGroup()] }
    case 'settings':
      return { page, name: 'help.page.settings', purpose: 'help.purpose.settings', groups: [appGroup()] }
    case 'tools':
      return { page, name: 'help.page.tools', purpose: 'help.purpose.tools', groups: [appGroup()] }
  }
}

/** Pages whose help Ctrl K lists, in tab order. */
export const HELP_PAGES: readonly Page[] = ['library', 'batch', 'sort', 'home', 'settings', 'tools']
