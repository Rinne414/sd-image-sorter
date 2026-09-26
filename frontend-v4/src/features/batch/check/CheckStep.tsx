import { useEffect, useMemo, useState } from 'react'
import { queryClient } from '../../../api/queryClient'
import type { Batch } from '../../../api/types'
import { useT } from '../../../i18n'
import { useApp } from '../../../state/store'
import { projectKey, readdEntries } from '../datasetApi'
import { captionHolder } from '../edit/useCaptionSession'
import { stepLabel } from '../labels'
import { setSettingsPanel } from '../settingsPanel'
import { StepBar } from '../StepBar'
import { useBatchEntries } from '../useBatchEntries'
import { ruleTagKeys } from './captionChecks'
import { ChecksPanel } from './ChecksPanel'
import { loadCheckOptions, saveCheckOptions, type CheckOptions } from './checkOptions'
import styles from './CheckStep.module.css'
import { IssueCard, type IssueActions } from './IssueCard'
import { PurityCard } from './PurityCard'
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
  const { issues, sources, form, finals, scope, unchecked } = useChecks(batch, entries, options, run)
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
          <MaskCard ids={scope.ids} folderCount={scope.folderCount} />
          <PurityCard batch={batch} ids={scope.ids} folderCount={scope.folderCount} />
        </div>
        <section className={styles.issues} aria-label={t('dataset.check.issuesTitle')} data-testid="check-issues">
          <h2 className={styles.issuesTitle}>
            {issues.length === 0 ? (checking ? t('dataset.check.stillChecking') : t('dataset.check.noIssues')) : t('dataset.check.issueCount', { n: issues.length })}
          </h2>
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
