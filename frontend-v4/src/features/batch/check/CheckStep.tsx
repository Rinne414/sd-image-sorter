import { useEffect, useMemo, useState } from 'react'
import { queryClient } from '../../../api/queryClient'
import type { Batch } from '../../../api/types'
import { useT } from '../../../i18n'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { projectKey, readdEntries, saveProjectSettings } from '../datasetApi'
import { runBulk } from '../edit/bulkRun'
import { splitTags, tagKey } from '../edit/captionContent'
import { renderInitialContents } from '../edit/initialContents'
import { withCommonTag } from '../edit/tagLists'
import { styleOf } from '../edit/tagStyle'
import { captionHolder } from '../edit/useCaptionSession'
import { stepLabel } from '../labels'
import { setSettingsPanel } from '../settingsPanel'
import { StepBar } from '../StepBar'
import { useBatchEntries } from '../useBatchEntries'
import { commonTagsIn, ruleTagKeys } from './captionChecks'
import { ChecksPanel } from './ChecksPanel'
import { checkHeading } from './checkHeading'
import { loadCheckOptions, saveCheckOptions, type CheckOptions } from './checkOptions'
import styles from './CheckStep.module.css'
import { IssueCard, type IssueActions } from './IssueCard'
import { PurityCard } from './PurityCard'
import { TokenCountsCard } from './TokenCountsCard'
import { tokenProfile } from './tokenApi'
import { autoMaskImages, MaskCard } from '../masks/MaskCard'
import { MaskEditor, openMaskEditor, useMaskEditor } from '../masks/MaskEditor'
import type { TagDetailScope } from './TagDetail'
import { useChecks } from './useChecks'

interface Props {
  batch: Batch
  next: string | null
  onNext: (step: string) => void
}

/**
 * A dataset batch's check step: everything that would hurt the training in
 * one list of issues, each with what can be done (take the images out, pick
 * them for a bulk change, open one in the caption editor, re-add a changed
 * file). Nothing here edits a caption or the Library by itself.
 */
