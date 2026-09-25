import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, unwrap } from '../api/client'
import { useLibrarySuggest } from '../api/queries'
import { useLayer } from './layers'
import styles from './TagInput.module.css'

interface Props {
  placeholder: string
  label: string
  /** Called with the tags typed (comma separated); true clears the field. */
  onSubmit: (tags: string[]) => Promise<boolean> | boolean
  testId?: string
  /**
   * library: tags already in the library, most used first. global: the
   * library plus the danbooru vocabulary, and Chinese / Japanese aliases.
   */
  vocabulary?: 'library' | 'global'
  /** Tags offered before the others when they match (e.g. the ones this dataset already uses). */
  preferred?: readonly string[]
}

interface Option {
  value: string
  count?: number
  zh?: string | null
}

const SUGGEST_DELAY_MS = 250
const SHOWN = 8

const split = (text: string) =>
  text
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)

const fold = (tag: string) => tag.replace(/_/g, ' ').trim().toLowerCase()
const hasCjk = (text: string) => /[぀-ヿ㐀-鿿]/.test(text)

/** Tag suggestions from the library and the danbooru vocabulary (CJK input matches aliases). */
function useGlobalSuggest(prefix: string, on: boolean) {
  return useQuery({
    queryKey: ['tag-suggest', prefix],
    enabled: on && prefix.length > 0,
    queryFn: async ({ signal }) =>
      unwrap<{ suggestions: { tag: string; count: number; zh: string | null }[] }>(
        await api.GET('/api/tags/suggest', { params: { query: { q: prefix, limit: 12 } }, signal }),
      ).suggestions.map((s): Option => ({ value: s.tag, count: s.count, zh: s.zh })),
    staleTime: 60_000,
  })
}

/** Preferred tags that start with what is typed come first; each tag once. */
function merge(segment: string, preferred: readonly string[], found: readonly Option[]): Option[] {
  const typed = fold(segment)
  const first = preferred.filter((tag) => fold(tag).startsWith(typed) && fold(tag) !== typed).map((value): Option => ({ value }))
  const seen = new Set<string>()
  return [...first, ...found].filter((o) => {
    const key = fold(o.value)
    if (!o.value || key === typed || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A tag field that suggests tags as you type (Tab or Enter takes the highlighted one). */
export function TagInput({ placeholder, label, onSubmit, testId, vocabulary = 'library', preferred = [] }: Props) {
  const [text, setText] = useState('')
  const [prefix, setPrefix] = useState('')
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState(false)

  // The segment after the last comma is what gets completed.
  const segment = text.split(/[,，]/).at(-1)?.trim() ?? ''
  useEffect(() => {
    const timer = window.setTimeout(() => setPrefix(segment), SUGGEST_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [segment])

  const global = vocabulary === 'global'
  const enough = (s: string) => s.length >= 2 || (global && hasCjk(s))
  const library = useLibrarySuggest(!global && enough(prefix) ? 'tags' : null, prefix)
  const vocab = useGlobalSuggest(prefix, global && enough(prefix))
  const found = (global ? vocab.data : library.data) ?? []
  const options = enough(segment) ? merge(segment, preferred, found).slice(0, SHOWN) : []
  const open = !closed && options.length > 0
  useLayer(open, () => setClosed(true))

  const complete = (value: string) => {
    const head = text.slice(0, text.length - (text.split(/[,，]/).at(-1)?.length ?? 0))
    setText(`${head}${head && !head.endsWith(' ') ? ' ' : ''}${value}, `)
    setActive(0)
  }

  const submit = async () => {
    const tags = split(text)
    if (!tags.length) return
    if (await onSubmit(tags)) setText('')
  }

  return (
    <div className={styles.wrap}>
      <input
        className={styles.input}
        value={text}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        data-testid={testId}
        role="combobox"
        aria-expanded={open}
        onChange={(e) => {
          setText(e.target.value)
          setClosed(false)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setActive((a) => (e.key === 'ArrowDown' ? Math.min(options.length - 1, a + 1) : Math.max(0, a - 1)))
          } else if (open && e.key === 'Tab') {
            const o = options[active]
            if (o) {
              e.preventDefault()
              complete(o.value)
            }
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const o = open ? options[active] : undefined
            if (o) complete(o.value)
            else void submit()
          }
        }}
      />
      {open && (
        <ul className={styles.list} role="listbox">
          {options.map((o, i) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => complete(o.value)}
              >
                <span>
                  {o.value}
                  {o.zh && <span className={styles.zh}>{o.zh}</span>}
                </span>
                {o.count !== undefined && <span className={`${styles.count} mono`}>{o.count.toLocaleString()}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
