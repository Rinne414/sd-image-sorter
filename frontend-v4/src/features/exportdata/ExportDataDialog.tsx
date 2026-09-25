import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, unwrap } from '../../api/client'
import { useT, type MessageKey } from '../../i18n'
import { copyText } from '../../lib/format'
import { Dialog } from '../../ui/Dialog'
import { useToasts } from '../../ui/toasts'
import styles from './ExportDataDialog.module.css'
import { buildExportText, EXPORT_FORMATS, fileExtension, type ExportFormat, type ExportImage } from './formats'

interface Props {
  ids: number[]
  onClose: () => void
}

const PREVIEW_IMAGES = 200
const PREVIEW_MAX_CHARS = 200_000
/** Rows per export-data request. */
const PAGE = 2000
const FORMAT_KEY = 'sd-v4-export-format'

const LABEL: Record<ExportFormat, [MessageKey, MessageKey]> = {
  prompt: ['export.f.prompt', 'export.d.prompt'],
  prompt_numbered: ['export.f.promptNumbered', 'export.d.promptNumbered'],
  negative: ['export.f.negative', 'export.d.negative'],
  prompt_negative: ['export.f.promptNegative', 'export.d.promptNegative'],
  a1111: ['export.f.a1111', 'export.d.a1111'],
  tags: ['export.f.tags', 'export.d.tags'],
  caption_tags: ['export.f.captionTags', 'export.d.captionTags'],
  caption_merged: ['export.f.captionMerged', 'export.d.captionMerged'],
  jsonl: ['export.f.jsonl', 'export.d.jsonl'],
  csv: ['export.f.csv', 'export.d.csv'],
}

const MIME = { txt: 'text/plain;charset=utf-8', jsonl: 'application/x-ndjson;charset=utf-8', csv: 'text/csv;charset=utf-8' }

async function fetchRows(ids: number[], onProgress?: (done: number) => void): Promise<ExportImage[]> {
  const rows: ExportImage[] = []
  for (let start = 0; start < ids.length; start += PAGE) {
    const res = unwrap<{ images: ExportImage[] }>(
      await api.POST('/api/images/export-data', { body: { image_ids: ids.slice(start, start + PAGE), offset: 0, limit: PAGE } }),
    )
    rows.push(...res.images)
    onProgress?.(Math.min(ids.length, start + PAGE))
  }
  // Pick order, so numbered formats count the way the picks were made.
  const order = new Map(ids.map((id, i) => [id, i]))
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

function savedFormat(): ExportFormat {
  try {
    const f = localStorage.getItem(FORMAT_KEY)
    return (EXPORT_FORMATS as readonly string[]).includes(f ?? '') ? (f as ExportFormat) : 'prompt'
  } catch {
    return 'prompt'
  }
}

function download(text: string, format: ExportFormat, count: number): void {
  const ext = fileExtension(format)
  // Excel reads a CSV as UTF-8 only with the byte-order mark.
  const blob = new Blob([ext === 'csv' ? `﻿${text}` : text], { type: MIME[ext] })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `sd-image-sorter-${format}-${count}.${ext}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Prompts, tags or generation data of the picks as one text, JSONL or CSV file. */
export function ExportDataDialog({ ids, onClose }: Props) {
  const t = useT()
  const [format, setFormat] = useState<ExportFormat>(savedFormat)
  const [busy, setBusy] = useState<{ done: number } | null>(null)
  const n = ids.length
  const previewIds = ids.slice(0, PREVIEW_IMAGES)

  const preview = useQuery({
    queryKey: ['export-preview', previewIds],
    queryFn: () => fetchRows(previewIds),
    staleTime: 30_000,
  })

  const choose = (f: ExportFormat) => {
    setFormat(f)
    try {
      localStorage.setItem(FORMAT_KEY, f)
    } catch {
      // storage blocked: the choice just won't be remembered
    }
  }

  const fullText = async (): Promise<string | null> => {
    setBusy({ done: 0 })
    try {
      const rows = n <= PREVIEW_IMAGES && preview.data ? preview.data : await fetchRows(ids, (done) => setBusy({ done }))
      return buildExportText(rows, format)
    } catch (error) {
      useToasts.getState().push(t('error.generic', { reason: (error as Error).message }), 'error')
      return null
    } finally {
      setBusy(null)
    }
  }

  const copyAll = async () => {
    const text = await fullText()
    if (text === null) return
    await copyText(text)
    useToasts.getState().push(t('export.copied', { n }), 'info')
  }

  const saveFile = async () => {
    const text = await fullText()
    if (text === null) return
    download(text, format, n)
  }

  let shown = ''
  if (preview.data) {
    const text = buildExportText(preview.data, format)
    shown = text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}\n…` : text
  }

  const footer = (
    <>
      {busy && (
        <span className={styles.busy} role="status">
          {t('export.preparing', { done: busy.done, total: n })}
        </span>
      )}
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn" onClick={() => void copyAll()} disabled={!!busy || !preview.data}>
        {t('export.copyAll')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void saveFile()} disabled={!!busy || !preview.data}>
        {t('export.download', { ext: fileExtension(format) })}
      </button>
    </>
  )

  return (
    <Dialog title={t('export.title', { n })} onClose={onClose} footer={footer} testId="export-dialog" wide>
      <div className={styles.layout}>
        <div className={styles.formats} role="radiogroup" aria-label={t('export.format')}>
          {EXPORT_FORMATS.map((f) => (
            <label key={f} className={styles.format} data-checked={f === format || undefined}>
              <input type="radio" name="export-format" checked={f === format} onChange={() => choose(f)} />
              <span className={styles.formatName}>{t(LABEL[f][0])}</span>
            </label>
          ))}
        </div>
        <div className={styles.side}>
          <p className={styles.desc}>{t(LABEL[format][1])}</p>
          <p className={styles.previewHead}>
            {n > PREVIEW_IMAGES ? t('export.previewFirst', { n: PREVIEW_IMAGES, total: n }) : t('export.preview')}
          </p>
          <textarea
            className={`${styles.text} mono`}
            readOnly
            value={preview.isError ? t('error.generic', { reason: preview.error.message }) : preview.data ? shown || t('export.nothing') : t('picker.loading')}
            data-testid="export-preview"
            aria-label={t('export.preview')}
            spellCheck={false}
          />
        </div>
      </div>
    </Dialog>
  )
}
