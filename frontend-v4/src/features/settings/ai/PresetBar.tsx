import { useId, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../../i18n'
import { useLayer } from '../../../ui/layers'
import styles from './Ai.module.css'
import { usePresets } from './aiApi'
import { isAiKey, useAT } from './aiText'
import { cleanName, isEdited, isOwn, ownNamed, promptFields, readRefusal, restoreBody, splitPresets, type Refusal } from './presets'
import { createPreset, deletePreset, renamePreset, restorePreset, updatePreset } from './presetsApi'
import type { Preset } from './types'
import type { VlmDraft } from './useVlmDraft'
import { applyPreset } from './vlmForm'

type Mode = 'idle' | 'create' | 'rename'
type Tone = 'ok' | 'error' | 'info'

interface Status {
  text: string
  tone: Tone
  /** Offered beside the text; `stillValid` ends the offer (an Undo of an applied preset must not undo what was typed since). */
  undo?: { run: () => Promise<void>; stillValid?: () => boolean }
}

interface Replace {
  id: string
  name: string
}

/** The preset list of Settings > AI: choose and apply one, save the prompts as a new one, save edits into one of yours, rename it, delete it (Undo brings it back). */
export function PresetBar({ draft }: { draft: VlmDraft }) {
  const at = useAT()
  const t = useT()
  const selectId = useId()
  const nameId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const list = usePresets()
  const presets = list.data?.presets ?? {}
  const { form, set } = draft

  const [chosen, setChosen] = useState('')
  /** The preset the boxes came from or were saved into last. */
  const [loaded, setLoaded] = useState('')
  const [mode, setMode] = useState<Mode>('idle')
  const [name, setName] = useState('')
  const [replace, setReplace] = useState<Replace | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const draftNow = useRef(form)
  draftNow.current = form

  const split = splitPresets(presets)
  const current: Preset | undefined = split.builtin.concat(split.mine).find(([id]) => id === chosen)?.[1]
  const mine = isOwn(current)
  const loadedPreset = presets[loaded]
  const edited = isEdited(form, loadedPreset)
  const canSaveChanges = mine && chosen === loaded && edited
  const asking = mode !== 'idle' || replace !== null

  const baseLabel = (id: string, p: Preset) => {
    const key = `ai.preset.${id}`
    return !isOwn(p) && isAiKey(key) ? at(key) : p.name
  }
  const labelOf = (id: string, p: Preset) => (id === loaded && edited ? t('aipresets.edited', { name: baseLabel(id, p) }) : baseLabel(id, p))

  const closeAsk = () => {
    setMode('idle')
    setReplace(null)
  }
  // Esc steps back one level (the replace question, then the name field) and never closes the page behind it
  useLayer(asking, () => (replace ? setReplace(null) : closeAsk()))

  const say = (text: string, tone: Tone = 'ok', undo?: Status['undo']) => setStatus({ text, tone, ...(undo ? { undo } : {}) })

  /** Run one change; a refusal that is not handled by `onTaken` is said in words. */
  const attempt = async (failKey: MessageKey, work: () => Promise<void>, onTaken?: (r: Extract<Refusal, { kind: 'taken' }>) => void) => {
    setBusy(true)
    try {
      await work()
    } catch (error) {
      const refusal = readRefusal(error)
      if (refusal.kind === 'taken') {
        if (onTaken) onTaken(refusal)
        else say(t('aipresets.err.taken', { name: refusal.name }), 'error')
      } else if (refusal.kind === 'text') say(t(refusal.key), 'error')
      else say(t(failKey, { reason: refusal.message }), 'error')
    } finally {
      setBusy(false)
    }
  }

  const apply = () => {
    if (!current) return
    const before = { systemPrompt: form.systemPrompt, userPrompt: form.userPrompt, userPromptWithTags: form.userPromptWithTags }
    const wasLoaded = loaded
    const label = baseLabel(chosen, current)
    const next = applyPreset(form, current)
    set(() => next)
    setLoaded(chosen)
    const changed = before.systemPrompt !== next.systemPrompt || before.userPrompt !== next.userPrompt || before.userPromptWithTags !== next.userPromptWithTags
    const undo = changed
      ? {
          run: async () => {
            set(before)
            setLoaded(wasLoaded)
            say(t('aipresets.promptsRestored'), 'info')
          },
          // typing after the preset went in makes Undo stale: it would throw the typing away
          stillValid: () => !isEdited(draftNow.current, current),
        }
      : undefined
    setStatus({ text: at('ai.preset.applied', { name: label }), tone: 'info', ...(undo ? { undo } : {}) })
  }

  const openName = (next: Mode) => {
    setReplace(null)
    setStatus(null)
    setName(next === 'rename' && current ? current.name : '')
    setMode(next)
  }

  const submitName = () => {
    const clean = cleanName(name)
    if (!clean) {
      say(t('aipresets.name.required'), 'info')
      nameRef.current?.focus()
      return
    }
    if (mode === 'rename') void rename(clean)
    else void create(clean)
  }

  const create = (clean: string) =>
    attempt(
      'aipresets.fail.save',
      async () => {
        const made = await createPreset(clean, promptFields(form))
        closeAsk()
        setChosen(made.id ?? '')
        setLoaded(made.id ?? '')
        say(t('aipresets.saved', { name: made.name }))
      },
      (taken) => setReplace({ id: taken.existingId, name: taken.name || ownNamed(presets, clean)?.[1].name || clean }),
    )

  const overwrite = (id: string) =>
    attempt('aipresets.fail.save', async () => {
      const saved = await updatePreset(id, promptFields(form))
      closeAsk()
      setChosen(id)
      setLoaded(id)
      say(t('aipresets.updated', { name: saved.name }))
    })

  const rename = (clean: string) =>
    attempt('aipresets.fail.rename', async () => {
      if (!current || cleanName(current.name) === clean) {
        closeAsk()
        return
      }
      const renamed = await renamePreset(chosen, clean)
      closeAsk()
      say(t('aipresets.renamed', { name: renamed.name }))
    })

  const remove = () =>
    attempt('aipresets.fail.delete', async () => {
      const gone = await deletePreset(chosen)
      closeAsk()
      setChosen('')
      if (loaded === gone.id) setLoaded('')
      // the prompts stay in the boxes; Undo puts the preset itself back
      say(t('aipresets.deleted', { name: gone.name }), 'info', {
        run: () =>
          attempt('aipresets.fail.restore', async () => {
            const back = await restorePreset(restoreBody(gone))
            setChosen(back.id ?? '')
            setLoaded(back.id ?? '')
            say(t('aipresets.restored', { name: back.name }))
          }),
      })
    })

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={selectId}>
        {at('ai.preset')}
      </label>
      <div className={styles.inline}>
        <select id={selectId} className={styles.select} value={chosen} onChange={(e) => setChosen(e.target.value)} data-testid="vlm-preset">
          <option value="">{at('ai.preset.choose')}</option>
          <optgroup label={t('aipresets.group.builtin')}>
            {split.builtin.map(([id, p]) => (
              <option key={id} value={id}>
                {labelOf(id, p)}
              </option>
            ))}
          </optgroup>
          {split.mine.length > 0 && (
            <optgroup label={t('aipresets.group.mine')} data-testid="vlm-preset-mine">
              {split.mine.map(([id, p]) => (
                <option key={id} value={id}>
                  {labelOf(id, p)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button type="button" className="btn" onClick={apply} disabled={!chosen || busy} data-testid="vlm-preset-apply">
          {at('ai.preset.apply')}
        </button>
      </div>
      <div className={styles.row} data-testid="vlm-preset-actions">
        <button type="button" className="btn btn-ghost" onClick={() => openName('create')} disabled={busy} data-testid="vlm-preset-save-as">
          {t('aipresets.saveNew')}
        </button>
        {canSaveChanges && current && (
          <button type="button" className="btn btn-ghost" onClick={() => void overwrite(chosen)} disabled={busy} data-testid="vlm-preset-save">
            {t('aipresets.saveChanges', { name: current.name })}
          </button>
        )}
        {mine && (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => openName('rename')} disabled={busy} data-testid="vlm-preset-rename">
              {t('aipresets.rename')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void remove()} disabled={busy} data-testid="vlm-preset-delete">
              {t('aipresets.delete')}
            </button>
          </>
        )}
      </div>
      {mode !== 'idle' && replace === null && (
        <form
          key={mode}
          className={styles.inline}
          onSubmit={(e) => {
            e.preventDefault()
            submitName()
          }}
          data-testid="vlm-preset-name-row"
        >
          <input
            ref={nameRef}
            id={nameId}
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('aipresets.name.placeholder')}
            aria-label={t('aipresets.name.label')}
            spellCheck={false}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            data-testid="vlm-preset-name"
          />
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="vlm-preset-name-ok">
            {t(mode === 'rename' ? 'aipresets.name.rename' : 'aipresets.name.save')}
          </button>
          <button type="button" className="btn" onClick={closeAsk} data-testid="vlm-preset-name-cancel">
            {t('aipresets.name.cancel')}
          </button>
        </form>
      )}
      {replace !== null && (
        <div className={styles.replace} role="group" aria-label={t('aipresets.replace.yes')} data-testid="vlm-preset-replace">
          <p className={styles.replaceText}>{t('aipresets.replace.text', { name: replace.name })}</p>
          <div className={styles.inline}>
            <button type="button" className="btn" onClick={() => setReplace(null)} autoFocus data-testid="vlm-preset-replace-cancel">
              {t('aipresets.name.cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void overwrite(replace.id)} disabled={busy} data-testid="vlm-preset-replace-yes">
              {t('aipresets.replace.yes')}
            </button>
          </div>
        </div>
      )}
      {list.data?.problem && (
        <p className={styles.note} data-tone="error" role="status" data-testid="vlm-preset-problem">
          {t('aipresets.problem', { reason: list.data.problem })}
        </p>
      )}
      {status && (
        <div className={styles.statusRow}>
          <p className={styles.note} data-tone={status.tone} role="status" data-testid="vlm-preset-note">
            {status.text}
          </p>
          {status.undo && (status.undo.stillValid?.() ?? true) && (
            <button type="button" className="btn btn-ghost" onClick={() => void status.undo?.run()} disabled={busy} data-testid="vlm-preset-undo">
              {t('aipresets.undo')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
