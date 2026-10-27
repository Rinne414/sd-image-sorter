import { useEffect, useRef } from 'react'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { useToasts } from '../../ui/toasts'
import { decidePairing } from './collectApi'
import { explain, refreshLibraryLists, saveOfferedUrl } from './collectActions'
import { browserName, extensionId, hostOf, pairingName, type PairingLike } from './collectLogic'
import { useCollect } from './collectState'
import { startCollectWatch } from './collectWatch'
import styles from './CollectHost.module.css'
import { refreshPairedList } from './pairedStore'

/**
 * Mounted once in each shell: watches the browser extension (a pairing request
 * opens its prompt wherever the user is) and asks before downloading a pasted
 * picture address.
 */
export function CollectHost() {
  useEffect(() => startCollectWatch(refreshLibraryLists), [])
  const offeredUrl = useCollect((s) => s.offeredUrl)
  const pairing = useCollect((s) => s.pairing)
  return (
    <>
      {offeredUrl && <UrlDialog url={offeredUrl} />}
      {pairing && <PairingDialog request={pairing} />}
    </>
  )
}

function UrlDialog({ url }: { url: string }) {
  const t = useT()
  const saveRef = useRef<HTMLButtonElement>(null)
  const close = () => useCollect.getState().clearOffer()
  return (
    <Dialog
      title={t('collect.url.title')}
      onClose={close}
      testId="collect-url-dialog"
      initialFocus={saveRef}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} data-testid="collect-url-cancel">
            {t('common.cancel')}
          </button>
          <button ref={saveRef} type="button" className="btn btn-primary" onClick={() => void saveOfferedUrl()} data-testid="collect-url-save">
            {t('collect.url.save')}
          </button>
        </>
      }
    >
      <p className={styles.text}>{t('collect.url.message', { host: hostOf(url) || url })}</p>
      <code className={`${styles.code} mono`} data-testid="collect-url-value">
        {url}
      </code>
    </Dialog>
  )
}

function PairingDialog({ request }: { request: PairingLike }) {
  const t = useT()
  const denyRef = useRef<HTMLButtonElement>(null)
  const id = extensionId(request)
  const other = t('collect.ext.browserOther')

  const answer = async (allow: boolean) => {
    useCollect.getState().closePairing()
    try {
      await decidePairing(request.id, allow)
      useToasts.getState().push(allow ? t('collect.pair.pairedToast', { browser: browserName(request.browser) ?? other }) : t('collect.pair.deniedToast'))
      refreshPairedList()
    } catch (error) {
      useToasts.getState().push(explain(error, 'collect.pair.decideFailed'), 'error')
    }
  }

  return (
    <Dialog
      title={t('collect.pair.title')}
      // Esc or the backdrop: not answered; the extension can ask again.
      onClose={() => useCollect.getState().closePairing()}
      testId="ext-pair-dialog"
      initialFocus={denyRef}
      footer={
        <>
          <button ref={denyRef} type="button" className="btn btn-ghost" onClick={() => void answer(false)} data-testid="ext-pair-deny">
            {t('collect.pair.deny')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void answer(true)} data-testid="ext-pair-allow">
            {t('collect.pair.allow')}
          </button>
        </>
      }
    >
      <p className={styles.text}>{t('collect.pair.message', { name: pairingName(request, other) })}</p>
      <p className={styles.idRow}>
        <span>{t('collect.pair.idLabel')}</span> <code className={`${styles.code} mono`} data-testid="ext-pair-id">{id || t('collect.ext.idNone')}</code>
      </p>
      <p className={styles.hint}>{t('collect.pair.idHint')}</p>
      {!id && <p className={styles.warn}>{t('collect.pair.idUnknown')}</p>}
      {request.replaces_existing && <p className={styles.warn}>{t('collect.pair.replaces')}</p>}
      <p className={styles.hint}>{t('collect.pair.scope')}</p>
    </Dialog>
  )
}
