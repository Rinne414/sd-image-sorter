import { useApp } from '../../state/store'

/** Open the Library in "add to this batch" mode (the Pick step's Add from the library; an empty step offers it too). */
export function openLibraryToAdd(batchId: number): void {
  const s = useApp.getState()
  s.setAdding({ batchId })
  s.setPage('library')
}
