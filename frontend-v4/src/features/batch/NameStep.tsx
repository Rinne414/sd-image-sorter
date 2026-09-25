import { useRef, useState } from 'react'
import type { Batch, BatchItem } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { setOutputName } from './batchApi'
import { useNamePreview } from './exportApi'
import { namesBody, type ExportSettings } from './exportSettings'
import { InlineName } from './InlineName'
import { ItemImage } from './ItemImage'
import { stepLabel } from './labels'
import { cleanOverride, duplicateIds, insertToken, nameBlock, TEMPLATE_TOKENS, type NamePreviewItem } from './names'
import styles from './NameStep.module.css'
import { StepBar } from './StepBar'
import { useExportSettings } from './useExportSettings'

const TOKEN_HELP: Record<(typeof TEMPLATE_TOKENS)[number], MessageKey> = {
  '{batch}': 'batch.name.token.batch',
  '{n}': 'batch.name.token.n',
  '{n:02}': 'batch.name.token.n2',
  '{n:03}': 'batch.name.token.n3',
  '{original}': 'batch.name.token.original',
}

const TEMPLATE_MAX = 200

interface Props {
  batch: Batch
  next: string | null
  onNext: (step: string) => void
}

/** One naming rule for the whole post; the list shows every final file name as the export will write it. */
export function NameStep({ batch, next, onNext }: Props) {
  const t = useT()
  const [settings, update] = useExportSettings(batch)
  const hasTemplate = settings.name_template.trim() !== ''
  const { preview, stale } = useNamePreview(batch, namesBody(settings, 'block'), hasTemplate)
  const block = hasTemplate ? nameBlock(preview, stale) : 'template'
  const dups = duplicateIds(preview)
  const blocked = block === 'template' || block === 'duplicates'
  const byId = new Map((preview?.items ?? []).map((row) => [row.image_id, row]))

  return (
    <section className={styles.step} data-testid="name-step">
      <StepBar count={t('batch.pick.count', { n: batch.items.length })} hint={t('batch.name.hint')}>
        {blocked && (
          <span className={styles.blocked} role="status" data-testid="name-blocked">
            {block === 'template' ? t('batch.name.blockTemplate') : t('batch.name.blockDuplicates', { n: dups.size })}
          </span>
        )}
        {next && (
          <button type="button" className="btn btn-primary" disabled={blocked} onClick={() => onNext(next)} data-testid="step-next">
            {t('batch.panel.next', { step: stepLabel(next, t) })}
          </button>
        )}
      </StepBar>
      <div className={styles.scroller}>
        <TemplateForm settings={settings} update={update} problem={hasTemplate ? (preview?.template_error?.token ?? null) : ''} />
        <ol className={styles.list} data-testid="name-list">
          {batch.items.map((item, index) => (
            <NameRow key={item.image_id} batch={batch} item={item} index={index} row={byId.get(item.image_id)} duplicate={dups.has(item.image_id)} stale={stale} />
          ))}
        </ol>
      </div>
    </section>
  )
}

interface FormProps {
  settings: ExportSettings
  update: (change: Partial<ExportSettings>) => void
  /** The unknown token, '' for an empty rule, null when the rule is fine. */
  problem: string | null
}

function TemplateForm({ settings, update, problem }: FormProps) {
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)

  const insert = (token: string) => {
    const input = inputRef.current
    const value = settings.name_template
    const next = insertToken(value, token, input?.selectionStart ?? value.length, input?.selectionEnd ?? value.length)
    if (next.value.length > TEMPLATE_MAX) return
    update({ name_template: next.value })
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(next.caret, next.caret)
    })
  }

  return (
    <div className={styles.form}>
      <label className={styles.field}>
        <span className={styles.label}>{t('batch.name.template')}</span>
        <input
          ref={inputRef}
          className={`${styles.template} mono`}
          value={settings.name_template}
          maxLength={TEMPLATE_MAX}
          spellCheck={false}
          aria-invalid={problem !== null || undefined}
          onChange={(e) => update({ name_template: e.target.value })}
          data-testid="name-template"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>{t('batch.name.start')}</span>
        <input
          className={`${styles.start} mono`}
          type="number"
          min={0}
          value={settings.start_number}
          onChange={(e) => {
            const n = Math.floor(Number(e.target.value))
            if (Number.isFinite(n) && n >= 0) update({ start_number: n })
          }}
          data-testid="name-start"
        />
      </label>
      <div className={styles.tokens}>
        <span className={styles.label}>{t('batch.name.tokens')}</span>
        {TEMPLATE_TOKENS.map((token) => (
          <button key={token} type="button" className={`btn ${styles.token}`} onClick={() => insert(token)} title={t(TOKEN_HELP[token])} data-testid="name-token">
            <code className="mono">{token}</code>
            <span>{t(TOKEN_HELP[token])}</span>
          </button>
        ))}
      </div>
      {problem !== null && (
        <p className={styles.problem} role="alert" data-testid="name-template-problem">
          {problem === '' ? t('batch.name.empty') : t('batch.name.unknownToken', { token: problem })}
        </p>
      )}
      <p className={styles.note}>{t('batch.name.note')}</p>
    </div>
  )
}

interface RowProps {
  batch: Batch
  item: BatchItem
  index: number
  row: NamePreviewItem | undefined
  duplicate: boolean
  stale: boolean
}

const stemOf = (name: string) => name.replace(/\.[^.]+$/, '')

function NameRow({ batch, item, index, row, duplicate, stale }: RowProps) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const finalName = row?.output_name ?? null

  const done = (typed: string) => {
    setEditing(false)
    const name = cleanOverride(typed)
    if (name === item.output_name || (!item.output_name && finalName && name === stemOf(finalName))) return
    void setOutputName(batch.id, item.image_id, name)
  }

  return (
    <li className={styles.row} data-duplicate={duplicate || undefined} data-testid="name-row" data-id={item.image_id}>
      <span className={`${styles.index} mono`}>{index + 1}</span>
      <span className={styles.thumb}>
        <ItemImage batch={batch} item={item} size={128} />
      </span>
      <span className={`${styles.original} mono`} title={item.filename}>
        {item.filename}
      </span>
      <Icon name="right" size={12} className={styles.arrow} />
      <span className={styles.final}>
        {editing ? (
          <InlineName value={item.output_name ?? (finalName ? stemOf(finalName) : '')} label={t('batch.name.edit', { name: item.filename })} onDone={done} onCancel={() => setEditing(false)} />
        ) : (
          <button
            type="button"
            className={`${styles.finalName} mono`}
            data-stale={stale || undefined}
            onClick={() => setEditing(true)}
            title={t('batch.name.edit', { name: item.filename })}
            data-testid="name-final"
          >
            {finalName ?? '—'}
          </button>
        )}
      </span>
      <span className={styles.tags}>
        {duplicate && <span className={styles.dupTag}>{t('batch.name.duplicate')}</span>}
        {!item.has_censored && <span className={styles.warnTag}>{t('batch.badge.missing')}</span>}
        {item.output_name && (
          <>
            <span className={styles.ownTag}>{t('batch.name.own')}</span>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => void setOutputName(batch.id, item.image_id, null)}
              title={t('batch.name.clearOwn')}
              aria-label={t('batch.name.clearOwn')}
              data-testid="name-clear"
            >
              <Icon name="close" size={12} />
            </button>
          </>
        )}
      </span>
    </li>
  )
}
