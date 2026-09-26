import type { BatchKind, BatchSummary, BatchTemplate } from '../../api/types'
import type { MessageKey, Params } from '../../i18n'
import { TAG_GROUPS, type GroupedTags, type TagGroupId } from '../../lib/tagGroups'
import type { MenuItem } from '../../ui/Menu'
import { BATCH_KINDS } from '../batch/labels'
import type { SelectionDialog } from './dialogs'

// What can be done to library images, as ONE list. The selection bar, Ctrl K
// and the right-click menu on a card are all built from it, so the three can
// never offer different things. Pure: whatever an action does goes through
// the injected ops (actionOps.ts wires them to the stores and the backend).

/**
 * Text to show: a message key (translated by the caller) or text as written (a
 * batch name). `keyParams` are parameters that are themselves message keys.
 */
export type Msg = { key: MessageKey; params?: Params; keyParams?: Record<string, MessageKey> } | { text: string }

export type ActionSection = 'image' | 'find' | 'mark' | 'work' | 'files' | 'copy' | 'file' | 'danger'

export interface ImageAction {
  id: string
  label: Msg
  /** Ctrl K wording, read without the bar or menu around it (default: the label). */
  palette?: Msg
  hint?: string
  section: ActionSection
  danger?: boolean
  /** Where the selection bar shows it; picks-only actions have one. */
  bar?: 'main' | 'more'
  /** Heading above this item inside a submenu. */
  group?: Msg
  /** Shown but not choosable (a tag group with no tags, still loading). */
  disabled?: boolean
  children?: ImageAction[]
  run?: () => void
}

/** Section order in the right-click menu; the danger group always comes last. */
export const SECTION_ORDER: readonly ActionSection[] = ['image', 'find', 'mark', 'work', 'files', 'copy', 'file', 'danger']

export interface ActionTarget {
  ids: number[]
  /** True when the action applies to the picks rather than to the clicked image alone. */
  picks: boolean
}

/** Right-click on a picked card acts on all the picks; on any other card, on that card. */
export function menuTarget(clickedId: number, selection: readonly number[]): ActionTarget {
  if (selection.length > 1 && selection.includes(clickedId)) return { ids: [...selection], picks: true }
  return { ids: [clickedId], picks: false }
}

const k = (key: MessageKey, params?: Params): Msg => (params ? { key, params } : { key })
const text = (value: string): Msg => ({ text: value })

// ---- actions on a set of images (the picks, or one right-clicked card) ----

export interface BulkOps {
  rate: (ids: number[], stars: number) => void
  favorite: (ids: number[], on: boolean) => void
  dialog: (dialog: SelectionDialog, ids: number[]) => void
  censor: (ids: number[]) => void
  newBatch: (kind: BatchKind, ids: number[], template: BatchTemplate | null) => void
  addToBatch: (batch: BatchSummary, ids: number[]) => void
  compare: (a: number, b: number) => void
  /** Aesthetic scoring, as a job. */
  score: (ids: number[]) => void
  /** Open the Sort tab with these images. */
  sort: (ids: number[]) => void
}

export interface BulkInput {
  ids: number[]
  /** Every one of them is already a favourite: the action takes them out. */
  favorited: boolean
  /** Recent batches offered in "Add to batch". */
  batches: readonly BatchSummary[]
  templates: readonly BatchTemplate[]
  ops: BulkOps
}

/** Star steps offered by "Rate", best first; 0 clears. */
export const RATE_STEPS = [5, 4, 3, 2, 1, 0] as const

