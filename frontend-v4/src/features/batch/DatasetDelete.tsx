import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../api/client'
import type { BatchProjectView } from '../../api/types'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import styles from './BatchDialogs.module.css'
import { projectKey } from './datasetApi'

/** A fresh read of the project the delete would take with it (the revision the user confirms against). */
export function useDatasetDeleteFacts(batchId: number, enabled: boolean) {
  const library = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: projectKey(library, batchId),
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async ({ signal }) =>
      unwrap<BatchProjectView>(await api.GET('/api/batches/{batch_id}/project', { params: { path: { batch_id: batchId } }, signal })),
  })
}

/** What deleting a dataset batch removes, and what it never touches. */
export function DatasetDeleteBody({ facts, failed }: { facts: BatchProjectView | null; failed: boolean }) {
  const t = useT()
  if (!facts) return <p className={styles.body}>{failed ? t('dataset.delete.unknown') : t('grid.loading')}</p>
  const n = facts.project.items.length
  return (
    <>
      <p className={styles.body} data-testid="dataset-delete-body">
        {t('dataset.delete.body', { n })}
      </p>
      {facts.uploaded_count > 0 && (
        <p className={styles.note} data-testid="dataset-delete-uploads">
          {t('dataset.delete.uploads', { n: facts.uploaded_count })}
        </p>
      )}
      <p className={styles.note}>{t('dataset.delete.keeps')}</p>
    </>
  )
}
