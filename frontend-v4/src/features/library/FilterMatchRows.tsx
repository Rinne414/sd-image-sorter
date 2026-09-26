import { useState } from 'react'
import { useT } from '../../i18n'
import { addPrompt, addTags, setPromptMode, setTagMode, type PromptMode, type TagMode } from '../../lib/queryEdit'
import { parseSearch } from '../../lib/searchQuery'
import { TagInput } from '../../ui/TagInput'
import styles from './FilterPanel.module.css'

interface Props {
  text: string
  onChange: (next: string) => void
}

/**
 * Tags and prompt words for the filter panel, each with its match mode. The
 * mode lives in the query line (tag:a|b, prompt:*x*); with nothing to apply it
 * to yet, the choice waits here for the next word added.
 */
export function FilterMatchRows({ text, onChange }: Props) {
  const t = useT()
  const q = parseSearch(text)
  const [tagPending, setTagPending] = useState<TagMode>('and')
  const [promptPending, setPromptPending] = useState<PromptMode>('exact')
  const tagMode: TagMode = q.tags.length > 1 ? q.tagMode : tagPending
  const hasPrompts = q.prompts.length + q.excludePrompts.length > 0
  const promptMode: PromptMode = hasPrompts ? q.promptMatch : promptPending

  const chooseTagMode = (mode: TagMode) => {
    setTagPending(mode)
    onChange(setTagMode(text, mode))
  }
  const choosePromptMode = (mode: PromptMode) => {
    setPromptPending(mode)
    onChange(setPromptMode(text, mode))
  }

  return (
    <>
      <div className={styles.row}>
        <dt>{t('browse.filter.tags')}</dt>
        <dd className={styles.matchRow}>
          <span className={styles.matchInput}>
            <TagInput
              placeholder={t('browse.filter.tagsAdd')}
              label={t('browse.filter.tagsAdd')}
              testId="filter-tag-input"
              onSubmit={(tags) => {
                onChange(addTags(text, tags, tagMode))
                return true
              }}
            />
          </span>
          <Choices
            current={tagMode}
            options={[
              ['and', t('browse.filter.tagAll')],
              ['or', t('browse.filter.tagAny')],
            ]}
            onPick={chooseTagMode}
            testId="filter-tag-mode"
          />
        </dd>
      </div>
      <div className={styles.row}>
        <dt>{t('browse.filter.prompt')}</dt>
        <dd className={styles.matchRow}>
          <span className={styles.matchInput}>
            <PromptInput label={t('browse.filter.promptAdd')} onAdd={(words) => onChange(addPrompt(text, words, promptMode))} />
          </span>
          <Choices
            current={promptMode}
            options={[
              ['exact', t('browse.filter.promptExact')],
              ['contains', t('browse.filter.promptContains')],
            ]}
            onPick={choosePromptMode}
            testId="filter-prompt-mode"
          />
        </dd>
      </div>
    </>
  )
}

function Choices<T extends string>({ current, options, onPick, testId }: { current: T; options: [T, string][]; onPick: (v: T) => void; testId: string }) {
  return (
    <div className={styles.choices} role="group" data-testid={testId}>
      {options.map(([value, label]) => (
        <button key={value} type="button" className={styles.choice} aria-pressed={current === value} onClick={() => onPick(value)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function PromptInput({ label, onAdd }: { label: string; onAdd: (words: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <input
      className={styles.wordInput}
      value={value}
      placeholder={label}
      aria-label={label}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || !value.trim()) return
        e.preventDefault()
        onAdd(value)
        setValue('')
      }}
      data-testid="filter-prompt-input"
    />
  )
}