function batchChildren({ ids, batches, templates, ops }: BulkInput): ImageAction[] {
  const section = 'mark'
  return [
    ...BATCH_KINDS.map<ImageAction>((kind) => ({
      id: `batch-new-${kind}`,
      section,
      group: k('batch.menu.new'),
      label: k(`batch.menu.new.${kind}`),
      palette: k(`palette.cmd.picksToNew.${kind}`),
      run: () => ops.newBatch(kind, ids, null),
    })),
    ...templates.map<ImageAction>((tpl) => ({
      id: `batch-tpl-${tpl.id}`,
      section,
      group: k('batch.menu.templates'),
      label: text(`${tpl.name}…`),
      palette: k('lib.palette.picksToTemplate', { name: tpl.name }),
      run: () => ops.newBatch(tpl.kind, ids, tpl),
    })),
    ...batches.map<ImageAction>((batch) => ({
      id: `batch-add-${batch.id}`,
      section,
      group: k('batch.menu.recent'),
      label: text(batch.name),
      palette: k('palette.cmd.picksTo', { name: batch.name }),
      run: () => ops.addToBatch(batch, ids),
    })),
  ]
}

function rateChildren({ ids, ops }: BulkInput): ImageAction[] {
  return RATE_STEPS.map((n) => ({
    id: `rate-${n}`,
    section: 'mark',
    label: n ? k('card.stars', { n }) : k('card.clearStars'),
    palette: n ? k('lib.palette.rate', { n }) : k('lib.palette.rateClear'),
    hint: String(n),
    run: () => ops.rate(ids, n),
  }))
}

export function bulkActions(input: BulkInput): ImageAction[] {
  const { ids, favorited, ops } = input
  const dialog = (d: SelectionDialog) => () => ops.dialog(d, ids)
  return [
    { id: 'batch', section: 'mark', bar: 'main', label: k('batch.menu.label'), children: batchChildren(input) },
    { id: 'rate', section: 'mark', bar: 'main', label: k('sel.rate'), children: rateChildren(input) },
    {
      id: 'favorite',
      section: 'mark',
      bar: 'main',
      hint: 'F',
      label: favorited ? k('card.unfavorite') : k('sel.favorite'),
      palette: favorited ? k('lib.palette.unfavorite') : k('lib.palette.favorite'),
      run: () => ops.favorite(ids, !favorited),
    },
    { id: 'tag', section: 'work', bar: 'main', label: k('sel.tag'), palette: k('palette.cmd.tag'), run: dialog('tag') },
    { id: 'move', section: 'files', bar: 'main', label: k('sel.move'), palette: k('palette.cmd.move'), run: dialog('move') },
    { id: 'censor', section: 'work', bar: 'more', label: k('sel.censor'), palette: k('palette.cmd.censorPicks'), run: () => ops.censor(ids) },
    { id: 'copy', section: 'files', bar: 'more', label: k('sel.copy'), palette: k('palette.cmd.copy'), run: dialog('copy') },
    ...sortAction(ids, ops),
    { id: 'edit-tags', section: 'work', bar: 'more', label: k('sel.editTags'), palette: k('palette.cmd.editTags'), run: dialog('edit-tags') },
    { id: 'aesthetic', section: 'work', bar: 'more', label: k('info.aes.scorePicks'), palette: k('info.aes.scorePicksPalette'), run: () => ops.score(ids) },
    { id: 'export', section: 'files', bar: 'more', label: k('sel.exportData'), palette: k('palette.cmd.exportData'), run: dialog('export') },
    { id: 'move-library', section: 'files', bar: 'more', label: k('sel.moveLibrary'), palette: k('palette.cmd.moveLibrary'), run: dialog('move-library') },
    ...compareAction(ids, ops),
    { id: 'remove', section: 'danger', bar: 'more', danger: true, hint: 'Del', label: k('sel.remove'), palette: k('palette.cmd.remove'), run: dialog('remove') },
    { id: 'trash', section: 'danger', bar: 'more', danger: true, label: k('sel.trash'), palette: k('palette.cmd.trash'), run: dialog('trash') },
  ]
}

/** Sorting one image by keys makes no sense: "Sort these…" needs at least two. */
function sortAction(ids: number[], ops: BulkOps): ImageAction[] {
  if (ids.length < 2) return []
  return [{ id: 'sort', section: 'files', bar: 'more', label: k('sort.sel.label'), palette: k('sort.sel.palette', { n: ids.length }), run: () => ops.sort(ids) }]
}

