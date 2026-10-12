import { useState } from 'react'
import { TagField } from './TagField'
import styles from './TagInput.module.css'
import type { Vocabulary } from './tagSuggest'

interface Props {
  placeholder: string
  label: string
  /** Called with the tags typed (comma separated); true clears the field. */
  onSubmit: (tags: string[]) => Promise<boolean> | boolean
  testId?: string
  /**
   * library: tags already in the library, most used first. global: the
   * library plus the danbooru vocabulary, and Chinese / Japanese aliases.
   */
  vocabulary?: Vocabulary
  /** Tags offered before the others when they match (e.g. the ones this dataset already uses). */
  preferred?: readonly string[]
}

const split = (text: string) =>
  text
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** A field that adds tags: suggestions as you type (TagField), Enter adds what is typed. */
export function TagInput({ placeholder, label, onSubmit, testId, vocabulary = 'library', preferred = [] }: Props) {
  const [text, setText] = useState('')

  const submit = async () => {
    const tags = split(text)
    if (!tags.length) return
    if (await onSubmit(tags)) setText('')
  }

  return (
    <div className={styles.wrap}>
      <TagField
        value={text}
        onChange={setText}
        className={styles.input}
        placeholder={placeholder}
        label={label}
        testId={testId}
        vocabulary={vocabulary}
        preferred={preferred}
        onEnter={(e) => {
          e.preventDefault()
          void submit()
        }}
      />
    </div>
  )
}
