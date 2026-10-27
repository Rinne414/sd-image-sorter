import { useState } from 'react'
import { useLang, useT } from '../../i18n'
import { copyText } from '../../lib/format'
import { useToasts } from '../../ui/toasts'
import { Section } from '../settings/about/Section'
import { explain } from './collectActions'
import { openInstallFolder, prepareInstallFolders, revokePairing, type InstallFolders } from './collectApi'
import { extensionId, pairingName, type PairingLike } from './collectLogic'
import styles from './ExtensionSection.module.css'
import { refreshPairedList, usePaired } from './pairedStore'

type Target = keyof InstallFolders

/**
 * Settings › Library › Browser extension: where to install the extension from,
 * and the browsers allowed to save pictures here (with Revoke). A pairing
 * request itself is answered in the prompt (CollectHost), wherever the user is.
 */
export function ExtensionSection() {
  const t = useT()
  const [folders, setFolders] = useState<InstallFolders | null>(null)
  const [failed, setFailed] = useState(false)

  const prepare = async () => {
    if (folders) return
    setFailed(false)
    try {
      setFolders(await prepareInstallFolders())
    } catch (error) {
      setFailed(true)
      useToasts.getState().push(explain(error, 'collect.ext.foldersFailed'), 'error')
    }
  }

  return (
    <Section title={t('collect.ext.title')} testId="ext-settings">
      <p className={styles.lead}>{t('collect.ext.lead')}</p>
      <details
        className={styles.install}
        data-testid="ext-install"
        onToggle={(e) => {
          if (e.currentTarget.open) void prepare()
        }}
      >
        <summary>{t('collect.ext.installTitle')}</summary>
        <div className={styles.cards}>
          <InstallCard target="chrome" folders={folders} failed={failed} retry={() => void prepare()} />
          <InstallCard target="firefox" folders={folders} failed={failed} retry={() => void prepare()} />
        </div>
        <p className={styles.hint}>{t('collect.ext.pairNote')}</p>
      </details>
      <PairedList />
    </Section>
  )
}

function InstallCard({ target, folders, failed, retry }: { target: Target; folders: InstallFolders | null; failed: boolean; retry: () => void }) {
  const t = useT()
  const path = folders?.[target] ?? null
  const steps =
    target === 'chrome'
      ? (['collect.ext.chromeStep1', 'collect.ext.chromeStep2', 'collect.ext.chromeStep3'] as const)
      : (['collect.ext.firefoxStep1', 'collect.ext.firefoxStep2', 'collect.ext.firefoxStep3'] as const)

  const copy = async () => {
    if (!path) return
    const ok = await copyText(path)
    useToasts.getState().push(ok ? t('collect.ext.pathCopied') : t('collect.ext.copyFailed'), ok ? 'info' : 'error')
  }
  const open = async () => {
    try {
      await openInstallFolder(target)
    } catch (error) {
      useToasts.getState().push(explain(error, 'collect.ext.openFailed'), 'error')
    }
  }

  return (
    <div className={styles.card} data-testid={`ext-card-${target}`}>
      <strong>{target === 'chrome' ? t('collect.ext.chromeTitle') : t('collect.ext.firefoxTitle')}</strong>
      <ol>
        {steps.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ol>
      <div className={styles.pathRow}>
        <code className={`${styles.path} mono`} data-testid={`ext-path-${target}`}>
          {path ?? (failed ? t('collect.ext.foldersFailed') : t('collect.ext.preparing'))}
        </code>
        {failed && !path ? (
          <button type="button" className="btn btn-ghost" onClick={retry}>
            {t('common.retry')}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => void copy()} disabled={!path} data-testid={`ext-copy-${target}`}>
              {t('collect.ext.copyPath')}
            </button>
            <button type="button" className="btn" onClick={() => void open()} disabled={!path} data-testid={`ext-open-${target}`}>
              {t('collect.ext.openFolder')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function whenText(value: string | null | undefined, lang: string): string {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(lang, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function PairedList() {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const paired = usePaired()
  const other = t('collect.ext.browserOther')
  const [busy, setBusy] = useState<string | null>(null)

  const revoke = async (item: PairingLike) => {
    setBusy(item.id)
    try {
      await revokePairing(item.id)
      useToasts.getState().push(t('collect.ext.revokedToast', { name: item.name }))
    } catch (error) {
      useToasts.getState().push(explain(error, 'collect.ext.revokeFailed'), 'error')
    }
    setBusy(null)
    refreshPairedList()
  }

  return (
    <div className={styles.paired}>
      <h4 className={styles.pairedTitle}>{t('collect.ext.pairedTitle')}</h4>
      {paired.isError ? (
        <p className={styles.hint} role="alert">
          {t('collect.ext.pairedFailed')}
        </p>
      ) : !paired.data ? null : paired.data.length === 0 ? (
        <p className={styles.hint} data-testid="ext-paired-none">
          {t('collect.ext.pairedNone')}
        </p>
      ) : (
        <ul className={styles.list} data-testid="ext-paired-list">
          {paired.data.map((item) => (
            <li key={item.id} className={styles.item} data-testid="ext-paired-item">
              <span className={styles.name}>{pairingName(item, other)}</span>
              <code className={`${styles.id} mono`} title={t('collect.ext.idTitle')}>
                {extensionId(item) || t('collect.ext.idNone')}
              </code>
              <span className={styles.when}>{t('collect.ext.pairedOn', { when: whenText(item.paired_at, lang) })}</span>
              <button type="button" className="btn btn-ghost" onClick={() => void revoke(item)} disabled={busy === item.id} data-testid="ext-revoke">
                {t('collect.ext.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
