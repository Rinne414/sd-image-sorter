import { useQuery } from '@tanstack/react-query'
import { queryClient } from '../../api/queryClient'
import { fetchPaired } from './collectApi'

// The paired browsers, shared by Settings and the pairing prompt (an answer
// there changes the list here).

const KEY = ['collect-paired']

export function usePaired() {
  return useQuery({ queryKey: KEY, queryFn: fetchPaired, staleTime: 0 })
}

export function refreshPairedList(): void {
  void queryClient.invalidateQueries({ queryKey: KEY })
}
