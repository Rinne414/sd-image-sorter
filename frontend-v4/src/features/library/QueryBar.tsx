import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLibrarySuggest } from '../../api/queries'
import { useT, type MessageKey } from '../../i18n'
import { useFittingPlaceholder } from '../../lib/fittingPlaceholder'
import { generatorName } from '../../lib/format'
import { SYNTAX_ROWS, parseSearch, suggestionContext, withoutToken, type Part } from '../../lib/searchQuery'
import { SORTS, canReverse } from '../../lib/sort'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { useClickOutside, useLayer } from '../../ui/layers'
import { Menu } from '../../ui/Menu'
import styles from './QueryBar.module.css'
import { FilterPanel } from './FilterPanel'
import { SemanticInput } from './SemanticInput'
import { pickImageFile, useImageDrop } from '../similar/imageSearch'
import { useSimilar } from '../similar/similarStore'
import { MediaToggle } from '../video/MediaToggle'

const APPLY_DELAY_MS = 300
const RATING_NAMES: Record<string, MessageKey> = {
  general: 'rating.general',
  sensitive: 'rating.sensitive',
  questionable: 'rating.questionable',
  explicit: 'rating.explicit',
}
/** Chip operators that are words (≥ ≤ = show as they are). */
const OP_NAMES: Record<string, MessageKey> = { any: 'qop.any', contains: 'qop.contains' }

interface Props {
  total: number | null
  /** The total is the backend's estimate. */
  about?: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Offer "show the rail" while the rail is folded away (the /next/ interface has no rail). */
  railToggle?: boolean
}

interface Option {
  value: string
  count?: number
}

