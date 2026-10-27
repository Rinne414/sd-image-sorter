import { useEffect, useRef, useState } from 'react'
import { api, unwrap } from '../../api/client'
import { thumbnailUrl } from '../../api/urls'
import type { components } from '../../api/schema'
import { rawJson } from '../../api/raw'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { useClickOutside, useLayer } from '../../ui/layers'
import { locateCount, locateEmptyNote, stepActive, type Note } from './lookups'
import { mapOnScreen, refresh, setPreview, showWholeLibrary, useMap } from './mapStore'
import { mapQuery, searchBody } from './mapRequest'
import { setMarker } from './nearStore'
import { getScene } from './sceneHandle'
import styles from './StyleMap.module.css'
import type { LocateAnswer, LocateResult } from './types'

const DEBOUNCE_MS = 350
const THUMB = 96

type TokenBody = components['schemas']['SelectionTokenRequest']

/** The box text as a selection token through the library's search language; null when it names nothing. */
async function searchToken(text: string): Promise<{ token: string | null; ignored: string[] }> {
  const { body, ignored } = searchBody(text)
  if (!body) return { token: null, ignored }
  const answer = unwrap<{ selection_token: string }>(await api.POST('/api/images/selection-token', { body: body as unknown as TokenBody }))
  return { token: answer.selection_token, ignored }
}

/**
 * "Find a picture" on the map, written in the library's search language
 * (file name, tag:, prompt:). The server keeps only pictures with a dot on
 * this map; picking one turns the camera to it, rings it and previews it.
 */
