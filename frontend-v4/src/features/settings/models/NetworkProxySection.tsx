import { useEffect, useState, type FormEvent } from 'react'
import { api, unwrap } from '../../../api/client'
import { useToasts } from '../../../ui/toasts'
import styles from './ModelCenter.module.css'
import { useMT, type ModelKey } from './modelText'

// One proxy for model downloads, package installs and update checks, so people
// who run Clash or v2rayN enter a port once instead of turning on TUN mode.

interface ProxyStatus {
  proxy: string
  system_proxy: string
}

interface ProxyResult {
  name: string
  ok: boolean
  ms: number
  error: string
}

const RESULT_KEYS: Record<string, ModelKey> = {
  timeout: 'mc.proxy.resultTimeout',
  unreachable: 'mc.proxy.resultUnreachable',
}

const hostAndPort = (proxy: string) => proxy.replace(/^\w+:\/\/([^/@]*@)?/, '')

export function NetworkProxySection() {
  const mt = useMT()
  const [status, setStatus] = useState<ProxyStatus>({ proxy: '', system_proxy: '' })
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [results, setResults] = useState<ProxyResult[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void api
      .GET('/api/network/proxy', { signal: controller.signal })
      .then(unwrap<ProxyStatus>)
      .then((answer) => {
        setStatus(answer)
        setDraft(answer.proxy)
      })
      .catch(() => {
        if (!controller.signal.aborted) setNote(mt('mc.proxy.loadFailed'))
      })
    return () => controller.abort()
    // Read once when the page opens; the language does not change what is stored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fail = (key: ModelKey, error: unknown) => useToasts.getState().push(mt(key, { reason: (error as Error).message }), 'error')

  const save = async (value: string) => {
    setBusy(true)
    setResults(null)
    try {
      const answer = unwrap<ProxyStatus>(await api.POST('/api/network/proxy', { body: { proxy: value } }))
      setStatus(answer)
      setDraft(answer.proxy)
      setNote(answer.proxy ? mt('mc.proxy.saved', { address: hostAndPort(answer.proxy) }) : mt('mc.proxy.cleared'))
    } catch (error) {
      setNote('')
      fail('mc.proxy.saveFailed', error)
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setNote('')
    setResults(null)
    try {
      const answer = unwrap<{ results: ProxyResult[] }>(await api.POST('/api/network/proxy/test', { body: { proxy: draft } }))
      setResults(answer.results)
    } catch (error) {
      fail('mc.proxy.testFailed', error)
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void save(draft.trim())
  }

  const offerSystem = status.system_proxy !== '' && status.system_proxy !== status.proxy
  return (
    <section className={styles.proxy} data-testid="network-proxy" aria-labelledby="network-proxy-title">
      <span id="network-proxy-title" className={styles.mirrorTitle}>
        {mt('mc.proxy.title')}
      </span>
      <p className={styles.mirrorHint}>{mt('mc.proxy.help')}</p>
      <form className={styles.proxyRow} onSubmit={submit}>
        <input
          className={`mono ${styles.proxyInput}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={mt('mc.proxy.placeholder')}
          aria-labelledby="network-proxy-title"
          autoComplete="off"
          spellCheck={false}
          data-testid="network-proxy-input"
        />
        <button type="submit" className="btn btn-primary" disabled={busy} data-testid="network-proxy-save">
          {mt('mc.proxy.save')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void test()} data-testid="network-proxy-test">
          {mt('mc.proxy.test')}
        </button>
        {offerSystem && (
          <button type="button" className="btn" disabled={busy} onClick={() => void save(status.system_proxy)} data-testid="network-proxy-system">
            {mt('mc.proxy.useSystem', { address: hostAndPort(status.system_proxy) })}
          </button>
        )}
      </form>
      {note && (
        <p className={styles.mirrorHint} role="status" data-testid="network-proxy-note">
          {note}
        </p>
      )}
      {results && (
        <ul className={styles.proxyResults} data-testid="network-proxy-results">
          {results.map((result) => (
            <li key={result.name} data-ok={result.ok}>
              {result.ok ? mt('mc.proxy.resultOk', { name: result.name, ms: result.ms }) : mt(RESULT_KEYS[result.error] ?? 'mc.proxy.resultFailed', { name: result.name })}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
