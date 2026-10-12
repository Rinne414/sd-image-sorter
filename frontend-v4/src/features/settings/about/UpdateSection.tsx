import { useState } from 'react'
import { useLang, useT } from '../../../i18n'
import { useSaved } from '../useSaved'
import styles from './About.module.css'
import { InstallDialog } from './InstallDialog'
import { ProxyPanel } from './ProxyPanel'
import { Section } from './Section'
import { notesLead, plainNotes, readUpdate, type UpdateView } from './updateState'
import { useUpdates } from './updateStore'

type Translate = ReturnType<typeof useT>

/** Updates: what the last check found, check / install, the check after start, the update proxy. */
export function UpdateSection() {
  const t = useT()
  const status = useUpdates((s) => s.status)
  const checking = useUpdates((s) => s.checking)
  const check = useUpdates((s) => s.check)
  const [installing, setInstalling] = useState(false)
  const [saved, mark] = useSaved<'auto'>()
  const view = readUpdate(status)
  const checkLabel = view.kind === 'unchecked' ? 'about.update.check' : view.kind === 'error' ? 'about.update.retry' : 'about.update.recheck'

  return (
    <Section title={t('about.update.title')} saved={saved === 'auto'} testId="about-update">
      <div className={styles.state} data-testid="update-state" data-kind={checking ? 'checking' : view.kind} aria-live="polite">
        {checking ? <p className={styles.lead}>{t('about.update.checking')}</p> : <ViewText view={view} t={t} />}
      </div>
      <div className={styles.row}>
        {view.kind === 'available' && (
          <button type="button" className="btn btn-primary" onClick={() => setInstalling(true)} disabled={checking} data-testid="update-install">
            {t('about.update.install')}
          </button>
        )}
        <button type="button" className="btn" onClick={() => void check(true)} disabled={checking} data-testid="update-check">
          {t(checking ? 'about.update.checking' : checkLabel)}
        </button>
        {(view.kind === 'available' || view.kind === 'manual') && view.url && (
          <a className="btn btn-ghost" href={view.url} target="_blank" rel="noopener noreferrer" data-testid="update-page">
            {t('about.update.page')} ↗
          </a>
        )}
      </div>
      <AutoCheck onSaved={() => mark('auto')} />
      <ProxyPanel openFirst={view.kind === 'error'} />
      {installing && view.kind === 'available' && <InstallDialog latest={view.latest} sizeBytes={view.sizeBytes} onClose={() => setInstalling(false)} />}
    </Section>
  )
}

function ViewText({ view, t }: { view: UpdateView; t: Translate }) {
  const lang = useLang((s) => s.lang)
  switch (view.kind) {
    case 'unchecked':
      return <p className={styles.lead}>{t('about.update.unchecked')}</p>
    case 'latest': {
      const time = view.checkedAt ? new Date(view.checkedAt * 1000).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) : ''
      const channel = t(view.defaultChannel ? 'about.update.channelDefault' : 'about.update.channelCustom')
      return (
        <>
          <p className={styles.lead}>{t('about.update.latest')}</p>
          {time && <p className={styles.hint}>{t('about.update.checkedAt', { time, channel })}</p>}
        </>
      )
    }
    case 'available':
      return (
        <>
          <p className={`${styles.lead} ${styles.news}`}>{t('about.update.available', { latest: view.latest, current: view.current })}</p>
          <Notes notes={view.notes} t={t} />
        </>
      )
    case 'manual':
      return (
        <>
          <p className={styles.lead}>{t('about.update.manual', { latest: view.latest, current: view.current })}</p>
          <Notes notes={view.notes} t={t} />
        </>
      )
    case 'error':
      return (
        <>
          <p className={styles.lead}>{t('about.update.error', { channel: t(view.defaultChannel ? 'about.update.channelDefault' : 'about.update.channelCustom') })}</p>
          {view.defaultChannel && <p className={styles.hint}>{t('about.update.errorGithub')}</p>}
          <details className={styles.detail}>
            <summary>{t('about.update.errorDetail')}</summary>
            <p className="mono">{view.reason}</p>
          </details>
        </>
      )
  }
}

/** The start of the release notes; "Show all" for the rest. */
function Notes({ notes, t }: { notes: string; t: Translate }) {
  const [all, setAll] = useState(false)
  const { lead, more } = notesLead(notes)
  if (!lead) return null
  return (
    <div className={styles.notes} data-testid="update-notes">
      <p className={styles.notesTitle}>{t('about.update.notes')}</p>
      <p className={styles.notesText} data-all={all || undefined}>
        {all ? plainNotes(notes) : lead}
      </p>
      {more && (
        <button type="button" className={`btn btn-ghost ${styles.more}`} onClick={() => setAll(!all)} aria-expanded={all} data-testid="update-notes-more">
          {t(all ? 'about.update.showLess' : 'about.update.showAll')}
        </button>
      )}
    </div>
  )
}

function AutoCheck({ onSaved }: { onSaved: () => void }) {
  const t = useT()
  const auto = useUpdates((s) => s.auto)
  const setAuto = useUpdates((s) => s.setAuto)
  return (
    <div className={styles.option}>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAuto(e.target.checked)
            onSaved()
          }}
          data-testid="update-auto"
        />
        {t('about.update.auto')}
      </label>
      <p className={styles.hint}>{t('about.update.autoHint')}</p>
    </div>
  )
}