/** "Compare these two" exists only when exactly two images are the target. */
function compareAction(ids: number[], ops: BulkOps): ImageAction[] {
  const [a, b] = ids
  if (ids.length !== 2 || a === undefined || b === undefined) return []
  return [{ id: 'compare', section: 'work', bar: 'more', label: k('sim.compare'), palette: k('sim.comparePalette'), run: () => ops.compare(a, b) }]
}

// ---- actions on the one image under the pointer (or the inspected one) ----

export interface ImageOps {
  open: (id: number) => void
  togglePick: (id: number) => void
  copy: (value: string, what: Msg) => void
  openFolder: (id: number) => void
  /** near: only images that are nearly the same. */
  findSimilar: (id: number, near: boolean) => void
}

export interface ImageFacts {
  prompt: string | null
  negative: string | null
  /** The tags that "Copy tags" copies (the image's own, or its prompt's when it has none). */
  tags: string[]
  /** A1111-style parameter block, when the image has generation details. */
  parameters: string | null
}

export interface ImageInput {
  id: number
  picked: boolean
  path: string | null
  /** null while the details load. */
  facts: ImageFacts | null
  /** null while the tag categories load. */
  groups: GroupedTags | null
  ops: ImageOps
}

const GROUP_LABEL: Record<TagGroupId, MessageKey> = {
  appearance: 'lib.copy.group.appearance',
  clothing: 'lib.copy.group.clothing',
  pose: 'lib.copy.group.pose',
  scenery: 'lib.copy.group.scenery',
  style: 'lib.copy.group.style',
  qualityMeta: 'lib.copy.group.qualityMeta',
  unclassified: 'lib.copy.group.unclassified',
}

/** The tag groups, under their own heading inside "Copy". */
function byCategory(tags: string[], groups: GroupedTags | null, copy: ImageOps['copy']): ImageAction[] {
  const group = k('lib.copy.byCategory')
  const all: ImageAction = { id: 'copy-group-all', section: 'copy', group, label: k('lib.copy.allTags'), hint: String(tags.length), run: () => copy(tags.join(', '), k('lib.copy.tags')) }
  if (!groups) return [all, { id: 'copy-group-loading', section: 'copy', group, label: k('lib.menu.loading'), disabled: true }]
  return [
    all,
    ...TAG_GROUPS.map<ImageAction>(({ id }) => {
      const list = groups[id]
      return {
        id: `copy-group-${id}`,
        section: 'copy',
        group,
        label: k(GROUP_LABEL[id]),
        palette: { key: 'lib.palette.copyGroup', keyParams: { group: GROUP_LABEL[id] } },
        hint: String(list.length),
        disabled: list.length === 0,
        run: () => copy(list.join(', '), k(GROUP_LABEL[id])),
      }
    }),
  ]
}

/** Everything that copies part of the image, as one "Copy" submenu (the menu stays short enough for a laptop). */
function copyMenu(path: string | null, facts: ImageFacts | null, groups: GroupedTags | null, ops: ImageOps): ImageAction {
  const children: ImageAction[] = []
  const copy = (id: string, label: MessageKey, value: string | null, what: MessageKey = label) => {
    if (value) children.push({ id, section: 'copy', label: k(label), run: () => ops.copy(value, k(what)) })
  }
  if (!facts) children.push({ id: 'copy-loading', section: 'copy', label: k('lib.menu.loading'), disabled: true })
  copy('copy-prompt', 'lib.copy.prompt', facts?.prompt ?? null)
  copy('copy-negative', 'lib.copy.negative', facts?.negative ?? null)
  if (facts?.tags.length) copy('copy-tags', 'lib.copy.tags', facts.tags.join(', '))
  copy('copy-parameters', 'card.copyAll', facts?.parameters ?? null)
  copy('copy-path', 'lib.file.copyPath', path, 'lib.file.path')
  if (facts?.tags.length) children.push(...byCategory(facts.tags, groups, ops.copy))
  return { id: 'copy', section: 'copy', label: k('card.copy'), children }
}