export function QueryBar({ total, about = false, inputRef, railToggle = true }: Props) {
  const t = useT()
  const queryText = useApp((s) => s.queryText)
  const setQueryText = useApp((s) => s.setQueryText)
  const sort = useApp((s) => s.sort)
  const setSort = useApp((s) => s.setSort)
  const sortReverse = useApp((s) => s.sortReverse)
  const setSortReverse = useApp((s) => s.setSortReverse)
  const layout = useApp((s) => s.layout)
  const setLayout = useApp((s) => s.setLayout)
  const tileSize = useApp((s) => s.tileSize)
  const setTileSize = useApp((s) => s.setTileSize)
  const cardOpen = useApp((s) => s.cardOpen)
  const toggleCard = useApp((s) => s.toggleCard)
  const railOpen = useApp((s) => s.railOpen)
  const toggleRail = useApp((s) => s.toggleRail)
  const semantic = useSimilar((s) => s.semantic)
  // the full hint with its examples when the box is wide enough, shorter ones on a narrow bar
  const placeholder = useFittingPlaceholder(inputRef, [t('query.placeholder'), t('query.placeholder.medium'), t('query.placeholder.short')], semantic)
  const drop = useImageDrop()
  const [draft, setDraft] = useState(queryText)
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const timer = useRef<number | undefined>(undefined)
  /** Where the caret goes after a programmatic edit; placed in the same commit as the text. */
  const pendingCaret = useRef<number | null>(null)

  useEffect(() => setDraft(queryText), [queryText])

  // Not a requestAnimationFrame: a key pressed before the next frame would
  // land at the old caret and splice the new text onto the old.
  useLayoutEffect(() => {
    const at = pendingCaret.current
    if (at === null) return
    pendingCaret.current = null
    inputRef.current?.focus()
    inputRef.current?.setSelectionRange(at, at)
    setCaret(at)
  }, [draft, inputRef])

  const apply = (text: string, now = false) => {
    window.clearTimeout(timer.current)
    if (now) {
      setQueryText(text)
      return
    }
    // Typed just before switching library: the text belongs to the old one.
    const library = useApp.getState().libraryId
    timer.current = window.setTimeout(() => {
      if (useApp.getState().libraryId === library) setQueryText(text)
    }, APPLY_DELAY_MS)
  }

  const parsed = useMemo(() => parseSearch(draft), [draft])

  // Value suggestions for the key:value token under the caret.
  const ctx = focused ? suggestionContext(draft, caret) : null
  const library = useLibrarySuggest(ctx?.source === 'library' ? (ctx.endpoint ?? null) : null, ctx?.prefix ?? '')
  const options: Option[] = !ctx
    ? []
    : ctx.source === 'enum'
      ? (ctx.values ?? []).filter((v) => v.startsWith(ctx.prefix.toLowerCase())).map((value) => ({ value }))
      : (library.data ?? [])
  const suggestOpen =
    !dismissed && options.length > 0 && !(options.length === 1 && options[0]?.value === ctx?.prefix)

  useEffect(() => setActive(0), [ctx?.prefix, ctx?.key])
  useLayer(suggestOpen, () => setDismissed(true))

  const setText = (next: string, now: boolean) => {
    setDraft(next)
    setDismissed(false)
    apply(next, now)
  }

  const accept = (option: Option) => {
    if (!ctx) return
    const value = /\s/.test(option.value) ? `"${option.value}"` : option.value
    const before = draft.slice(0, ctx.valueStart) + value + ' '
    const next = before + draft.slice(ctx.tokenEnd).replace(/^\s+/, '')
    pendingCaret.current = before.length
    setText(next, true)
  }

  const removePart = (part: Part) => setText(withoutToken(parsed.tokens, part.token), true)

  const toggleSemantic = () => {
    const s = useSimilar.getState()
    if (s.semantic && s.query?.kind === 'text') s.clear()
    s.setSemantic(!s.semantic)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  return (
    <div className={styles.bar} {...drop.props} data-dropping={drop.over || undefined} data-card-open={cardOpen || undefined} data-testid="query-bar">
      {drop.over && <div className={styles.dropHint}>{t('sim.dropHint')}</div>}
      {railToggle && !railOpen && (
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={toggleRail}
          aria-label={t('rail.expand')}
          title={t('rail.expand')}
          data-testid="rail-expand"
        >
          <Icon name="right" size={14} />
        </button>
      )}
      {semantic ? (
        <SemanticInput key="semantic" inputRef={inputRef} />
      ) : (
        <div className={styles.field}>
          <span className={styles.glyph} aria-hidden>
            <Icon name="search" size={15} />
          </span>
          <input
            ref={inputRef}
            className={styles.input}
            value={draft}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={suggestOpen}
            aria-controls="query-suggest"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onChange={(e) => {
              setCaret(e.target.selectionStart ?? e.target.value.length)
              setText(e.target.value, false)
            }}
            onKeyDown={(e) => {
              if (suggestOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                setActive((a) => (e.key === 'ArrowDown' ? Math.min(options.length - 1, a + 1) : Math.max(0, a - 1)))
                return
              }
              if (suggestOpen && (e.key === 'Enter' || e.key === 'Tab')) {
                const option = options[active]
                if (option) {
                  e.preventDefault()
                  accept(option)
                  return
                }
              }
              if (e.key === 'Enter') apply(draft, true)
              if (e.key === 'Escape') {
                e.stopPropagation()
                if (draft) setText('', true)
                else e.currentTarget.blur()
              }
            }}
            aria-label={t('query.placeholder')}
            data-testid="query-input"
          />
          {suggestOpen && (
            <ul id="query-suggest" className={styles.suggest} role="listbox" data-testid="query-suggest">
              {options.map((o, i) => (
                <li key={o.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    className={styles.suggestRow}
                    // mousedown, so the input keeps focus and the caret position
                    onMouseDown={(e) => {
                      e.preventDefault()
                      accept(o)
                    }}
                    onMouseEnter={() => setActive(i)}
                  >
                    <span className={styles.suggestValue}>{o.value}</span>
                    {o.count !== undefined && <span className={`${styles.suggestCount} mono`}>{o.count.toLocaleString()}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        type="button"
        className="btn"
        aria-pressed={semantic}
        onClick={toggleSemantic}
        title={t('sim.semanticTitle')}
        data-testid="semantic-toggle"
      >
        {t('sim.semantic')}
      </button>
      <button
        type="button"
        className="btn btn-icon"
        onClick={pickImageFile}
        title={t('sim.byImageTitle')}
        aria-label={t('sim.byImage')}
        data-testid="search-by-image"
      >
        <Icon name="image" size={15} />
      </button>

      <FilterPanel text={draft} onChange={(next) => setText(next, true)} />
      <SyntaxHelp onExample={(ex) => setText(draft ? `${draft.trimEnd()} ${ex}` : ex, true)} />
      {/* A row of its own under the controls, as wide as the bar (CSS order puts it last): chips and the media toggle never squeeze the search box. It sits before the Sort and View menus in the markup so that those two stay the last boxes of the bar, where the entrance checks look for them. */}
      {!semantic && (
        <div className={styles.sub}>
          <MediaToggle text={draft} current={parsed.scalars.mediaType ?? ''} onChange={(next) => setText(next, true)} />
          {parsed.parts.length > 0 && (
            <div className={styles.chips} data-testid="query-chips">
              {parsed.parts.map((part, i) => (
                <Chip key={`${part.token}-${i}`} part={part} onRemove={() => removePart(part)} />
              ))}
            </div>
          )}
        </div>
      )}
      <Menu
        label={`${t('sort.current', { name: t(`sort.${sort}` as MessageKey) })}${sortReverse && canReverse(sort) ? ' ↑' : ''}`}
        items={[
          ...SORTS.map((s) => ({
            id: s.base,
            label: t(`sort.${s.base}` as MessageKey),
            checked: s.base === sort,
            onSelect: () => setSort(s.base),
          })),
          ...(canReverse(sort)
            ? [{ id: 'reverse', label: t('sort.reverse'), checked: sortReverse, onSelect: () => setSortReverse(!sortReverse), divider: true }]
            : []),
        ]}
      />
      <Menu
        label={t('view.label')}
        align="right"
        items={[
          { id: 'masonry', label: t('view.masonry'), checked: layout === 'masonry', onSelect: () => setLayout('masonry') },
          { id: 'grid', label: t('view.grid'), checked: layout === 'grid', onSelect: () => setLayout('grid') },
          { id: 's', label: t('view.size.s'), checked: tileSize === 's', onSelect: () => setTileSize('s'), divider: true },
          { id: 'm', label: t('view.size.m'), checked: tileSize === 'm', onSelect: () => setTileSize('m') },
          { id: 'l', label: t('view.size.l'), checked: tileSize === 'l', onSelect: () => setTileSize('l') },
          { id: 'card', label: t('view.card'), checked: cardOpen, onSelect: toggleCard, hint: 'I', divider: true },
        ]}
      />
      <span className={styles.count} data-testid="result-count">
        {total === null ? '' : t(about ? 'grid.countAbout' : 'grid.count', { n: total })}
      </span>
    </div>
  )
}

function Chip({ part, onRemove }: { part: Part; onRemove: () => void }) {
  const t = useT()
  if (part.kind === 'warn') {
    return (
      <button
        type="button"
        className={styles.chip}
        data-kind="warn"
        onClick={onRemove}
        title={part.hint || t('query.clear')}
      >
        <span>{t('query.warning', { token: part.raw })}</span>
        <span className={styles.chipKey}>{part.reason === 'media' ? t('video.media.warn') : t(`searchWarn.${part.reason}` as MessageKey)}</span>
        <Icon name="close" size={11} />
      </button>
    )
  }
  const negated = part.kind === 'filter' && part.key.startsWith('-')
  const key = part.kind === 'free' ? 'free' : part.key.replace(/^-/, '')
  let value = part.value
  if (part.kind === 'filter' && key === 'generator') value = generatorName(part.value, t)
  if (part.kind === 'filter' && key === 'rating' && RATING_NAMES[part.value]) value = t(RATING_NAMES[part.value]!)
  if (part.kind === 'filter' && key === 'media') value = t(part.value === 'video' ? 'video.media.video' : 'video.media.image')
  return (
    <button type="button" className={styles.chip} data-kind={negated ? 'exclude' : key} onClick={onRemove} title={t('query.clear')}>
      <span className={styles.chipKey}>
        {negated ? `${t('qkey.not')} ` : ''}
        {key === 'media' ? t('video.media.chipKey') : t(`qkey.${key}` as MessageKey)}
      </span>
      <span>
        {part.kind === 'filter' && part.op ? `${OP_NAMES[part.op] ? t(OP_NAMES[part.op]!) : part.op} ` : ''}
        {value}
      </span>
      <Icon name="close" size={11} />
    </button>
  )
}

/** The "?" next to the box: every key, one line each; clicking an example adds it. */
function SyntaxHelp({ onExample }: { onExample: (example: string) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useLayer(open, () => setOpen(false))
  useClickOutside(ref, open, () => setOpen(false))
  return (
    <div className={styles.helpWrap} ref={ref}>
      <button
        type="button"
        className="btn btn-icon"
        aria-expanded={open}
        aria-label={t('query.help')}
        title={t('query.help')}
        onClick={() => setOpen(!open)}
        data-testid="query-help"
      >
        ?
      </button>
      {open && (
        <div className={styles.help} role="dialog" aria-label={t('searchHelp.title')}>
          <p className={styles.helpIntro}>{t('searchHelp.intro')}</p>
          <table className={styles.helpTable}>
            <tbody>
              {SYNTAX_ROWS.map((row) => (
                <tr key={row.key}>
                  <td className="mono">{row.key === 'free' ? t('qkey.free') : row.syntax}</td>
                  <td>
                    <button type="button" className={`${styles.example} mono`} onClick={() => onExample(row.example)}>
                      {row.example}
                    </button>
                  </td>
                  <td>{row.key === 'media' ? t('video.media.syntax') : t(`searchHelp.${row.key}` as MessageKey)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
