import { useState } from 'react'
import { Icon } from '../../../../ui/Icon'
import { usePL } from '../plText'
import { isKnownCategory, useCategoryLabel } from './labels'
import styles from './Random.module.css'
import { setRandom, useRandom } from './randomStore'
import { tagKey, toggleTag } from './slots'

// Every category of the tag pool, folded; a search opens the matching ones.
// A click puts a tag in its category's slot (or takes it out). Long
// categories show a page at a time: nothing is cut off for good.

const PAGE = 60
const NONE: string[] = []

interface Props {
  pool: Record<string, string[]> | undefined
  loading: boolean
  error: string | null
}

function Group({ cat, tags, open, onToggle }: { cat: string; tags: string[]; open: boolean; onToggle: () => void }) {
  const p = usePL()
  const label = useCategoryLabel()
  const picked = useRandom((s) => s.slots[cat] ?? NONE)
  const [shown, setShown] = useState(PAGE)
  const tone = isKnownCategory(cat) ? `cat-${cat}` : 'cat-unknown'
  return (
    <li className={styles.group} data-cat={cat}>
      <button type="button" className={styles.groupHead} aria-expanded={open} onClick={onToggle}>
        <Icon name={open ? 'caret' : 'right'} size={12} />
        <span className={styles.groupName}>{label(cat)}</span>
        <span className="mono">{tags.length.toLocaleString()}</span>
        {picked.length > 0 && <span className={styles.picked}>{p('pl.rnd.picked', { n: picked.length })}</span>}
      </button>
      {open && (
        <div className={styles.groupTags}>
          {tags.slice(0, shown).map((tag) => (
            <button
              key={tag}
              type="button"
              className={`chip ${tone} ${styles.tagChip}`}
              aria-pressed={picked.includes(tag)}
              onClick={() => setRandom({ slots: toggleTag(useRandom.getState().slots, cat, tag) })}
            >
              {tag}
            </button>
          ))}
          {tags.length > shown && (
            <button type="button" className={styles.textButton} onClick={() => setShown(shown + PAGE * 2)}>
              {p('pl.stats.more', { n: tags.length - shown })}
            </button>
          )}
        </div>
      )}
    </li>
  )
}

export function CategoryBrowser({ pool, loading, error }: Props) {
  const p = usePL()
  const [text, setText] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const needle = tagKey(text)
  const groups = Object.entries(pool ?? {})
    .map(([cat, tags]) => [cat, needle ? tags.filter((tag) => tagKey(tag).includes(needle)) : tags] as const)
    .filter(([, tags]) => tags.length > 0)
  return (
    <aside className={styles.browser} data-testid="pl-browser">
      <h3 className={styles.panelTitle}>{p('pl.rnd.browser')}</h3>
      <p className={styles.muted}>{p('pl.rnd.browserLead')}</p>
      <input className={styles.input} value={text} onChange={(e) => setText(e.target.value)} placeholder={p('pl.rnd.search')} aria-label={p('pl.rnd.search')} spellCheck={false} data-testid="pl-browser-search" />
      {loading && <p className={styles.muted}>{p('pl.rnd.loading')}</p>}
      {error && <p className={styles.problem}>{p('pl.rnd.loadFailed', { reason: error })}</p>}
      {pool && groups.length === 0 && <p className={styles.muted}>{needle ? p('pl.rnd.noMatch', { q: text.trim() }) : p('pl.rnd.noCategories')}</p>}
      <ul className={styles.groups}>
        {groups.map(([cat, tags]) => (
          // a new search starts every category at its first page
          <Group key={`${cat}:${needle}`} cat={cat} tags={tags} open={!!needle || !!open[cat]} onToggle={() => setOpen({ ...open, [cat]: !open[cat] })} />
        ))}
      </ul>
    </aside>
  )
}