export function imageActions({ id, picked, path, facts, groups, ops }: ImageInput): ImageAction[] {
  return [
    { id: 'open', section: 'image', hint: 'Enter', label: k('card.openFull'), palette: k('palette.cmd.openFull'), run: () => ops.open(id) },
    { id: 'pick', section: 'image', hint: 'Space', label: k(picked ? 'lib.menu.unpick' : 'lib.menu.pick'), run: () => ops.togglePick(id) },
    { id: 'similar', section: 'find', label: k('sim.find.similar'), palette: k('sim.find.similarPalette'), run: () => ops.findSimilar(id, false) },
    { id: 'near', section: 'find', label: k('sim.find.near'), palette: k('sim.find.nearPalette'), run: () => ops.findSimilar(id, true) },
    copyMenu(path, facts, groups, ops),
    { id: 'open-folder', section: 'file', label: k('lib.file.openFolder'), run: () => ops.openFolder(id) },
  ]
}

// ---- putting them in order ----

/** Stable sort by section, so each section is one run and danger is last. */
export function bySection(actions: readonly ImageAction[]): ImageAction[] {
  const rank = (a: ImageAction) => SECTION_ORDER.indexOf(a.section)
  return actions.map((a, i) => [a, i] as const).sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j).map(([a]) => a)
}

type Translate = (key: MessageKey, params?: Params) => string

export function say(t: Translate, msg: Msg): string {
  if ('text' in msg) return msg.text
  if (!msg.keyParams) return t(msg.key, msg.params)
  const nested = Object.fromEntries(Object.entries(msg.keyParams).map(([name, key]) => [name, t(key)]))
  return t(msg.key, { ...msg.params, ...nested })
}

/** Ctrl K wording of an action. */
export const paletteText = (t: Translate, action: ImageAction): string => say(t, action.palette ?? action.label)

/** Every runnable action with its children flattened, for Ctrl K. */
export function runnable(actions: readonly ImageAction[]): ImageAction[] {
  return actions.flatMap((a) => (a.children ? runnable(a.children) : a.run && !a.disabled ? [a] : []))
}

/** A submenu's actions as items of the shared Menu (group headings kept). */
export function menuItemsOf(t: Translate, actions: readonly ImageAction[]): MenuItem[] {
  return actions.map((a) => ({
    id: a.id,
    label: say(t, a.label),
    onSelect: () => a.run?.(),
    ...(a.hint ? { hint: a.hint } : {}),
    ...(a.group ? { group: say(t, a.group) } : {}),
    ...(a.danger ? { danger: true } : {}),
  }))
}

// ---- the right-click menu ----

export interface MenuGroup {
  heading?: Msg
  actions: ImageAction[]
}

export interface MenuPlan {
  header: Msg
  groups: MenuGroup[]
}

function runsOf(actions: readonly ImageAction[], sections: readonly ActionSection[]): MenuGroup[] {
  return sections.map((s) => ({ actions: actions.filter((a) => a.section === s) })).filter((g) => g.actions.length > 0)
}

/**
 * The right-click menu for a card: one group per section, danger last. On a
 * picked card the picks' actions come first, the clicked image's own
 * (open, copy, folder) sit under their own heading, and the danger group
 * says again that it acts on the picks.
 */
export function cardMenu(target: ActionTarget, bulk: readonly ImageAction[], single: readonly ImageAction[], filename: string): MenuPlan {
  if (!target.picks) return { header: text(filename), groups: runsOf([...single, ...bulk], SECTION_ORDER) }
  const picks = k('lib.menu.picks', { n: target.ids.length })
  const [first, ...rest] = runsOf(single, ['image', 'find', 'copy', 'file'])
  const own = first ? [{ heading: k('lib.menu.thisImage'), actions: first.actions }, ...rest] : rest
  const danger = bulk.filter((a) => a.section === 'danger')
  return {
    header: picks,
    groups: [...runsOf(bulk, ['mark', 'work', 'files']), ...own, ...(danger.length ? [{ heading: picks, actions: danger }] : [])],
  }
}
