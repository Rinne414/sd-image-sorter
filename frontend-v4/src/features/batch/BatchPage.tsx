import { useApp } from '../../state/store'
import { BatchList } from './BatchList'
import { BatchView } from './BatchView'

/** The Batch tab: the list, or one open batch (#/batch/<id>). */
export function BatchPage() {
  const batchId = useApp((s) => s.batchId)
  return batchId === null ? <BatchList /> : <BatchView key={batchId} id={batchId} />
}