export function LocateBox() {
  const t = useT()
  const points = useMap((s) => s.points)
  const [text, setText] = useState('')
  const [answer, setAnswer] = useState<LocateAnswer | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [ignored, setIgnored] = useState<string[]>([])
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)
  const seq = useRef(0)
  /** The map a lost-map answer already rebuilt once (never in a loop, even when the server keeps losing it). */
  const rebuilt = useRef<string | null>(null)
  const timer = useRef(0)
  /** The text the answer on screen was found for (a newer text may still be waiting for its search). */
  const answeredFor = useRef<string | null>(null)
  /** Enter was pressed while the answer was for an older text: the new answer's first picture is taken. */
  const goOnAnswer = useRef(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const results = answer?.results ?? []
  const hasContent = answer !== null || note !== null
  const shown = open && hasContent
  useLayer(shown, () => setOpen(false))
  useClickOutside(boxRef, shown, () => setOpen(false))

  const search = async (query: string): Promise<void> => {
    const mine = ++seq.current
    setAnswer(null)
    setActive(-1)
    const map = mapOnScreen()
    if (!map) {
      setNote({ key: 'stylemap.locate.noMap', tone: 'info' })
      return
    }
    setNote({ key: 'stylemap.locate.working', tone: 'busy' })
    try {
      const { token, ignored: rest } = await searchToken(query)
      if (mine !== seq.current) return
      setIgnored(rest)
      if (!token) {
        setNote({ key: 'stylemap.locate.noTerms', tone: 'info' })
        return
      }
      const body = { space: map.scope.space, map_id: map.mapId, search_token: token }
      const found = await rawJson<LocateAnswer>('POST', `/api/style-map/locate?${mapQuery({ ...map.scope, token: null })}`, { body })
      if (mine !== seq.current) return
      if (found?.status === 'not_started') {
        if (rebuilt.current === map.signature) throw new Error(t('stylemap.lostMap'))
        rebuilt.current = map.signature
        // The new map's answer asks again (the effect below); without a new map, ask once more here.
        await refresh()
        if (mine === seq.current) await search(query)
        return
      }
      answeredFor.current = query
      // Enter was pressed before this answer came: go to its first picture now.
      const first = found.results?.[0]
      if (goOnAnswer.current && first) {
        goOnAnswer.current = false
        setAnswer(found)
        setActive(0)
        pick(first)
        return
      }
      goOnAnswer.current = false
      setAnswer(found)
      setNote((found.results ?? []).length ? null : locateEmptyNote(found))
      setActive((found.results ?? []).length ? 0 : -1)
    } catch (error) {
      if (mine === seq.current) setNote({ key: 'stylemap.locate.err', params: { error: (error as Error).message }, tone: 'error' })
    }
  }

  // A new map: the dots of the old answer are gone; a typed query asks again.
  useEffect(() => {
    seq.current += 1
    answeredFor.current = null
    setAnswer(null)
    setNote(null)
    setActive(-1)
    if (text.trim() && points) void search(text.trim())
    // Only a new map asks again (not every keystroke).
  }, [points])

  const onInput = (value: string) => {
    rebuilt.current = null
    goOnAnswer.current = false
    setText(value)
    setOpen(true)
    window.clearTimeout(timer.current)
    if (!value.trim()) {
      reset(false)
      return
    }
    timer.current = window.setTimeout(() => void search(value.trim()), DEBOUNCE_MS)
  }

  const reset = (clearText = true) => {
    seq.current += 1
    window.clearTimeout(timer.current)
    if (clearText) setText('')
    answeredFor.current = null
    goOnAnswer.current = false
    setAnswer(null)
    setNote(null)
    setIgnored([])
    setActive(-1)
    setMarker(null)
  }

  const pick = (item: LocateResult) => {
    getScene()?.flyTo([item.x, item.y, item.z], { id: item.id })
    setMarker({ kind: 'query', id: item.id, x: item.x, y: item.y, z: item.z })
    setPreview({ id: item.id, members: 1 })
    setOpen(false)
  }

  const move = (step: 1 | -1) => {
    const next = stepActive(active, step, results.length)
    setActive(next)
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return
      e.preventDefault()
      setOpen(true)
      move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      window.clearTimeout(timer.current)
      // The list on screen may still be the answer to the text before the last keystrokes: never take that one.
      const fresh = answeredFor.current === text.trim()
      const item = shown && fresh ? results[active] : undefined
      if (item) pick(item)
      else if (text.trim()) {
        goOnAnswer.current = !fresh
        setOpen(true)
        void search(text.trim())
      }
    }
  }

  const count = answer ? locateCount(answer) : null
  return (
    <div className={styles.locate} ref={boxRef} role="search" title={t('stylemap.locate.tip')} data-testid="stylemap-locate">
      <Icon name="search" size={14} />
      <input
        className={styles.locateInput}
        type="text"
        role="combobox"
        aria-label={t('stylemap.locate.label')}
        aria-expanded={shown}
        aria-controls="stylemap-locate-list"
        aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? `stylemap-locate-${active}` : undefined}
        placeholder={t('stylemap.locate.placeholder')}
        value={text}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => hasContent && setOpen(true)}
        data-testid="stylemap-locate-input"
      />
      {text && (
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          onClick={() => reset()}
          aria-label={t('stylemap.locate.clear')}
          title={t('stylemap.locate.clear')}
          data-testid="stylemap-locate-clear"
        >
          <Icon name="close" size={12} />
        </button>
      )}
      {shown && (
        <div className={styles.locatePop} onMouseDown={(e) => e.preventDefault()} data-testid="stylemap-locate-pop">
          {note && (
            <p className={styles.note} data-tone={note.tone} role="status">
              {t(note.key, note.params)}
            </p>
          )}
          {note?.action === 'showAll' && (
            <button type="button" className="btn btn-sm" onClick={showWholeLibrary} data-testid="stylemap-locate-action">
              {t('stylemap.near.showAll')}
            </button>
          )}
          {count && <p className={styles.locateCount}>{t(count.key, count.params)}</p>}
          {results.length > 0 && (
            <ul className={styles.locateList} id="stylemap-locate-list" role="listbox" ref={listRef}>
              {results.map((item, index) => (
                <li
                  key={item.id}
                  id={`stylemap-locate-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  className={styles.locateRow}
                  onClick={() => pick(item)}
                  onMouseMove={() => index !== active && setActive(index)}
                  data-testid="stylemap-locate-row"
                >
                  <img src={thumbnailUrl(item.id, THUMB)} alt="" loading="lazy" className={styles.locateThumb} />
                  <span className={styles.rowText}>
                    <span className={styles.rowName} title={item.filename ?? undefined}>
                      {item.filename || `#${item.id}`}
                    </span>
                    {item.merged && <span className={styles.rowFlag}>{t('stylemap.near.merged')}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {ignored.length > 0 && <p className={styles.locateFoot}>{t('stylemap.locate.ignored', { terms: ignored.join(', ') })}</p>}
        </div>
      )}
    </div>
  )
}
