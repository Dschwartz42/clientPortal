import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { EmptyState } from './EmptyState'
import { ErrorState } from './ErrorState'
import { LoadingSkeleton } from './LoadingSkeleton'

interface Props<T> {
  title: string
  query: UseQueryResult<T>
  isEmpty?: (data: T) => boolean
  children: (data: T) => ReactNode
}

/** A titled card that renders a query's loading, error, empty and loaded states. */
export function Panel<T>({ title, query, isEmpty, children }: Props<T>) {
  let body: ReactNode
  if (query.isPending) body = <LoadingSkeleton rows={4} />
  else if (query.isError)
    body = <ErrorState message={query.error.message} onRetry={() => query.refetch()} />
  else if (isEmpty?.(query.data)) body = <EmptyState message="Nothing to show yet." />
  else body = children(query.data)

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-700">{title}</h2>
      {body}
    </section>
  )
}
