import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { saveComfyAddress, useComfySetting } from './generatorApi'
import styles from './Generator.module.css'
import { saidError } from './recipeText'

type Note = { text: string; tone: 'ok' | 'error' }

/**
 * The ComfyUI address: a field that saves when it is left or Enter is pressed,
 * and a button back to the default. One component for Settings and the dialog.
 */
export function ComfyAddress({ onSaved, testId = 'comfy-address' }: { onSaved?: () => void; testId?: string }) {
  const t = useT()
  const setting = useComfySetting()
  const saved = setting.data?.custom_url ?? ''
  const [draft, setDraft] = useState(saved)
  const [note, setNote] = useState<Note | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // What is stored shows in the field, unless the user is typing in it.
  useEffect(() => {
    if (document.activeElement !== input.current) setDraft(saved)
  }, [saved])

  const save = async (value: string) => {
    const next = value.trim()
    if (next === saved) {
      setDraft(saved)
      return
    }
    setBusy(true)
    try {
      await saveComfyAddress(next)
      setNote({ text: t('generator.address.saved'), tone: 'ok' })
      onSaved?.()
    } catch (error) {
      // A refused address must not stay in the field as if it were in force.
      setDraft(saved)
      setNote({ text: t('generator.address.refused', { reason: saidError(t, error, 'address').message }), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (setting.isError) {
    return (
      <div className={styles.address} data-testid={testId}>
        <p className={styles.note} data-tone="error">
          {t('generator.address.loadFailed', { reason: saidError(t, setting.error, 'read').message })}
        </p>
        <div>
          <button type="button" className="btn btn-sm" onClick={() => void setting.refetch()}>
            {t('common.retry')}
          </button>
        </div>
      </div>
    )
  }

  const defaultUrl = setting.data?.default_url ?? ''
  const inForce = setting.data?.url ?? null
  return (
    <div className={styles.address} data-testid={testId}>
      <div className={styles.addressRow}>
        <input
          ref={input}
          className={`input mono ${styles.addressInput}`}
          type="text"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          placeholder={defaultUrl}
          aria-label={t('generator.address.label')}
          disabled={!setting.data || busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save(draft)
          }}
          data-testid={`${testId}-input`}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={!setting.data || busy || (saved === '' && draft === '')}
          title={t('generator.address.resetTip', { url: defaultUrl })}
          onClick={() => void save('')}
          data-testid={`${testId}-reset`}
        >
          {t('generator.address.reset')}
        </button>
      </div>
      <p className={styles.note} data-tone={note?.tone} role="status" data-testid={`${testId}-note`}>
        {note ? note.text : inForce ? t('generator.address.using', { url: inForce }) : ''}
      </p>
    </div>
  )
}
