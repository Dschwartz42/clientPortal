import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { ApiError } from './client'

// A 403 from any request means the caller's role may have changed on the server. The
// client cannot know about the auth layer, so it only announces the fact; AuthProvider
// listens and re-reads the user. One announcement per failed request is fine: refreshing
// is deduplicated there, and the refresh itself goes through apiFetch, not the caches,
// so it can never announce another 403 and cannot loop.
const forbiddenListeners = new Set<() => void>()

export function onForbidden(listener: () => void): () => void {
  forbiddenListeners.add(listener)
  return () => {
    forbiddenListeners.delete(listener)
  }
}

function announceIfForbidden(error: unknown): void {
  if (error instanceof ApiError && error.status === 403) {
    for (const listener of [...forbiddenListeners]) listener()
  }
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: announceIfForbidden }),
    mutationCache: new MutationCache({ onError: announceIfForbidden }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retrying a 4xx never helps; retry server and network errors once.
        retry: (failures, error) =>
          failures < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
    },
  })
}
