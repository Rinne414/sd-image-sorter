import { useEffect, useState } from 'react'
import { useLibrarySuggest } from '../api/queries'
import { useLayer } from './layers'
import styles from './TagInput.module.css'

interface Props {
  placeholder: string
  label: string
  /** Called with the tags typed (comma separated); true clears the field. */
  onSubmit: (tags: string[]) => Promise<boolean> | boolean
  testId?: string
}

const SUGGEST_DELAY_MS = 250

const split = (text: string) =>
  text
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** A tag field that suggests tags already in the library, most used first. */
export function TagInput({ placeholder, label, onSubmit, testId }: Props) {
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

  const suggest = useLibrarySuggest(prefix.length >= 2 ? 'tags' : null, prefix)
  const options = (suggest.data ?? []).filter((o) => o.value && o.value !== segment).slice(0, 8)
  const open = !closed && segment.length >= 2 && options.length > 0
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
                <span>{o.value}</span>
                {o.count !== undefined && <span className={`${styles.count} mono`}>{o.count.toLocaleString()}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
