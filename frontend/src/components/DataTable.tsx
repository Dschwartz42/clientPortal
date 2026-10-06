import type { ReactNode } from 'react'
import { Button } from './Button'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'

export interface Column<T> {
  key: string
  header: string
  render?: (row: T) => ReactNode
  sortable?: boolean
}

interface Props<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey?: (row: T) => string | number
  /** API sort format: "name" ascending, "-name" descending. */
  sort?: string
  onSortChange?: (sort: string) => void
  page?: number
  pageSize?: number
  total?: number
  onPageChange?: (page: number) => void
  onRowClick?: (row: T) => void
  loading?: boolean
  emptyMessage?: string
}

function cell<T>(row: T, column: Column<T>): ReactNode {
  if (column.render) return column.render(row)
  const value = (row as Record<string, unknown>)[column.key]
  return value === null || value === undefined ? '' : String(value)
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  page,
  pageSize,
  total,
  onPageChange,
  onRowClick,
  loading = false,
  emptyMessage = 'No results.',
}: Props<T>) {
  const sortKey = sort?.replace(/^-/, '')
  const descending = sort?.startsWith('-') ?? false
  // The pager renders only when all four paging props are supplied.
  const pager =
    page !== undefined && pageSize !== undefined && total !== undefined && onPageChange
      ? { page, total, onPageChange }
      : null
  const first = pager && pager.total > 0 ? (pager.page - 1) * (pageSize ?? 0) + 1 : 0
  const last = pager ? Math.min(pager.page * (pageSize ?? 0), pager.total) : 0

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              {columns.map((column) => {
                const active = sortKey === column.key
                const sortable = column.sortable && onSortChange
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className="px-4 py-2 font-medium"
                    aria-sort={active ? (descending ? 'descending' : 'ascending') : undefined}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-slate-900"
                        onClick={() =>
                          sortable(active && !descending ? `-${column.key}` : column.key)
                        }
                      >
                        {column.header}
                        <span aria-hidden="true">{active ? (descending ? '↓' : '↑') : '↕'}</span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {!loading &&
              rows.map((row, index) => (
                <tr
                  key={rowKey ? rowKey(row) : index}
                  className={`border-b border-slate-100 last:border-0 ${
                    onRowClick ? 'cursor-pointer hover:bg-slate-50' : ''
                  }`}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key === 'Enter') onRowClick(row)
                        }
                      : undefined
                  }
                >
                  {columns.map((column) => (
                    <td key={column.key} className="px-4 py-2">
                      {cell(row, column)}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
        {loading && (
          <div className="p-4">
            <LoadingSkeleton rows={5} />
          </div>
        )}
        {!loading && rows.length === 0 && <EmptyState message={emptyMessage} />}
      </div>

      {pager && (
        <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
          <span>
            Showing {first}–{last} of {pager.total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={pager.page <= 1}
              onClick={() => pager.onPageChange(pager.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={last >= pager.total}
              onClick={() => pager.onPageChange(pager.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
