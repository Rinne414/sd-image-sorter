import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useT } from '../../../i18n'
import styles from './About.module.css'
import { CHANNEL_KEY, saveProxy, useChannel } from './aboutApi'
import { useUpdates } from './updateStore'

type Note = { text: string; tone: 'ok' | 'error' }

/**
 * The update proxy, folded away unless one is set or the last check could not
 * reach the update source. Saving it empty (or "Back to official GitHub")
 * removes it.
 */
export function ProxyPanel({ openFirst }: { openFirst: boolean }) {
  const t = useT()
  const inputId = useId()
  const queryClient = useQueryClient()
  const channel = useChannel()
  const [edited, setEdited] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [saving, setSaving] = useState(false)
  const override = channel.data?.has_channel_override === true
  const value = edited ?? (override ? (channel.data?.download_url_prefix ?? '') : '')
  const now = override ? `${t('about.update.channelCustom')} · ${channel.data?.download_url_prefix ?? ''}` : t('about.update.channelDefault')
  // opens by itself when it is needed; after that the user folds it
  const wanted = openFirst || override
  const [open, setOpen] = useState(wanted)
  useEffect(() => {
    if (wanted) setOpen(true)
  }, [wanted])

  const save = async (prefix: string) => {
    if (prefix && !/^https:\/\//i.test(prefix)) {
      setNote({ text: t('about.proxy.needHttps'), tone: 'error' })
      return
    }
    setSaving(true)
    try {
      queryClient.setQueryData(CHANNEL_KEY, await saveProxy(prefix))
      setEdited(null)
      setNote({ text: t(prefix ? 'about.proxy.saved' : 'about.proxy.resetDone'), tone: 'ok' })
      // what the old source said no longer holds
      useUpdates.getState().forget()
    } catch (error) {
      setNote({ text: t('about.proxy.failed', { reason: (error as Error).message }), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <details className={styles.proxy} open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-testid="update-proxy">
      <summary>
        <span className={styles.proxyTitle}>{t('about.proxy.title')}</span>
        <span className={styles.proxyNow}>{channel.isError ? t('about.proxy.loadFailed', { reason: channel.error.message }) : t('about.proxy.now', { channel: now })}</span>
      </summary>
      <div className={styles.proxyBody}>
        <label className={styles.fieldLabel} htmlFor={inputId}>
          {t('about.proxy.label')}
        </label>
        <input
          id={inputId}
          className={`${styles.input} mono`}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('about.proxy.placeholder')}
          value={value}
          onChange={(e) => setEdited(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save(value.trim())}
          disabled={saving || channel.isPending}
          data-testid="proxy-input"
        />
        <p className={styles.hint}>{t('about.proxy.hint')}</p>
        <div className={styles.row}>
          <button type="button" className="btn" onClick={() => void save(value.trim())} disabled={saving || channel.isPending} data-testid="proxy-save">
            {t('about.proxy.save')}
          </button>
          {override && (
            <button type="button" className="btn btn-ghost" onClick={() => void save('')} disabled={saving} data-testid="proxy-reset">
              {t('about.proxy.reset')}
            </button>
          )}
        </div>
        {note && (
          <p className={styles.note} data-tone={note.tone} role="status" data-testid="proxy-note">
            {note.text}
          </p>
        )}
      </div>
    </details>
  )
}
