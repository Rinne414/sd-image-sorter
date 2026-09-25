import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useImageDetail, useLibraries } from '../../api/queries'
import { translate, useLang, useT, type MessageKey, type Params } from '../../i18n'
import { copyText } from '../../lib/format'
import { useApp } from '../../state/store'
import { useTheme } from '../../theme'
import { useLayer } from '../../ui/layers'
import { useJobs } from '../jobs/jobs'
import { useSelectionDialog } from '../selection/dialogs'
import styles from './CommandPalette.module.css'

interface Command {
  id: string
  group: MessageKey
  label: string
  /** Both languages, so either one finds it. */
  haystack: string
  hint?: string
  run: () => void
}

function both(key: MessageKey, params?: Params): string {
  return `${translate('zh-CN', key, params)} ${translate('en', key, params)}`.toLowerCase()
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
  const inspectedId = useApp((s) => s.inspectedId)
  const detail = useImageDetail(inspectedId)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useLayer(true, () => setOpen(false))

  const commands = useMemo<Command[]>(() => {
    const s = useApp.getState()
    const mk = (id: string, group: MessageKey, key: MessageKey, run: () => void, hint?: string, params?: Params): Command => ({
      id,
      group,
      label: translate(lang, key, params),
      haystack: both(key, params),
      run,
      ...(hint ? { hint } : {}),
    })
    const list: Command[] = [
      mk('go-library', 'palette.group.go', 'palette.cmd.goLibrary', () => s.setPage('library')),
      mk('go-batch', 'palette.group.go', 'palette.cmd.goBatch', () => s.setPage('batch')),
      mk('go-sort', 'palette.group.go', 'palette.cmd.goSort', () => s.setPage('sort')),
      mk('go-home', 'palette.group.go', 'palette.cmd.goHome', () => s.setPage('home')),
      mk('back-v3', 'palette.group.go', 'palette.cmd.backToV3', () => location.assign('/')),
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
    if (useJobs.getState().jobs.length > 0) {
      list.push(mk('jobs', 'palette.group.library', 'palette.cmd.jobs', () => useJobs.getState().setDrawerOpen(true)))
    }
    if (s.selection.length > 0) {
      const show = useSelectionDialog.getState().show
      list.push(
        mk('sel-tag', 'palette.group.selection', 'palette.cmd.tag', () => show('tag')),
        mk('sel-edit-tags', 'palette.group.selection', 'palette.cmd.editTags', () => show('edit-tags')),
        mk('sel-export', 'palette.group.selection', 'palette.cmd.exportData', () => show('export')),
        mk('sel-move', 'palette.group.selection', 'palette.cmd.move', () => show('move')),
        mk('sel-copy', 'palette.group.selection', 'palette.cmd.copy', () => show('copy')),
        mk('sel-remove', 'palette.group.selection', 'palette.cmd.remove', () => show('remove'), 'Del'),
        mk('sel-trash', 'palette.group.selection', 'palette.cmd.trash', () => show('trash')),
      )
    }
    if (inspectedId !== null) {
      list.push(mk('open-full', 'palette.group.image', 'palette.cmd.openFull', () => s.openLightbox(inspectedId), 'Enter'))
      const prompt = detail.data?.image.prompt
      if (prompt) list.push(mk('copy-prompt', 'palette.group.image', 'palette.cmd.copyPrompt', () => void copyText(prompt)))
    }
    return list
  }, [lang, libraries.data, inspectedId, detail.data])

  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = commands.filter((c) => terms.every((term) => c.haystack.includes(term)))

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
              run(shown[active])
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
                  aria-selected={i === active}
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