export function CheckStep({ batch, next, onNext }: Props) {
  const t = useT()
  const { entries, remove, loading, error } = useBatchEntries(batch)
  const [options, setOptions] = useState<CheckOptions>(loadCheckOptions)
  const [run, setRun] = useState(0)
  const { issues, sources, form, finals, heads, scope, unchecked } = useChecks(batch, entries, options, run)
  // The mask editor belongs to this step: leaving the step closes it.
  useEffect(() => () => useMaskEditor.setState({ open: null }), [])
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries])
  const names = useMemo(() => new Map(entries.flatMap((e) => (e.imageId === null ? [] : [[e.imageId, e.filename] as const]))), [entries])
  const idOf = (key: string) => byKey.get(key)?.imageId ?? null
  const tagScope: TagDetailScope = useMemo(
    () => ({ finals: finals?.captions ?? new Map(), skip: form ? ruleTagKeys(form) : new Set(), libraryIds: scope.ids, folderCount: scope.folderCount }),
    [finals, form, scope.ids, scope.folderCount],
  )
  const checking = sources.some((s) => s.status === 'checking')
  const heading = checkHeading(issues.length, sources)
  const library = useApp((s) => s.libraryId)
  // The project is read again too: whether a folder image's file changed is found when it is read.
  const again = () => {
    void queryClient.invalidateQueries({ queryKey: projectKey(library, batch.id) })
    setRun((r) => r + 1)
  }

  const changeOptions = (o: CheckOptions) => {
    setOptions(o)
    saveCheckOptions(o)
  }
  const toEditor = (mode: 'one' | 'bulk', keys: readonly string[]) => {
    const holder = captionHolder(batch.id)
    holder.mode = mode
    if (mode === 'one') holder.current = keys[0] ?? null
    else holder.picked = [...keys]
    onNext('edit')
  }
  const actions: IssueActions = {
    remove: (keys) => remove(keys),
    readd: (keys) => void readdEntries(batch.id, keys),
    pick: (keys) => toEditor('bulk', keys),
    open: (key) => toEditor('one', [key]),
    settings: () => setSettingsPanel(true),
    mask: (key) => {
      const id = idOf(key)
      if (id !== null) openMaskEditor(scope.ids, id)
    },
    autoMask: (keys) => autoMaskImages(keys.map(idOf).filter((id): id is number => id !== null)),
    fixSubjects: async (fixes) => {
      const picked = fixes.flatMap((f) => byKey.get(f.key) ?? [])
      if (!form || picked.length === 0) return
      try {
        // The captions as they start, so images nobody edited yet can be changed (only the ticked ones are rendered).
        const initial = await renderInitialContents(form, picked)
        const op = { kind: 'removeEach', drops: new Map(fixes.map((f) => [f.key, f.drop])) } as const
        const changed = await runBulk(batch, captionHolder(batch.id).session, { label: t('dataset.check.subjectLabel'), op, keys: fixes.map((f) => f.key), initial, entries: byKey, categoryOf: () => 'unknown' })
        if (changed < fixes.length) useToasts.getState().push(t('dataset.check.subjectSome', { n: changed, total: fixes.length }), 'info')
      } catch (error) {
        useToasts.getState().push(t('error.generic', { reason: error instanceof Error ? error.message : String(error) }), 'error')
      }
    },
    commonTagsIn: (fixes) => (form ? commonTagsIn(fixes, form) : []),
    moveCommonTags: async (moves) => {
      if (!form || moves.length === 0) return
      const style = styleOf(form.normalizeUnderscores)
      const quoted = moves.map((m) => `“${m.tag}”`).join(', ')
      const common = (add: boolean) => () => saveProjectSettings(batch.id, (current) => moves.reduce((s, m) => withCommonTag(s, m.tag, add, style), current))
      try {
        // Every other image keeps the tag: written into its own caption where it is
        // not there yet, at the end the rules put it (edited captions get the common
        // tags in front, never-edited ones at the end of the template), so its
        // final caption stays as it was.
        const unedited = entries.filter((e) => !heads?.get(e.key)?.content)
        const initial = unedited.length ? await renderInitialContents(form, unedited) : new Map()
        const adds = new Map<string, { tags: string[]; position: 'front' | 'back' }>()
        for (const { tag, without } of moves) {
          const skip = new Set(without)
          for (const e of entries) {
            const edited = heads?.get(e.key)?.content
            const own = edited ?? initial.get(e.key)
            if (skip.has(e.key) || !own || splitTags(own.booru_caption).some((x) => tagKey(x) === tagKey(tag))) continue
            const add = adds.get(e.key) ?? { tags: [], position: edited ? 'front' : 'back' }
            add.tags.push(tag)
            adds.set(e.key, add)
          }
        }
        if (adds.size > 0) {
          const op = { kind: 'addEach', adds } as const
          const changed = await runBulk(batch, captionHolder(batch.id).session, { label: t('dataset.check.subjectMoveLabel', { tags: quoted }), op, keys: [...adds.keys()], initial, entries: byKey, categoryOf: () => 'unknown', restore: common(true) })
          if (changed < adds.size) return // nothing or only some written: the common tags stay as they are
        }
        if (!(await common(false)())) return
        if (adds.size === 0) {
          useToasts.getState().push(t('dataset.check.subjectMovedOnly', { tags: quoted }), 'info', {
            label: t('toast.undo'),
            run: () => void common(true)().then((ok) => ok && useToasts.getState().push(t('dataset.check.subjectMoveUndone', { tags: quoted }), 'info')),
          })
        }
      } catch (error) {
        useToasts.getState().push(t('error.generic', { reason: error instanceof Error ? error.message : String(error) }), 'error')
      }
    },
    unifyStyle: (keys) => {
      if (!form) return
      const op = { kind: 'style', style: styleOf(form.normalizeUnderscores) } as const
      // Only edited captions are off style: never-edited ones are rendered the batch's way.
      void runBulk(batch, captionHolder(batch.id).session, { label: t('dataset.bulk.labelStyle'), op, keys, initial: new Map(), entries: byKey, categoryOf: () => 'unknown' })
    },
  }

  const body =
    loading || error ? (
      <p className={styles.empty}>{error ? t('dataset.loadError', { reason: error }) : t('grid.loading')}</p>
    ) : entries.length === 0 ? (
      <p className={styles.empty}>{t('dataset.preview.noImages')}</p>
    ) : (
      <div className={styles.layout}>
        <div className={styles.side}>
          <ChecksPanel
            sources={sources}
            form={form}
            options={options}
            onOptions={changeOptions}
            scope={scope}
            total={entries.length}
            onSettings={() => setSettingsPanel(true)}
          />
          {form && <TokenCountsCard profile={tokenProfile(form.targetModel)} chosen={form.targetModel !== ''} />}
          <MaskCard ids={scope.ids} folderCount={scope.folderCount} />
          <PurityCard batch={batch} ids={scope.ids} paths={scope.paths} />
        </div>
        <section className={styles.issues} aria-label={t('dataset.check.issuesTitle')} data-testid="check-issues">
          <h2 className={styles.issuesTitle}>{t(heading.title, { n: heading.n })}</h2>
          {heading.incomplete && (
            <p className={styles.unchecked} data-testid="check-unfinished">
              {t('dataset.check.unfinished')}
            </p>
          )}
          {unchecked > 0 && (
            <p className={styles.unchecked} data-testid="check-unchecked">
              {t('dataset.check.unchecked', { n: unchecked })}{' '}
              <button type="button" className={styles.link} onClick={again} disabled={checking}>
                {t('dataset.check.again')}
              </button>
            </p>
          )}
          {issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} entries={byKey} actions={actions} scope={tagScope} />
          ))}
        </section>
      </div>
    )

  return (
    <section className={styles.step} data-testid="check-step">
      <StepBar count={t('batch.pick.count', { n: entries.length })} hint={t('dataset.check.hint')}>
        <button type="button" className="btn" disabled={checking} onClick={again} data-testid="check-again">
          {checking ? t('dataset.check.state.checking') : t('dataset.check.again')}
        </button>
        {next && (
          <button type="button" className="btn" onClick={() => onNext(next)} data-testid="step-next">
            {t('batch.panel.next', { step: stepLabel(next, t) })}
          </button>
        )}
      </StepBar>
      <div className={styles.scroller}>{body}</div>
      <MaskEditor names={names} />
    </section>
  )
}
