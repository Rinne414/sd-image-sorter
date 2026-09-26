import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { api, unwrap } from '../api/client'
import { useLibrarySuggest } from '../api/queries'
import { toPagePx } from '../lib/uiScale'
import { useLayer } from './layers'
import styles from './TagField.module.css'
import {
  insertTag,
  mergeOptions,
  nextActive,
  placeList,
  tokenAt,
  wantsSuggestions,
  withSeries,
  type ListPlace,
  type Option,
  type TagFieldMode,
  type Vocabulary,
} from './tagSuggest'

export interface TagFieldProps {
  value: string
  onChange: (value: string) => void
  /** list (default): comma separated tags. single: one tag. insert: prompt text, the word under the caret. */
  mode?: TagFieldMode
  vocabulary?: Vocabulary
  /** Tags offered before the others when they match (e.g. the ones this dataset already uses). */
  preferred?: readonly string[]
  /** How a taken tag is written in this field (its tag style); as suggested when absent. */
  write?: (tag: string) => string
  /** A character comes with its series (for fields that add tags). */
  series?: boolean
  /** A text box of several lines instead of one line. */
  rows?: number
  /** Enter with the list closed, or with Ctrl, Shift, Alt or Meta held. */
  onEnter?: (e: KeyboardEvent) => void
  onBlur?: () => void
  className?: string
  placeholder?: string
  label?: string
  testId?: string
  id?: string
  autoFocus?: boolean
  disabled?: boolean
}

type Field = HTMLInputElement | HTMLTextAreaElement

const SUGGEST_DELAY_MS = 250
const SHOWN = 8

/** Tag suggestions from the library and the danbooru vocabulary (CJK input matches aliases). */
function useGlobalSuggest(prefix: string, on: boolean) {
  return useQuery({
    queryKey: ['tag-suggest', prefix],
    enabled: on && prefix.length > 0,
    queryFn: async ({ signal }) =>
      unwrap<{ suggestions: { tag: string; count: number; zh: string | null; copyright?: string | null }[] }>(
        await api.GET('/api/tags/suggest', { params: { query: { q: prefix, limit: 12 } }, signal }),
      ).suggestions.map((s): Option => ({ value: s.tag, count: s.count, zh: s.zh, copyright: s.copyright ?? null })),
    staleTime: 60_000,
  })
}

/** What the vocabulary offers for the typed text, asked for once typing pauses. */
function useOptions(typed: string, vocabulary: Vocabulary, preferred: readonly string[]): Option[] {
  const [prefix, setPrefix] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setPrefix(typed), SUGGEST_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [typed])
  const global = vocabulary === 'global'
  const asks = wantsSuggestions(prefix, vocabulary)
  const library = useLibrarySuggest(!global && asks ? 'tags' : null, prefix)
  const vocab = useGlobalSuggest(prefix, global && asks)
  const found = (global ? vocab.data : library.isPlaceholderData ? undefined : library.data) ?? []
  // Only answers for exactly what is typed now: a quick Enter never takes a tag found for an older word.
  if (prefix !== typed || !wantsSuggestions(typed, vocabulary)) return []
  return mergeOptions(typed, preferred, found).slice(0, SHOWN)
}

/** Keeps the list next to its field while the page or a dialog scrolls, or the window changes size. */
function usePlace(fieldRef: RefObject<Field | null>, open: boolean): ListPlace | null {
  const [place, setPlace] = useState<ListPlace | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const fit = () => {
      const box = fieldRef.current?.getBoundingClientRect()
      if (!box) return
      const page = { left: toPagePx(box.left), top: toPagePx(box.top), bottom: toPagePx(box.bottom), width: toPagePx(box.width) }
      setPlace(placeList(page, { width: toPagePx(innerWidth), height: toPagePx(innerHeight) }))
    }
    fit()
    window.addEventListener('resize', fit)
    window.addEventListener('scroll', fit, true)
    return () => {
      window.removeEventListener('resize', fit)
      window.removeEventListener('scroll', fit, true)
    }
  }, [open, fieldRef])
  return open ? place : null
}

/** Where the caret is, and where it goes after a taken tag rewrote the text. */
function useCaret(fieldRef: RefObject<Field | null>, value: string) {
  const [caret, setCaret] = useState(value.length)
  const pending = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = pending.current
    if (at === null) return
    pending.current = null
    fieldRef.current?.setSelectionRange(at, at)
    setCaret(at)
  }, [value, fieldRef])
  const moveAfterWrite = (at: number) => void (pending.current = at)
  return { caret: Math.min(caret, value.length), setCaret, moveAfterWrite }
}

