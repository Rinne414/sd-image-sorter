import { useState } from 'react'
import { useT } from '../../../../i18n'
import { Dialog } from '../../../../ui/Dialog'
import { TagField } from '../../../../ui/TagField'
import { useToasts } from '../../../../ui/toasts'
import { tr } from '../../../jobs/jobs'
import { plt, usePL } from '../plText'
import { writeLike } from '../tagWriting'
import type { TagSet } from '../types'
import { useCategoryLabel, useSetName } from './labels'
import styles from './Random.module.css'
import { createSet, deleteSet, isOwn, type NewSet } from './randomApi'
import { setRandom, toggleTagSet, useRandom } from './randomStore'
import { slotTags } from './slots'

// 标签集: tags that always go together. Use one (its tags go into every
// prompt), make a new one (V3.5 could only delete them), delete your own.

const splitWords = (text: string) => [...new Set(text.split(/[,\n]/).map((w) => w.trim()).filter(Boolean))]

function NewSetDialog({ categories, onClose }: { categories: string[]; onClose: () => void }) {
  const t = useT()
  const p = usePL()
  const label = useCategoryLabel()
  const [name, setName] = useState('')
  const [category, setCategory] = useState(categories.includes('outfit') ? 'outfit' : (categories[0] ?? 'outfit'))
  const [tags, setTags] = useState('')
  const [description, setDescription] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const submit = async () => {
    const set: NewSet = { name: name.trim(), category, tags: splitWords(tags), description: description.trim() }
    if (!set.name || !set.tags.length) return setProblem(p('pl.rnd.needNameAndTags'))
    try {
      await createSet(set)
      useToasts.getState().push(plt('pl.rnd.setCreated', { name: set.name }))
      onClose()
    } catch (error) {
      setProblem(p('pl.rnd.saveFailed', { reason: (error as Error).message }))
    }
  }
  const footer = (
    <>
      <button type="button" className="btn" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void submit()} data-testid="pl-set-create">
        {p('pl.rnd.create')}
      </button>
    </>
  )
  return (
    <Dialog title={p('pl.rnd.setNewTitle')} onClose={onClose} footer={footer} testId="pl-set-dialog">
      <div className={styles.form}>
        <label className={styles.field}>
          <span className={styles.subLabel}>{p('pl.rnd.name')}</span>
          <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} data-testid="pl-set-name" />
        </label>
        <label className={styles.field}>
          <span className={styles.subLabel}>{p('pl.rnd.setCategory')}</span>
          <select className={styles.input} value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {label(c)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.subLabel}>{p('pl.rnd.setTags')}</span>
          <TagField className={styles.textarea} rows={3} value={tags} onChange={setTags} write={writeLike(tags)} testId="pl-set-tags" />
        </label>
        <button type="button" className={styles.textButton} onClick={() => setTags(slotTags(useRandom.getState().slots).join(', '))} data-testid="pl-set-from-slots">
          {p('pl.rnd.setFromSlots')}
        </button>
        <label className={styles.field}>
          <span className={styles.subLabel}>{p('pl.rnd.description')}</span>
          <input className={styles.input} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {problem && <p className={styles.problem}>{problem}</p>}
      </div>
    </Dialog>
  )
}

/** Delete one of the user's sets; Undo makes it again (with a new id). */
async function removeSet(set: TagSet): Promise<void> {
  try {
    await deleteSet(set.id)
  } catch (error) {
    useToasts.getState().push(plt('pl.rnd.deleteFailed', { reason: (error as Error).message }), 'error')
    return
  }
  const inUse = useRandom.getState().tagSets
  if (inUse.includes(String(set.id))) setRandom({ tagSets: inUse.filter((id) => id !== String(set.id)) })
  const again = { name: set.name, category: set.category, description: set.description, tags: set.members.map((m) => m.tag) }
  useToasts.getState().push(plt('pl.rnd.setDeleted', { name: set.name }), 'info', { label: tr('toast.undo'), run: () => void createSet(again) })
}

function SetRow({ set }: { set: TagSet }) {
  const p = usePL()
  const label = useCategoryLabel()
  const setName = useSetName()
  const inUse = useRandom((s) => s.tagSets.includes(String(set.id)))
  return (
    <li className={styles.listRow} data-set={set.name}>
      <div className={styles.listHead}>
        <span className={styles.listName}>{setName(set)}</span>
        <span className={`${styles.muted} mono`}>
          {label(set.category)} · {p('pl.rnd.setMembers', { n: set.members.length })}
        </span>
        {!isOwn(set.id) && <span className={styles.badge}>{p('pl.rnd.builtin')}</span>}
        <span className={styles.listActions}>
          <button type="button" className={inUse ? 'btn' : styles.textButton} aria-pressed={inUse} onClick={() => toggleTagSet(String(set.id))} data-action="use">
            {p(inUse ? 'pl.rnd.unuse' : 'pl.rnd.use')}
          </button>
          {isOwn(set.id) && (
            <button type="button" className={styles.textButton} onClick={() => void removeSet(set)} data-action="delete">
              {p('pl.rnd.delete')}
            </button>
          )}
        </span>
      </div>
      <span className={styles.muted}>{set.members.map((m) => m.tag).join(', ')}</span>
    </li>
  )
}

export function TagSets({ sets, categories }: { sets: TagSet[]; categories: string[] }) {
  const p = usePL()
  const [creating, setCreating] = useState(false)
  return (
    <section className={styles.panel} data-testid="pl-sets">
      <header className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{p('pl.rnd.setList')}</h3>
        <button type="button" className="btn" onClick={() => setCreating(true)} data-testid="pl-set-new">
          {p('pl.rnd.setNew')}
        </button>
      </header>
      <p className={styles.muted}>{p('pl.rnd.setLead')}</p>
      <ul className={styles.list}>
        {sets.map((set) => (
          <SetRow key={String(set.id)} set={set} />
        ))}
      </ul>
      {creating && <NewSetDialog categories={categories} onClose={() => setCreating(false)} />}
    </section>
  )
}
