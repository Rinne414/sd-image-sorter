import { useQuery } from '@tanstack/react-query'

/** Whether this install holds the desktop program (GET /api/updates/desktop-program). */
export interface DesktopProgram {
  windows: boolean
  installed: boolean
  launcher: string
  download_url: string
}

/**
 * In-app updates never install the desktop program, so a browser user may
 * have none in the program folder; Settings › Desktop then says how to get it.
 */
export function useDesktopProgram(enabled: boolean) {
  return useQuery({
    queryKey: ['desktop', 'program'],
    queryFn: async ({ signal }): Promise<DesktopProgram> => {
      const response = await fetch('/api/updates/desktop-program', { signal, headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return (await response.json()) as DesktopProgram
    },
    enabled,
    staleTime: Infinity,
    retry: false,
  })
}
