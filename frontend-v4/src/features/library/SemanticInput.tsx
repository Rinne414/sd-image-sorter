import { useState } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { searchByText } from '../similar/imageSearch'
import { useSimilar } from '../similar/similarStore'
import styles from './QueryBar.module.css'

interface Props {
  inputRef: React.RefObject<HTMLInputElement | null>
}

/** The query box in "by meaning" mode: a sentence, Enter to rank the library against it. */
export function SemanticInput({ inputRef }: Props) {
  const t = useT()
  const current = useSimilar((s) => (s.query?.kind === 'text' ? s.query.text : ''))
  const [text, setText] = useState(current)
  return (
    <div className={styles.field}>
      <span className={styles.glyph} aria-hidden>
        <Icon name="search" size={15} />
      </span>
      <input
        ref={inputRef}
        className={styles.input}
        value={text}
        placeholder={t('sim.semanticPlaceholder')}
        aria-label={t('sim.semanticPlaceholder')}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            searchByText(text)
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            if (text) setText('')
            else e.currentTarget.blur()
          }
        }}
        data-testid="semantic-input"
      />
    </div>
  )
}
