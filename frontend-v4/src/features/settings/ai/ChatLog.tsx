import { useEffect, useRef, useState } from 'react'
import { Section } from '../about/Section'
import styles from './Ai.module.css'
import { readChatLog } from './aiApi'
import { useAT, type AiKey } from './aiText'
import type { ChatEvent } from './types'

type Load = { state: 'idle' | 'loading' } | { state: 'error'; reason: string } | { state: 'done'; events: ChatEvent[] }

const PHASE: Record<string, AiKey> = { request: 'ai.log.request', response: 'ai.log.response', error: 'ai.log.error' }

/** The API chat log of batch captioning, read when it is unfolded (a tool for finding out why a model answered oddly). */
export function ChatLog() {
  const t = useAT()
  const [load, setLoad] = useState<Load>({ state: 'idle' })
  const list = useRef<HTMLDivElement>(null)

  const read = async () => {
    setLoad({ state: 'loading' })
    try {
      setLoad({ state: 'done', events: await readChatLog() })
    } catch (error) {
      setLoad({ state: 'error', reason: (error as Error).message })
    }
  }

  // the newest call is at the bottom, where the reading starts
  useEffect(() => {
    if (load.state === 'done' && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [load])

  return (
    <Section title={t('ai.log.title')} testId="ai-log">
      <p className={styles.hint}>{t('ai.log.lead')}</p>
      <details
        className={styles.fold}
        onToggle={(e) => {
          if (e.currentTarget.open && load.state === 'idle') void read()
        }}
        data-testid="ai-log-fold"
      >
        <summary>{t('ai.log.show')}</summary>
        <div className={styles.foldBody}>
          <button type="button" className="btn" onClick={() => void read()} disabled={load.state === 'loading'} data-testid="ai-log-refresh">
            {t('ai.log.refresh')}
          </button>
          {load.state === 'loading' && <p className={styles.hint}>{t('ai.log.loading')}</p>}
          {load.state === 'error' && (
            <p className={styles.note} data-tone="error">
              {t('ai.log.failed', { reason: load.reason })}
            </p>
          )}
          {load.state === 'done' && load.events.length === 0 && <p className={styles.hint}>{t('ai.log.empty')}</p>}
          {load.state === 'done' && load.events.length > 0 && (
            <div ref={list} className={styles.log} data-testid="ai-log-list">
              {load.events.map((e) => (
                <Entry key={e.id} event={e} />
              ))}
            </div>
          )}
        </div>
      </details>
    </Section>
  )
}

function Entry({ event: e }: { event: ChatEvent }) {
  const t = useAT()
  const phase = e.phase ?? ''
  const image = e.image_name || (e.image_id ? `#${e.image_id}` : '')
  const meta = [e.provider, e.model, image, e.latency_ms ? t('ai.log.ms', { n: e.latency_ms }) : '', e.tokens_used ? t('ai.log.tokens', { n: e.tokens_used }) : '', e.at ?? '']
    .filter(Boolean)
    .join(' · ')
  const tags = Array.isArray(e.tags) && e.tags.length ? e.tags.join(', ') : ''
  const fields: [string, string][] = [
    ['System', e.system_prompt ?? ''],
    ['User', e.user_prompt ?? ''],
    [t(phase === 'request' ? 'ai.log.tags' : 'ai.log.replyTags'), tags],
    [t('ai.log.reply'), e.caption ?? ''],
    [t('ai.log.raw'), e.raw_text && e.raw_text !== e.caption ? e.raw_text : ''],
    [e.error_type ? `${t('ai.log.errorText')} (${e.error_type})` : t('ai.log.errorText'), e.error ?? ''],
  ]
  return (
    <div className={styles.event} data-testid="ai-log-event">
      <p className={styles.eventHead}>
        <span className={styles.phase} data-phase={phase}>
          {PHASE[phase] ? t(PHASE[phase]) : phase}
        </span>
        <span className={`${styles.eventMeta} mono`}>{meta}</span>
      </p>
      {fields
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className={styles.eventField}>
            <span className={styles.eventLabel}>{label}</span>
            <pre>{value}</pre>
          </div>
        ))}
    </div>
  )
}
