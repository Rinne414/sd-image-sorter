import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLibraries } from '../../api/queries'
import { translate, useLang, useT, type Lang, type MessageKey, type Params } from '../../i18n'
import { leaveForV35 } from '../../state/arrival'
import { useApp } from '../../state/store'
import { useTheme } from '../../theme'
import { useLayer } from '../../ui/layers'
import { recentBatches } from '../batch/addPicks'
import { useBatches } from '../batch/batchApi'
import { askNewBatch } from '../batch/dialogStore'
import { BATCH_KINDS } from '../batch/labels'
import { useJobs } from '../jobs/jobs'
import { currentLibraryParams } from '../library/params'
import { openRandom } from '../library/randomOpen'
import { useShortcutSheet } from '../library/ShortcutSheet'
import { paletteText, runnable, type ImageAction } from '../selection/actions'
import { useBulkActions, useImageActions } from '../selection/actionOps'
import { useSelectionDialog } from '../selection/dialogs'
import { invertPicks } from '../selection/invert'
import { withClip } from '../similar/clip'
import { useSimilarDialogs } from '../similar/dialogs'
import { pickImageFile } from '../similar/imageSearch'
import { startIndexing } from '../similar/similarApi'
import { useSimilar } from '../similar/similarStore'
import { useOtherLibrary } from '../sort/StageParts'
import { continueSort, sortImages, useSortPending } from '../sort/sortStore'
import { useStatusDialogs } from '../status/dialogs'
import { useUpdates } from '../settings/about/updateStore'
import { restartApp } from '../settings/restart'
import { useUiScale } from '../settings/uiScaleStore'
import { command, matches, type Command } from './commands'
import styles from './CommandPalette.module.css'
import { shellCommands, type ShellOps } from './shellCommands'

const zh = (key: MessageKey, params?: Params) => translate('zh-CN', key, params)
const en = (key: MessageKey, params?: Params) => translate('en', key, params)

/** A shared image action as a command; either language finds it. */
function fromAction(action: ImageAction, group: MessageKey, prefix: string, lang: 'zh-CN' | 'en'): Command {
  return {
    id: `${prefix}-${action.id}`,
    group,
    label: paletteText(lang === 'zh-CN' ? zh : en, action),
    haystack: `${paletteText(zh, action)} ${paletteText(en, action)}`.toLowerCase(),
    run: () => action.run?.(),
    ...(action.hint ? { hint: action.hint } : {}),
  }
}

/** What the shell's commands do (settings, tools, language, zoom, help). */
const SHELL_OPS: ShellOps = {
  openTool: (tool) => useApp.getState().openTool(tool),
  openSettings: (tab) => useApp.getState().openSettings(tab),
  setLang: (lang: Lang) => useLang.getState().setLang(lang),
  setScale: (setting) => useUiScale.getState().setSetting(setting),
  openHelp: (page) => useShortcutSheet.getState().open(page),
  checkUpdates: () => {
    useApp.getState().openSettings('about')
    void useUpdates.getState().check(true)
  },
  restart: () => void restartApp(),
}

/** Turn the query bar to "by meaning" and put the caret in it. */
function searchByMeaning(): void {
  const s = useApp.getState()
  if (s.page !== 'library') s.setPage('library')
  useSimilar.getState().setSemantic(true)
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="semantic-input"]')?.focus())
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen)
  if (!open) return null
  return createPortal(<Palette />, document.body)
}

