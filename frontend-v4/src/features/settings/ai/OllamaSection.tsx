import { useRef, useState } from 'react'
import { ApiError } from '../../../api/client'
import { Dialog } from '../../../ui/Dialog'
import { addJob, startingProgress, useJobs } from '../../jobs/jobs'
import { isFinished } from '../../jobs/progress'
import { Section } from '../about/Section'
import styles from './Ai.module.css'
import { deleteModel, pullModel, saveVlmSettings, startOllama, useLocalModels } from './aiApi'
import { at, isAiKey, useAT } from './aiText'
import type { LocalModels, VlmSettings } from './types'
import type { VlmDraft } from './useVlmDraft'
import { OLLAMA_ENDPOINT, usesOllamaModel } from './vlmForm'

type Note = { text: string; tone: 'ok' | 'error' }

/** One model as the list shows it (recommended, or found in Ollama). */
interface Row {
  id: string
  name: string
  sizeGb: number
  vramGb: number | null
  note: string
  nsfw: boolean
  installed: boolean
}

const OLLAMA_DOWNLOAD = 'https://ollama.com/download'

function rowsOf(data: LocalModels): { recommended: Row[]; others: Row[] } {
  const recommended = data.models.map((m) => {
    const key = `ai.ollama.note.${m.id}`
    return { id: m.id, name: m.name, sizeGb: m.size_gb, vramGb: m.vram_min_gb, note: isAiKey(key) ? at(key) : m.description, nsfw: m.nsfw_ok, installed: m.installed }
  })
  const known = new Set(recommended.map((r) => r.id))
  const others = data.local_models
    .filter((m) => !known.has(m.id))
    .map((m) => ({ id: m.id, name: m.id, sizeGb: m.size_gb, vramGb: null, note: '', nsfw: false, installed: true }))
  return { recommended, others }
}

