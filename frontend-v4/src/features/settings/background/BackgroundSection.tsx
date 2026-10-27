import { useState } from 'react'
import { useT } from '../../../i18n'
import { useToasts } from '../../../ui/toasts'
import { Section } from '../about/Section'
import { SettingRow } from '../SettingRow'
import { useSaved } from '../useSaved'
import { describeLoaded, describeNote, idleOptions, unloadMessages } from './background'
import styles from './Background.module.css'
import { saveIdleMinutes, unloadModelsNow, useBackgroundModels } from './backgroundApi'

const clock = (epochSeconds: number) => new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Settings › Models › Background: which AI models are loaded, when an unused one is freed, and Unload now. */
export function BackgroundSection() {
  const t = useT()
  const query = useBackgroundModels()
  const [saved, mark] = useSaved<'idle'>()
  const [busy, setBusy] = useState(false)
  const state = query.data
  const push = useToasts.getState().push
  const problem = (error: unknown) => push(error instanceof Error ? error.message : String(error), 'error')

  const onIdle = async (minutes: number) => {
    try {
      await saveIdleMinutes(minutes)
      mark('idle')
    } catch (error) {
      problem(error)
      void query.refetch()
    }
  }

  const onUnload = async () => {
    setBusy(true)
    try {
      for (const text of unloadMessages(await unloadModelsNow(), t)) push(text)
    } catch (error) {
      problem(error)
      void query.refetch()
    } finally {
      setBusy(false)
    }
  }

  const note = state ? describeNote(state, t, clock) : ''
  const status = state ? describeLoaded(state, t) : query.isError ? t('desktop.bg.loadFailed') : ''

  return (
    <Section title={t('desktop.bg.title')} saved={saved === 'idle'} testId="background-models">
      <SettingRow
        title={t('desktop.bg.idleLabel')}
        body={
          <>
            <span data-testid="background-status" role="status" data-tone={query.isError && !state ? 'error' : undefined}>
              {status}
            </span>
            {note && (
              <span className={styles.note} data-testid="background-note">
                {note}
              </span>
            )}
          </>
        }
      >
        <select
          className={styles.select}
          value={state?.idle_unload_minutes ?? ''}
          disabled={!state}
          aria-label={t('desktop.bg.idleLabel')}
          onChange={(e) => void onIdle(Number(e.target.value))}
          data-testid="background-idle"
        >
          {state ? (
            idleOptions(state.idle_unload_minutes).map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.label, { minutes: o.value })}
              </option>
            ))
          ) : (
            <option value="" />
          )}
        </select>
        <button type="button" className="btn" disabled={busy || !state || state.models.length === 0} onClick={() => void onUnload()} data-testid="background-unload">
          {t('desktop.bg.unload')}
        </button>
      </SettingRow>
    </Section>
  )
}
