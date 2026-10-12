import { useId, useState } from 'react'
import { checkVocabulary } from './artistApi'
import { parseNames } from './artistModel'
import styles from './Artist.module.css'
import { useAT } from './artistText'
import type { Vocabulary } from './types'

// "我的画师在词表里吗？", before the run on purpose: an artist the model does
// not know can never be identified, so no run over their images helps.

type Answer = { kind: 'result'; names: string[]; vocab: Vocabulary } | { kind: 'empty' } | { kind: 'error'; reason: string }

function AnswerLines({ answer }: { answer: Answer }) {
  const t = useAT()
  if (answer.kind === 'empty') return <p className={styles.hint}>{t('artist.vocab.empty')}</p>
  if (answer.kind === 'error') return <p className={styles.problem}>{t('artist.vocab.failed', { reason: answer.reason })}</p>
  const { vocab, names } = answer
  if (!vocab.vocabulary_loaded) return <p className={styles.note}>{t('artist.vocab.notLoaded')}</p>
  return (
    <>
      <p className={styles.hint}>{t('artist.vocab.size', { n: vocab.vocabulary_size })}</p>
      <ul className={styles.vocab} data-testid="artist-vocab-result">
        {names.map((name) => {
          const known = vocab.known?.[name] === true
          return (
            <li key={name} className={known ? styles.known : styles.unknown} data-known={known}>
              {t(known ? 'artist.vocab.known' : 'artist.vocab.unknown', { name })}
            </li>
          )
        })}
      </ul>
    </>
  )
}

export function VocabularyCheck() {
  const t = useAT()
  const inputId = useId()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<Answer | null>(null)

  const check = async () => {
    const names = parseNames(text)
    if (names.length === 0) return setAnswer({ kind: 'empty' })
    setBusy(true)
    try {
      setAnswer({ kind: 'result', names, vocab: await checkVocabulary(names) })
    } catch (error) {
      setAnswer({ kind: 'error', reason: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.block} data-testid="artist-vocab">
      <label className={styles.blockTitle} htmlFor={inputId}>
        {t('artist.vocab.title')}
      </label>
      <div className={styles.inline}>
        <input
          id={inputId}
          className={styles.input}
          value={text}
          placeholder={t('artist.vocab.placeholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void check()}
          data-testid="artist-vocab-input"
        />
        <button type="button" className="btn" onClick={() => void check()} disabled={busy} data-testid="artist-vocab-check">
          {t('artist.vocab.check')}
        </button>
      </div>
      {answer && <AnswerLines answer={answer} />}
    </section>
  )
}