/** Ollama on this computer: whether it runs, the recommended models (download, use, delete) and the others it has. */
export function OllamaSection({ draft, settings }: { draft: VlmDraft; settings: VlmSettings }) {
  const t = useAT()
  const local = useLocalModels()
  const [note, setNote] = useState<Note | null>(null)
  const [starting, setStarting] = useState(false)
  const [deleting, setDeleting] = useState<Row | null>(null)

  const start = async () => {
    setStarting(true)
    try {
      await startOllama()
      setNote({ text: t('ai.ollama.started'), tone: 'ok' })
    } catch (error) {
      setNote({ text: t('ai.ollama.startFailed', { reason: (error as Error).message }), tone: 'error' })
    } finally {
      setStarting(false)
    }
  }

  const pull = async (row: Row) => {
    const running = useJobs.getState().jobs.find((j) => j.kind === 'ollama' && !isFinished(j.progress.status))
    if (running) {
      setNote({ text: t('ai.ollama.pullBusy', { model: running.ctx.ollamaModel ?? '' }), tone: 'error' })
      return
    }
    try {
      await pullModel(row.id)
      addJob({ kind: 'ollama', ctx: { ollamaModel: row.id }, label: at('ai.ollama.job', { model: row.id }), progress: { ...startingProgress(0), unit: 'percent', total: 100 } })
      setNote({ text: t('ai.ollama.pullStarted', { model: row.id }), tone: 'ok' })
    } catch (error) {
      const other = error instanceof ApiError && error.status === 409 ? /pulling:\s*(.+)$/i.exec(error.message)?.[1] : undefined
      setNote({ text: other ? t('ai.ollama.pullBusy', { model: other }) : t('ai.ollama.pullFailed', { reason: (error as Error).message }), tone: 'error' })
    }
  }

  const use = async (row: Row) => {
    const patch = { provider: 'openai_compat', endpoint: OLLAMA_ENDPOINT, model: row.id } as const
    try {
      await saveVlmSettings(patch)
      draft.savedPart(patch)
      setNote({ text: t('ai.ollama.used', { model: row.id }), tone: 'ok' })
    } catch (error) {
      setNote({ text: t('ai.ollama.useFailed', { reason: (error as Error).message }), tone: 'error' })
    }
  }

  const remove = async (row: Row) => {
    setDeleting(null)
    try {
      await deleteModel(row.id)
      setNote({ text: t('ai.ollama.deleted', { model: row.id }), tone: 'ok' })
    } catch (error) {
      setNote({ text: t('ai.ollama.deleteFailed', { reason: (error as Error).message }), tone: 'error' })
    }
  }

  const data = local.data
  const rows = data ? rowsOf(data) : null
  const canPull = data?.ollama_installed === true
  const item = (row: Row) => (
    <ModelItem key={row.id} row={row} inUse={usesOllamaModel(settings, row.id)} canPull={canPull} onPull={() => void pull(row)} onUse={() => void use(row)} onDelete={() => setDeleting(row)} />
  )

  return (
    <Section title={t('ai.ollama.title')} testId="ai-ollama">
      <p className={styles.lead}>{t('ai.ollama.lead')}</p>
      <div className={styles.ollamaState} data-testid="ollama-state">
        {local.isPending && <p className={styles.hint}>{t('ai.ollama.loading')}</p>}
        {local.isError && <p className={styles.note} data-tone="error">{t('ai.ollama.loadFailed', { reason: local.error.message })}</p>}
        {data && !data.ollama_installed && (
          <p>
            {t('ai.ollama.notInstalled')}{' '}
            <a className={styles.link} href={OLLAMA_DOWNLOAD} target="_blank" rel="noopener noreferrer">
              {t('ai.ollama.download')} ↗
            </a>
          </p>
        )}
        {data?.ollama_installed && !data.ollama_running && <p>{t('ai.ollama.notRunning')}</p>}
        {data?.ollama_installed && data.ollama_running && <p className={styles.hint}>{t('ai.ollama.running')}</p>}
        {data?.ollama_installed && !data.ollama_running && (
          <button type="button" className="btn" onClick={() => void start()} disabled={starting} data-testid="ollama-start">
            {t(starting ? 'ai.ollama.starting' : 'ai.ollama.start')}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => void local.refetch()} disabled={local.isFetching} data-testid="ollama-refresh">
          {t('ai.ollama.refresh')}
        </button>
      </div>
      {note && (
        <p className={styles.note} data-tone={note.tone} role="status" data-testid="ollama-note">
          {note.text}
        </p>
      )}
      {rows && (
        <>
          <h4 className={styles.listTitle}>{t('ai.ollama.recommended')}</h4>
          <ul className={styles.list} data-testid="ollama-models">
            {rows.recommended.map(item)}
          </ul>
          {rows.others.length > 0 && (
            <>
              <h4 className={styles.listTitle}>{t('ai.ollama.others')}</h4>
              <ul className={styles.list} data-testid="ollama-others">
                {rows.others.map(item)}
              </ul>
            </>
          )}
        </>
      )}
      {deleting && <DeleteDialog row={deleting} inUse={usesOllamaModel(settings, deleting.id)} onCancel={() => setDeleting(null)} onDelete={() => void remove(deleting)} />}
    </Section>
  )
}

interface ItemProps {
  row: Row
  inUse: boolean
  canPull: boolean
  onPull: () => void
  onUse: () => void
  onDelete: () => void
}

function ModelItem({ row, inUse, canPull, onPull, onUse, onDelete }: ItemProps) {
  const t = useAT()
  const job = useJobs((s) => s.jobs.find((j) => j.kind === 'ollama' && j.ctx.ollamaModel === row.id && !isFinished(j.progress.status)))
  const meta = row.vramGb !== null ? t('ai.ollama.meta', { size: row.sizeGb, vram: row.vramGb }) : t('ai.ollama.sizeOnly', { size: row.sizeGb })
  return (
    <li className={styles.item} data-testid="ollama-model" data-model={row.id}>
      <div className={styles.itemText}>
        <p className={styles.itemName}>
          {row.name}
          {row.name !== row.id && <span className={`${styles.itemId} mono`}>{row.id}</span>}
          {inUse && (
            <span className={styles.tag} data-kind="use">
              {t('ai.ollama.inUse')}
            </span>
          )}
          {row.installed && !inUse && (
            <span className={styles.tag} data-kind="ok">
              {t('ai.ollama.installed')}
            </span>
          )}
        </p>
        <p className={styles.itemNote}>
          {[row.note, meta, row.nsfw ? t('ai.ollama.nsfw') : ''].filter(Boolean).join(' · ')}
        </p>
      </div>
      <div className={styles.itemActions}>
        {job ? (
          <span className={styles.pulling} role="status">
            {t('ai.ollama.pulling', { percent: job.progress.current })}
          </span>
        ) : row.installed ? (
          <>
            <button type="button" className="btn" onClick={onUse} disabled={inUse} data-testid="ollama-use">
              {t('ai.ollama.use')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onDelete} data-testid="ollama-delete">
              {t('ai.ollama.delete')}
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={onPull} disabled={!canPull} data-testid="ollama-pull">
            {t('ai.ollama.pull')}
          </button>
        )}
      </div>
    </li>
  )
}

function DeleteDialog({ row, inUse, onCancel, onDelete }: { row: Row; inUse: boolean; onCancel: () => void; onDelete: () => void }) {
  const t = useAT()
  const cancel = useRef<HTMLButtonElement>(null)
  const footer = (
    <>
      <button ref={cancel} type="button" className="btn btn-ghost" onClick={onCancel}>
        {t('ai.ollama.cancel')}
      </button>
      <button type="button" className="btn btn-danger" onClick={onDelete} data-testid="ollama-delete-confirm">
        {t('ai.ollama.delete')}
      </button>
    </>
  )
  return (
    <Dialog title={t('ai.ollama.deleteTitle', { model: row.id })} onClose={onCancel} footer={footer} initialFocus={cancel} testId="ollama-delete-dialog">
      <div className={styles.dialogText}>
        <p>{row.sizeGb > 0 ? t('ai.ollama.deleteBody', { size: row.sizeGb }) : t('ai.ollama.deleteBodyNoSize')}</p>
        {inUse && <p className={styles.warn}>{t('ai.ollama.deleteInUse')}</p>}
      </div>
    </Dialog>
  )
}
