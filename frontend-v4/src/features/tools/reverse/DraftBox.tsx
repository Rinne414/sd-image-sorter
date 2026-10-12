import { useState } from 'react'
import { useToasts } from '../../../ui/toasts'
import { TipoPanel } from '../../batch/edit/TipoPanel'
import { CopyButton } from '../../card/CardParts'
import { tr } from '../../jobs/jobs'
import { tt, useTT } from '../toolText'
import styles from './Reverse.module.css'
import { appendTags, draftTags, tipoOffFor } from './reverseModes'
import { setDraft, useDraft, useReverseOptions } from './reverseStore'

// The user's own draft: seeded from the record or a guess, edited freely, kept
// across restarts; TIPO's ticked suggestions are added to it.

function addToDraft(tags: string[]): void {
  const before = useDraft.getState().text
  const { text, added } = appendTags(before, tags)
  setDraft(text)
  useToasts.getState().push(tt('reverse.tipoAdded', { n: added }), 'info', added ? { label: tr('toast.undo'), run: () => setDraft(before) } : undefined)
}

function clearDraft(): void {
  const before = useDraft.getState().text
  setDraft('')
  useToasts.getState().push(tt('reverse.draftCleared'), 'info', { label: tr('toast.undo'), run: () => setDraft(before) })
}

export function DraftBox({ imageId }: { imageId: number | null }) {
  const t = useTT()
  const text = useDraft((s) => s.text)
  const target = useReverseOptions((s) => s.target)
  const [tipo, setTipo] = useState(false)
  const off = tipoOffFor(target)
  return (
    <section className={styles.draft} data-testid="reverse-draft">
      <header className={styles.cardHead}>
        <span className={styles.subLabel}>{t('reverse.draft')}</span>
        <span className={styles.cardTools}>
          <CopyButton text={text} compact testId="reverse-copy-draft" />
          <button type="button" className={styles.textButton} onClick={clearDraft} disabled={!text} data-testid="reverse-draft-clear">
            {t('reverse.draftClear')}
          </button>
        </span>
      </header>
      <textarea
        className={styles.draftText}
        rows={5}
        value={text}
        placeholder={t('reverse.draftPlaceholder')}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={t('reverse.draft')}
        data-testid="reverse-draft-text"
      />
      <div className={styles.runRow}>
        <button type="button" className="btn" aria-expanded={tipo && !off} onClick={() => setTipo(!tipo)} disabled={off} data-testid="reverse-tipo-open">
          {t('reverse.tipo')}
        </button>
        {off && <span className={styles.muted}>{t('reverse.tipoOff')}</span>}
      </div>
      {tipo && !off && (
        <TipoPanel
          tags={draftTags(text)}
          imageId={imageId}
          disabled={false}
          onAdd={addToDraft}
          onClose={() => setTipo(false)}
          lead={t('reverse.tipoLead')}
          noTags={t('reverse.tipoNoTags')}
        />
      )}
    </section>
  )
}
