import { useEffect, useState } from 'react'
import { findLoadedImage } from '../../api/loaded'
import { useT, type MessageKey } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { TagField } from '../../ui/TagField'
import { displayTag } from '../batch/edit/tagStyle'
import { bulkRequest, summarize, type BulkForm, type BulkOp, type Summary } from './bulkTags'
import { applyBulk, postBulk } from './tagEdit'
import styles from './TagEditDialog.module.css'

interface Props {
  ids: number[]
  onClose: () => void
}

const OPS: [BulkOp, MessageKey][] = [
  ['add', 'tagedit.op.add'],
  ['remove', 'tagedit.op.remove'],
  ['replace', 'tagedit.op.replace'],
  ['cleanup', 'tagedit.op.cleanup'],
]

const PREVIEW_DELAY_MS = 350
const SAMPLES_SHOWN = 5

const START: BulkForm = {
  op: 'add',
  tags: '',
  find: '',
  replace: '',
  caseSensitive: false,
  regex: false,
  minConfidence: 0.2,
  dedupe: true,
}

type Preview = { key: string; summary: Summary } | { key: string; error: string }

/** Add, remove, rename or clean up tags on every pick, with a dry run before anything is written. */
export function TagEditDialog({ ids, onClose }: Props) {
  const t = useT()
  const [form, setForm] = useState<BulkForm>(START)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [applying, setApplying] = useState(false)
  const n = ids.length

  const req = bulkRequest(form, ids, true)
  const key = req ? `${req.path} ${JSON.stringify(req.body)}` : ''

  // Every change re-runs the dry run (debounced); an older answer never shows for a newer form.
  useEffect(() => {
    if (!req) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      postBulk(req.path, req.body, controller.signal)
        .then((res) => setPreview({ key, summary: summarize(form.op, res) }))
        .catch((error: Error) => {
          if (!controller.signal.aborted) setPreview({ key, error: error.message })
        })
    }, PREVIEW_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
    // `key` covers everything the request depends on.
  }, [key])

  const fresh = preview !== null && preview.key === key && req !== null
  const summary = fresh && 'summary' in preview ? preview.summary : null
  const set = (patch: Partial<BulkForm>) => setForm({ ...form, ...patch })

  const apply = async () => {
    setApplying(true)
    const ok = await applyBulk(form, ids)
    setApplying(false)
    if (ok) onClose()
  }

  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void apply()} disabled={!summary || summary.images === 0 || applying}>
        {summary ? t('tagedit.apply', { n: summary.images }) : t('tagedit.applyWaiting')}
      </button>
    </>
  )

  const typed = form.op === 'replace' ? form.find : form.tags

  return (
    <Dialog title={t('tagedit.title', { n })} onClose={onClose} footer={footer} testId="tagedit-dialog" wide>
      <div className={styles.ops} role="group" aria-label={t('tagedit.title', { n })}>
        {OPS.map(([op, label]) => (
          <button key={op} type="button" className={styles.op} aria-pressed={form.op === op} onClick={() => set({ op })}>
            {t(label)}
          </button>
        ))}
      </div>

      <div className={styles.form}>
        {(form.op === 'add' || form.op === 'remove') && (
          <label className={styles.field}>
            <span>{t(form.op === 'add' ? 'tagedit.tagsToAdd' : 'tagedit.tagsToRemove')}</span>
            {/* Adding offers the vocabulary (a character brings its series), written as library tags are;
                removing offers the library's own tags as they are stored. */}
            <TagField
              autoFocus
              value={form.tags}
              placeholder="smile, long hair"
              onChange={(tags) => set({ tags })}
              vocabulary={form.op === 'add' ? 'global' : 'library'}
              write={form.op === 'add' ? displayTag : undefined}
              series={form.op === 'add'}
              testId="tagedit-tags"
            />
          </label>
        )}
        {form.op === 'replace' && (
          <div className={styles.pair}>
            <label className={styles.field}>
              <span>{t('tagedit.find')}</span>
              <TagField autoFocus mode="single" vocabulary="library" value={form.find} onChange={(find) => set({ find })} testId="tagedit-find" />
            </label>
            <span className={styles.arrow} aria-hidden>
              →
            </span>
            <label className={styles.field}>
              <span>{t('tagedit.replace')}</span>
              <TagField
                mode="single"
                value={form.replace}
                placeholder={t('tagedit.replaceEmpty')}
                onChange={(replace) => set({ replace })}
                write={displayTag}
                testId="tagedit-replace"
              />
            </label>
          </div>
        )}
        {form.op === 'cleanup' && (
          <label className={styles.field}>
            <span>{t('tagedit.minConfidence')}</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={form.minConfidence}
              onChange={(e) => set({ minConfidence: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })}
            />
            <small>{t('tagedit.minConfidenceHint')}</small>
          </label>
        )}
        <div className={styles.checks}>
          {(form.op === 'remove' || form.op === 'replace') && (
            <label className={styles.check}>
              <input type="checkbox" checked={form.caseSensitive} onChange={(e) => set({ caseSensitive: e.target.checked })} />
              {t('tagedit.caseSensitive')}
            </label>
          )}
          {form.op === 'replace' && (
            <label className={styles.check}>
              <input type="checkbox" checked={form.regex} onChange={(e) => set({ regex: e.target.checked })} />
              {t('tagedit.regex')}
            </label>
          )}
          {form.op === 'cleanup' && (
            <label className={styles.check}>
              <input type="checkbox" checked={form.dedupe} onChange={(e) => set({ dedupe: e.target.checked })} />
              {t('tagedit.dedupe')}
            </label>
          )}
        </div>
      </div>

      <section className={styles.preview} aria-live="polite" data-testid="tagedit-preview">
        {!req && <p className={styles.muted}>{t('tagedit.fillIn')}</p>}
        {req && !fresh && <p className={styles.muted}>{t('tagedit.previewing')}</p>}
        {fresh && 'error' in preview && <p className={styles.error}>{t('tagedit.previewFailed', { reason: preview.error })}</p>}
        {summary && summary.images === 0 && (
          <>
            <p className={styles.muted}>{t('tagedit.nothing')}</p>
            {typed.includes('_') && <p className={styles.muted}>{t('tagedit.underscoreHint')}</p>}
          </>
        )}
        {summary && summary.images > 0 && (
          <>
            <p className={styles.result}>{t('tagedit.willChange', { images: summary.images, tags: summary.tags })}</p>
            <ul className={styles.samples}>
              {summary.samples.slice(0, SAMPLES_SHOWN).map((s) => (
                <li key={s.imageId}>
                  <span className={styles.file}>{findLoadedImage(s.imageId)?.filename ?? `#${s.imageId}`}</span>
                  {s.removed.map((tag) => (
                    <span key={`-${tag}`} className={styles.removed}>
                      − {tag}
                    </span>
                  ))}
                  {s.added.map((tag) => (
                    <span key={`+${tag}`} className={styles.added}>
                      + {tag}
                    </span>
                  ))}
                  {s.note && (
                    <span className={styles.removed}>{t('tagedit.cleanupSample', { low: s.note.lowConf, dupes: s.note.dupes })}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </Dialog>
  )
}
