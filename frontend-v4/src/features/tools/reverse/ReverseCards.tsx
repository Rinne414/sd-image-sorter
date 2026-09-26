import { useT } from '../../../i18n'
import { generatorName } from '../../../lib/format'
import { useToasts } from '../../../ui/toasts'
import { CopyButton } from '../../card/CardParts'
import { tr } from '../../jobs/jobs'
import { tt, useTT } from '../toolText'
import styles from './Reverse.module.css'
import { setDraft, useDraft } from './reverseStore'

// The two kinds of answer, kept visibly apart: what the file recorded (how the
// picture was really made) and what was worked out from its pixels (a guess).

/** Put this text in the draft; the draft the user had can be brought back once. */
export function takeAsDraft(text: string): void {
  const before = useDraft.getState().text
  setDraft(text)
  if (before.trim() && before !== text) useToasts.getState().push(tt('reverse.draftReplaced'), 'info', { label: tr('toast.undo'), run: () => setDraft(before) })
  else useToasts.getState().push(tt('reverse.draftReplaced'), 'info')
}

function Head({ badge, provenance, meta, text }: { badge: string; provenance: 'recorded' | 'inferred'; meta: string; text: string }) {
  const t = useTT()
  return (
    <header className={styles.cardHead}>
      <span className={styles.badge} data-provenance={provenance}>
        {badge}
      </span>
      {meta && <span className={styles.meta}>{meta}</span>}
      <span className={styles.cardTools}>
        <CopyButton text={text} compact testId={`reverse-copy-${provenance}`} />
        <button type="button" className={styles.textButton} onClick={() => takeAsDraft(text)} data-testid={`reverse-draft-${provenance}`}>
          {t('reverse.useAsDraft')}
        </button>
      </span>
    </header>
  )
}

export interface FileRecord {
  prompt: string
  negative: string
  generator: string | null
}

export function RecordedCard({ record }: { record: FileRecord | null }) {
  const t = useTT()
  const common = useT()
  if (!record) {
    return (
      <p className={styles.noRecord} data-testid="reverse-no-record">
        {t('reverse.noRecord')}
      </p>
    )
  }
  const generator = record.generator ? generatorName(record.generator, common) : ''
  return (
    <article className={styles.card} data-provenance="recorded" data-testid="reverse-recorded">
      <Head badge={t('reverse.recorded')} provenance="recorded" meta={generator} text={record.prompt} />
      <p className={styles.note}>{generator ? t('reverse.recordedNoteBy', { generator }) : t('reverse.recordedNote')}</p>
      <p className={styles.text}>{record.prompt}</p>
      {record.negative && (
        <>
          <span className={styles.subLabel}>{t('reverse.negative')}</span>
          <p className={`${styles.text} ${styles.negative}`}>{record.negative}</p>
        </>
      )}
    </article>
  )
}

export function InferredCard({ prompt, method, hasRecord }: { prompt: string; method: string; hasRecord: boolean }) {
  const t = useTT()
  return (
    <article className={styles.card} data-provenance="inferred" data-testid="reverse-inferred">
      <Head badge={t('reverse.inferred')} provenance="inferred" meta={method} text={prompt} />
      <p className={hasRecord ? styles.compare : styles.note}>{t(hasRecord ? 'reverse.compareNote' : 'reverse.inferredNote')}</p>
      <p className={styles.text}>{prompt}</p>
    </article>
  )
}