function Palette() {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const setOpen = useApp((s) => s.setPaletteOpen)
  const libraries = useLibraries()
  const batches = useBatches()
  const inspectedId = useApp((s) => s.inspectedId)
  // Fixed while the palette is open, like everything a command applies to.
  const [picks] = useState(() => useApp.getState().selection)
  const bulk = useBulkActions(picks)
  const single = useImageActions(inspectedId)
  const sortPending = useSortPending()
  const sortElsewhere = useOtherLibrary(sortPending)?.where ?? null
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useLayer(true, () => setOpen(false))

  const commands = useMemo<Command[]>(() => {
    const s = useApp.getState()
    const mk = (id: string, group: MessageKey, key: MessageKey, run: () => void, hint?: string, params?: Params): Command =>
      command(lang, id, group, key, run, hint, params)
    const list: Command[] = [
      mk('go-library', 'palette.group.go', 'palette.cmd.goLibrary', () => s.setPage('library')),
      mk('go-batch', 'palette.group.go', 'palette.cmd.goBatch', () => s.setPage('batch')),
      mk('go-sort', 'palette.group.go', 'palette.cmd.goSort', () => s.setPage('sort')),
      mk('go-home', 'palette.group.go', 'palette.cmd.goHome', () => s.setPage('home')),
      mk('back-v3', 'palette.group.go', 'palette.cmd.backToV3', () => leaveForV35(useApp.getState().libraryId)),
      mk('card', 'palette.group.view', 'palette.cmd.toggleCard', () => s.toggleCard(), 'I'),
      mk('rail', 'palette.group.view', 'palette.cmd.toggleRail', () => s.toggleRail()),
      mk('masonry', 'palette.group.view', 'palette.cmd.masonry', () => s.setLayout('masonry')),
      mk('grid', 'palette.group.view', 'palette.cmd.grid', () => s.setLayout('grid')),
      mk('theme-dark', 'palette.group.view', 'palette.cmd.themeDark', () => useTheme.getState().setMode('dark')),
      mk('theme-light', 'palette.group.view', 'palette.cmd.themeLight', () => useTheme.getState().setMode('light')),
      mk('theme-system', 'palette.group.view', 'palette.cmd.themeSystem', () => useTheme.getState().setMode('system')),
      mk('favorites', 'palette.group.library', 'palette.cmd.onlyFavorites', () => {
        s.setPage('library')
        s.setScope({ favorites: true })
      }),
      mk('clear', 'palette.group.library', 'palette.cmd.clearFilters', () => {
        s.setQueryText('')
        s.setScope({ favorites: false, folder: null, generators: [] })
      }),
    ]
    for (const lib of libraries.data?.libraries ?? []) {
      if (lib.id === s.libraryId) continue
      const name = lib.is_default && lib.name === 'Main library' ? translate(lang, 'rail.mainLibrary') : lib.name
      list.push(mk(`lib-${lib.id}`, 'palette.group.library', 'palette.cmd.switchTo', () => s.setLibrary(lib.id), undefined, { name }))
    }
    list.push(mk('random', 'palette.group.library', 'lib.palette.random', () => void openRandom()))
    list.push(mk('semantic', 'palette.group.library', 'sim.palette.semantic', () => searchByMeaning()))
    list.push(mk('by-image', 'palette.group.library', 'sim.palette.byImage', pickImageFile))
    list.push(mk('duplicates', 'palette.group.library', 'sim.palette.duplicates', () => useSimilarDialogs.getState().setDuplicates(true)))
    list.push(mk('report', 'palette.group.library', 'status.report.palette', () => useStatusDialogs.getState().setReport(true)))
    list.push(mk('build-index', 'palette.group.library', 'sim.palette.buildIndex', () => void withClip(() => void startIndexing())))
    if (s.page === 'library') list.push(mk('invert', 'palette.group.library', 'lib.palette.invert', () => void invertPicks(currentLibraryParams()), 'Ctrl+I'))
    if (s.page === 'library') list.push(mk('sort-filter', 'palette.group.library', 'sort.palette.filter', () => sortImages({ kind: 'filter' })))
    if (sortPending) {
      const key = sortElsewhere ? 'sort.palette.continueOther' : 'sort.palette.continue'
      list.push(mk('sort-continue', 'palette.group.go', key, () => continueSort(), undefined, { where: sortElsewhere ?? '' }))
    }
    list.push(mk('import', 'palette.group.library', 'palette.cmd.import', () => useSelectionDialog.getState().showFor('import', null, 1)))
    list.push(mk('libraries', 'palette.group.library', 'palette.cmd.libraries', () => useSelectionDialog.getState().showFor('libraries', null, 1)))
    if (useJobs.getState().jobs.length > 0) {
      list.push(mk('jobs', 'palette.group.library', 'palette.cmd.jobs', () => useJobs.getState().setDrawerOpen(true)))
    }
    for (const kind of BATCH_KINDS) {
      list.push(mk(`new-batch-${kind}`, 'palette.group.batch', `batch.menu.new.${kind}`, () => askNewBatch(kind, [], 'page')))
    }
    for (const b of recentBatches(batches.data)) {
      list.push(mk(`open-batch-${b.id}`, 'palette.group.batch', 'palette.cmd.openBatch', () => s.openBatch(b.id), undefined, { name: b.name }))
    }
    // The same list as the selection bar and the right-click menu.
    if (picks.length > 0) for (const a of runnable(bulk)) list.push(fromAction(a, 'palette.group.selection', 'sel', lang))
    for (const a of runnable(single)) list.push(fromAction(a, 'palette.group.image', 'img', lang))
    list.push(...shellCommands(lang, SHELL_OPS))
    list.push(mk('shortcuts', 'lib.palette.groupHelp', 'lib.palette.shortcuts', () => useShortcutSheet.getState().open(s.page)))
    return list
  }, [lang, libraries.data, batches.data, picks, bulk, single, sortPending, sortElsewhere])

  const shown = commands.filter((c) => matches(c, q))
  // The pointer can leave `active` on a row the typed filter just removed: the first row stands in until it resets.
  const current = active < shown.length ? active : 0

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setActive(0), [q])

  const run = (cmd: Command | undefined) => {
    if (!cmd) return
    setOpen(false)
    cmd.run()
  }

  let lastGroup: MessageKey | null = null

  return (
    <div className={styles.scrim} onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className={styles.palette} role="dialog" aria-modal="true" aria-label={t('nav.command')} data-testid="palette">
        <input
          ref={inputRef}
          className={styles.input}
          value={q}
          placeholder={t('palette.placeholder')}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              setActive((a) => Math.min(shown.length - 1, a + 1))
              e.preventDefault()
            } else if (e.key === 'ArrowUp') {
              setActive((a) => Math.max(0, a - 1))
              e.preventDefault()
            } else if (e.key === 'Enter') {
              run(shown[current])
              e.preventDefault()
            }
          }}
        />
        <ul className={styles.list} role="listbox">
          {shown.length === 0 && <li className={styles.empty}>{t('palette.empty')}</li>}
          {shown.map((cmd, i) => {
            const head = cmd.group !== lastGroup ? cmd.group : null
            lastGroup = cmd.group
            return (
              <li key={cmd.id}>
                {head && <div className={styles.group}>{t(head)}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === current}
                  className={styles.row}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(cmd)}
                >
                  <span>{cmd.label}</span>
                  {cmd.hint && <kbd>{cmd.hint}</kbd>}
                </button>
              </li>
            )
          })}
        </ul>
        <footer className={styles.foot}>{t('palette.hint')}</footer>
      </div>
    </div>
  )
}
