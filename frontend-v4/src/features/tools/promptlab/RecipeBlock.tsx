import { useState } from 'react'
import { useCategories } from '../../../api/queries'
import { useT } from '../../../i18n'
import { copyText } from '../../../lib/format'
import { groupTags, TAG_GROUPS, type TagGroupId } from '../../../lib/tagGroups'
import { useToasts } from '../../../ui/toasts'
import { CopyButton } from '../../card/CardParts'
import { findTagsInLibrary, GROUP_LABEL } from '../reader/ReaderBlocks'
import { lookupKey } from './buildCleanup'
import { replacePrompt } from './buildStore'
import { plt, usePL } from './plText'
import styles from './PromptLab.module.css'

// "按分类挑标签": the source's tags in the seven copy groups; tick groups and
// the prompt becomes their tags, or copy a training caption (no quality/meta).

/** The groups a training caption keeps, and the ones ticked at first. */
const CAPTION_GROUPS: readonly TagGroupId[] = ['appearance', 'clothing', 'pose', 'scenery', 'style']

interface Props {
  tags: string[]
  /** true: taken from the prompt; false: the tags the library gave the image. */
  fromPrompt: boolean
}

export function RecipeBlock({ tags, fromPrompt }: Props) {
  const t = useT()
  const p = usePL()
  const [checked, setChecked] = useState<ReadonlySet<TagGroupId>>(() => new Set(CAPTION_GROUPS))
  const { data: categories } = useCategories(tags.map(lookupKey).filter(Boolean))
  const groups = categories ? groupTags(tags, (tag) => categories.get(lookupKey(tag))) : null

  const toggle = (id: TagGroupId) => {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChecked(next)
  }
  const tagsOf = (ids: Iterable<TagGroupId>) => (groups ? [...ids].flatMap((id) => groups[id]) : [])
  const applyChecked = () => {
    const picked = tagsOf(TAG_GROUPS.map((g) => g.id).filter((id) => checked.has(id)))
    if (picked.length === 0) useToasts.getState().push(plt('pl.build.nothingChecked'))
    else replacePrompt(picked.join(', '), plt('pl.build.replaced', { n: picked.length }))
  }
  const copyCaption = async () => {
    const caption = tagsOf(CAPTION_GROUPS)
    if (caption.length && (await copyText(caption.join(', ')))) useToasts.getState().push(plt('pl.build.captionCopied', { n: caption.length }))
  }

  return (
    <section className={styles.panel} data-testid="pl-build-recipe">
      <h3 className={styles.panelTitle}>{p('pl.build.recipe')}</h3>
      {tags.length === 0 ? (
        <p className={styles.muted}>{p('pl.build.noTags')}</p>
      ) : (
        <>
          <p className={styles.muted}>
            {p(fromPrompt ? 'pl.build.fromPrompt' : 'pl.build.fromLibrary')} {p('pl.build.recipeLead')}
          </p>
          {!groups ? (
            <p className={styles.muted}>{t('lib.menu.loading')}</p>
          ) : (
            <ul className={styles.groups}>
              {TAG_GROUPS.filter(({ id }) => groups[id].length > 0).map(({ id }) => (
                <li key={id} className={styles.group} data-group={id}>
                  <header className={styles.groupHead}>
                    <label className={styles.check}>
                      <input type="checkbox" checked={checked.has(id)} onChange={() => toggle(id)} />
                      <span>{t(GROUP_LABEL[id])}</span>
                      <span className={`${styles.muted} mono`}>{groups[id].length}</span>
                    </label>
                    <CopyButton text={groups[id].join(', ')} compact />
                    <button type="button" className={styles.textButton} onClick={() => findTagsInLibrary(groups[id], t(GROUP_LABEL[id]))}>
                      {p('pl.act.filter')}
                    </button>
                  </header>
                  <span className={styles.chips}>
                    {groups[id].map((tag) => (
                      <span key={tag} className={`chip cat-${categories?.get(lookupKey(tag)) ?? 'unknown'}`}>
                        {tag}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.runRow}>
            <button type="button" className="btn" onClick={applyChecked} disabled={!groups} data-testid="pl-build-use-checked">
              {p('pl.build.useChecked')}
            </button>
            <button type="button" className="btn" onClick={() => void copyCaption()} disabled={!groups} data-testid="pl-build-copy-caption">
              {p('pl.build.copyCaption')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
