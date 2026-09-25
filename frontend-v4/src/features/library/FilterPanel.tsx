import { useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { isAnyOf, isKey, replaceTokens, toggleToken, valueOf, hasPart } from '../../lib/queryEdit'
import { HUE_VALUES, parseSearch, type Part } from '../../lib/searchQuery'
import { useSavedSearches } from '../../state/savedSearches'
import { useApp } from '../../state/store'
import { useClickOutside, useLayer } from '../../ui/layers'
import { useToasts } from '../../ui/toasts'
import styles from './FilterPanel.module.css'

interface Props {
  text: string
  onChange: (next: string) => void
}

interface Choice {
  value: string | null
  label: string
}

const TONES = ['warm', 'cool', 'neutral']

const HUE_SWATCH: Record<string, string> = {
  red: '#d2463c',
  orange: '#e0863a',
  yellow: '#e5c440',
  green: '#5ba55a',
  cyan: '#46b3b8',
  blue: '#3f74c9',
  purple: '#8a5cc7',
  pink: '#e27aa8',
  brown: '#8a5a3b',
  white: '#f2efe9',
  black: '#1b1a18',
  gray: '#8d8a85',
}

/** Structured filters. Every choice is written into the query line above. */
export function FilterPanel({ text, onChange }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const libraryId = useApp((s) => s.libraryId)
  const addSaved = useSavedSearches((s) => s.add)
  useLayer(open, () => setOpen(false))
  useClickOutside(ref, open, () => setOpen(false))

  const parts = parseSearch(text).parts
  const active = parts.filter((p) => p.kind === 'filter').length

  const single = (key: string, choices: Choice[], toToken: (v: string) => string, read: () => string | null) => {
    const current = read()
    return (
      <div className={styles.choices}>
        {choices.map((c) => (
          <button
            key={c.value ?? 'any'}
            type="button"
            className={styles.choice}
            aria-pressed={current === c.value}
            onClick={() => onChange(replaceTokens(text, isKey(key), c.value === null ? [] : [toToken(c.value)]))}
          >
            {c.label}
          </button>
        ))}
      </div>
    )
  }

  const any = t('filter.any')
  const scoreNow = hasPart(parts, isKey('score', 'none')) ? 'none' : (valueOf(parts, 'score') ?? null)
  const paramsNow = hasPart(parts, isKey('has', 'params')) ? 'has' : hasPart(parts, isKey('no', 'params')) ? 'no' : null
  const isTone = (p: Part) => p.kind === 'filter' && p.key === 'color' && TONES.includes(p.value)
  const toneNow = parts.find(isTone)?.kind === 'filter' ? (parts.find(isTone) as { value: string }).value : null
  const dateNow = (() => {
    const v = valueOf(parts, 'date')
    if (!v) return null
    const q = parseSearch(text)
    const token = parts.find((p) => p.kind === 'filter' && p.key === 'date')
    const raw = token ? (q.tokens[token.token] ?? '').toLowerCase() : ''
    for (const d of ['today', '7d', '30d']) if (raw.endsWith(`:${d}`)) return d
    return 'custom'
  })()

  const save = () => {
    const clean = name.trim()
    if (!clean || !text.trim()) return
    addSaved(libraryId, clean, text.trim())
    setName('')
    useToasts.getState().push(t('filter.saved', { name: clean }))
  }

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className="btn"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="filter-button"
      >
        {t('filter.button')}
        {active > 0 && <span className={`${styles.badge} mono`}>{active}</span>}
      </button>
      {open && (
        <div className={styles.panel} role="dialog" aria-label={t('filter.button')} data-testid="filter-panel">
          <p className={styles.hint}>{t('filter.hint')}</p>
          <dl className={styles.rows}>
            <Row label={t('filter.rating')}>
              <div className={styles.choices}>
                {(['general', 'sensitive', 'questionable', 'explicit'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={styles.choice}
                    aria-pressed={hasPart(parts, isKey('rating', r))}
                    onClick={() => onChange(toggleToken(text, isKey('rating', r), `rating:${r}`))}
                  >
                    {t(`rating.${r}` as MessageKey)}
                  </button>
                ))}
              </div>
            </Row>
            <Row label={t('filter.stars')}>
              {single(
                'stars',
                [{ value: null, label: any }, ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `★${n}+` }))],
                (v) => `★${v}`,
                () => valueOf(parts, 'stars'),
              )}
            </Row>
            <Row label={t('filter.score')}>
              <div className={styles.choices}>
                {[
                  { value: null, label: any },
                  { value: '5', label: '5+' },
                  { value: '7', label: '7+' },
                  { value: 'none', label: t('filter.scoreUnscored') },
                ].map((c) => (
                  <button
                    key={c.value ?? 'any'}
                    type="button"
                    className={styles.choice}
                    aria-pressed={scoreNow === c.value}
                    onClick={() =>
                      onChange(replaceTokens(text, isKey('score'), c.value === null ? [] : [c.value === 'none' ? 'score:none' : `score>=${c.value}`]))
                    }
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </Row>
            <Row label={t('filter.aspect')}>
              {single(
                'aspect',
                [
                  { value: null, label: any },
                  { value: 'square', label: t('filter.aspect.square') },
                  { value: 'portrait', label: t('filter.aspect.portrait') },
                  { value: 'landscape', label: t('filter.aspect.landscape') },
                ],
                (v) => `aspect:${v}`,
                () => valueOf(parts, 'aspect'),
              )}
            </Row>
            <Row label={t('filter.params')}>
              <div className={styles.choices}>
                {[
                  { value: null, label: any },
                  { value: 'has', label: t('filter.params.has') },
                  { value: 'no', label: t('filter.params.no') },
                ].map((c) => (
                  <button
                    key={c.value ?? 'any'}
                    type="button"
                    className={styles.choice}
                    aria-pressed={paramsNow === c.value}
                    onClick={() =>
                      onChange(
                        replaceTokens(
                          text,
                          isAnyOf(isKey('has', 'params'), isKey('no', 'params')),
                          c.value === null ? [] : [`${c.value}:params`],
                        ),
                      )
                    }
                  >
                    {c.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={styles.choice}
                  aria-pressed={hasPart(parts, isKey('no', 'caption'))}
                  onClick={() => onChange(toggleToken(text, isKey('no', 'caption'), 'no:caption'))}
                >
                  {t('filter.noCaption')}
                </button>
              </div>
            </Row>
            <Row label={t('filter.date')}>
              <div className={styles.choices}>
                {[
                  { value: null, label: any },
                  { value: 'today', label: t('filter.date.today') },
                  { value: '7d', label: t('filter.date.7d') },
                  { value: '30d', label: t('filter.date.30d') },
                ].map((c) => (
                  <button
                    key={c.value ?? 'any'}
                    type="button"
                    className={styles.choice}
                    aria-pressed={dateNow === c.value}
                    onClick={() => onChange(replaceTokens(text, isKey('date'), c.value === null ? [] : [`date:${c.value}`]))}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </Row>
            <Row label={t('filter.color')}>
              <div className={styles.choices}>
                {[
                  { value: null, label: any },
                  { value: 'warm', label: t('filter.tone.warm') },
                  { value: 'cool', label: t('filter.tone.cool') },
                  { value: 'neutral', label: t('filter.tone.neutral') },
                ].map((c) => (
                  <button
                    key={c.value ?? 'any'}
                    type="button"
                    className={styles.choice}
                    aria-pressed={toneNow === c.value}
                    // tones and hues share the color: key; only replace the tone
                    onClick={() => onChange(replaceTokens(text, isTone, c.value === null ? [] : [`color:${c.value}`]))}
                  >
                    {c.label}
                  </button>
                ))}
                <span className={styles.swatches}>
                  {HUE_VALUES.map((h) => (
                    <button
                      key={h}
                      type="button"
                      className={styles.swatch}
                      style={{ background: HUE_SWATCH[h] }}
                      aria-pressed={hasPart(parts, isKey('color', h))}
                      title={t(`filter.hue.${h}` as MessageKey)}
                      aria-label={t(`filter.hue.${h}` as MessageKey)}
                      onClick={() => onChange(toggleToken(text, isKey('color', h), `color:${h}`))}
                    />
                  ))}
                </span>
              </div>
            </Row>
          </dl>
          <footer className={styles.footer}>
            <input
              className={styles.name}
              value={name}
              placeholder={t('filter.saveName')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              data-testid="filter-save-name"
            />
            <button type="button" className="btn" onClick={save} disabled={!name.trim() || !text.trim()}>
              {t('filter.save')}
            </button>
            <span className={styles.gap} />
            <button type="button" className="btn btn-ghost" onClick={() => onChange('')} disabled={!text.trim()}>
              {t('filter.clear')}
            </button>
          </footer>
        </div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