/**
 * A text field that suggests tags as you type, with V3.5's keys: ↑↓ move
 * (round the list), Enter or Tab take the highlighted tag, Esc closes only
 * the list (the layer stack), never the dialog under it. The list floats
 * over the page, so a dialog's scrolling body never cuts it off.
 */
export function TagField(props: TagFieldProps) {
  const { value, onChange, mode = 'list', vocabulary = 'global', preferred = [], write, series = false, rows, onEnter, onBlur } = props
  const fieldRef = useRef<Field | null>(null)
  const listId = useId()
  const { caret, setCaret, moveAfterWrite } = useCaret(fieldRef, value)
  const [active, setActive] = useState(0)
  // Opens when the user types; taking a tag, Esc and leaving the field close it.
  const [closed, setClosed] = useState(true)

  const token = tokenAt(value, caret, mode)
  const options = useOptions(closed ? '' : token.text, vocabulary, preferred)
  const open = !closed && options.length > 0
  useLayer(open, () => setClosed(true))
  const place = usePlace(fieldRef, open)
  const activeIndex = Math.min(active, options.length - 1)
  const current = options[activeIndex]

  const take = (o: Option) => {
    const tags = (series ? withSeries(o.value, o.copyright, value) : [o.value]).map((tag) => (write ? write(tag) : tag))
    const next = insertTag(value, token, tags, mode)
    moveAfterWrite(next.caret)
    setClosed(true)
    setActive(0)
    onChange(next.value)
  }

  const onKeyDown = (e: KeyboardEvent<Field>) => {
    if (e.nativeEvent.isComposing) return
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setActive(nextActive(activeIndex, options.length, e.key))
    } else if (open && current && plain && (e.key === 'Tab' || e.key === 'Enter')) {
      // The tag is taken here only: a dialog or panel listening for Enter does not also act on it.
      e.preventDefault()
      e.stopPropagation()
      take(current)
    } else if (e.key === 'Enter' && onEnter) {
      onEnter(e)
    }
  }

  const field = {
    ref: (el: Field | null) => void (fieldRef.current = el),
    id: props.id,
    className: props.className,
    value,
    placeholder: props.placeholder,
    'aria-label': props.label,
    spellCheck: false,
    autoFocus: props.autoFocus,
    disabled: props.disabled,
    'data-testid': props.testId,
    role: 'combobox',
    'aria-expanded': open,
    'aria-controls': open ? listId : undefined,
    'aria-autocomplete': 'list' as const,
    'aria-activedescendant': open ? `${listId}-${activeIndex}` : undefined,
    onChange: (e: ChangeEvent<Field>) => {
      onChange(e.target.value)
      setCaret(e.target.selectionStart ?? e.target.value.length)
      setClosed(false)
      setActive(0)
    },
    onSelect: (e: SyntheticEvent<Field>) => setCaret(e.currentTarget.selectionStart ?? value.length),
    onKeyDown,
    onBlur: () => {
      setClosed(true)
      onBlur?.()
    },
  }

  return (
    <>
      {rows ? <textarea rows={rows} {...field} /> : <input {...field} />}
      {open && place && createPortal(<SuggestList id={listId} options={options} active={activeIndex} place={place} write={write} onTake={take} />, document.body)}
    </>
  )
}

interface ListProps {
  id: string
  options: Option[]
  active: number
  place: ListPlace
  /** Each row shows its tag as the field will write it. */
  write?: (tag: string) => string
  onTake: (o: Option) => void
}

/** The floating list: the highlighted row stays in sight; pressing a row never takes the focus from the field. */
function SuggestList({ id, options, active, place, write, onTake }: ListProps) {
  const ref = useRef<HTMLUListElement>(null)
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const style = { left: place.left, top: place.top ?? undefined, bottom: place.bottom ?? undefined, width: place.width, maxHeight: place.maxHeight }
  return (
    <ul ref={ref} id={id} className={styles.list} role="listbox" style={style} onMouseDown={(e) => e.preventDefault()} data-testid="tag-suggest">
      {options.map((o, i) => (
        <li key={o.value} id={`${id}-${i}`} role="option" aria-selected={i === active} onClick={() => onTake(o)}>
          <span className={styles.name}>
            {write ? write(o.value) : o.value}
            {o.zh && <span className={styles.zh}>{o.zh}</span>}
          </span>
          {o.count !== undefined && <span className={`${styles.count} mono`}>{o.count.toLocaleString()}</span>}
        </li>
      ))}
    </ul>
  )
}
