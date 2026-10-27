import { useQuery } from '@tanstack/react-query'
import { rawJson } from '../../api/raw'
import { queryClient } from '../../api/queryClient'
import { readOutputFolders, type OutputFolders } from './outputFolders'

// The output-folder root. Not in the generated schema yet, so called directly.

export const OUTPUT_KEY = ['output-folders'] as const
const URL = '/api/output-folders'

function answer(raw: unknown): OutputFolders {
  const out = readOutputFolders(raw)
  if (!out) throw new Error('unreadable answer')
  return out
}

/** The root and the folder of each feature (read once; a save below replaces it). */
export function useOutputFolders() {
  return useQuery({
    queryKey: OUTPUT_KEY,
    queryFn: async ({ signal }) => answer(await rawJson<unknown>('GET', URL, { signal })),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
}

/** Move every save to another root; '' goes back to the program's own folder. Throws the server's reason. */
export async function saveOutputRoot(root: string): Promise<OutputFolders> {
  const out = answer(await rawJson<unknown>('PATCH', URL, { body: { root } }))
  queryClient.setQueryData(OUTPUT_KEY, out)
  return out
}
