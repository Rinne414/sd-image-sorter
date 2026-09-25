import { QueryClient } from '@tanstack/react-query'

// One client for the app. Exported so code outside React (job completion)
// can refresh what changed.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
})
