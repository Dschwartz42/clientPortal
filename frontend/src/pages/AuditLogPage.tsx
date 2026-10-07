import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuditLog } from '../api/hooks'
import { type Column, DataTable } from '../components/DataTable'
import { ErrorState } from '../components/ErrorState'
import { inputClass } from '../components/styles'
import { formatDateTime } from '../lib/format'
import { isUuid } from '../lib/uuid'
import type { AuditEntry } from '../types/api'

const ACTIONS = [
  'account.created',
  'account.updated',
  'account.deleted',
  'user.invited',
  'user.role_changed',
  'user.deactivated',
  'user.reactivated',
]

const columns: Column<AuditEntry>[] = [
  { key: 'created_at', header: 'When', render: (row) => formatDateTime(row.created_at) },
  { key: 'actor_name', header: 'Who', render: (row) => row.actor_name ?? 'Unknown user' },
  { key: 'action', header: 'Action' },
  {
    key: 'target',
    header: 'Target',
    render: (row) => {
      const label = `${row.entity_type} ${row.entity_id.slice(0, 8)}`
      // Only a server-shaped id may reach a router path.
      return row.entity_type === 'account' && isUuid(row.entity_id) ? (
        <Link to={`/accounts/${row.entity_id}`} className="font-medium underline">
          {label}
        </Link>
      ) : (
        <span>{label}</span>
      )
    },
  },
  {
    key: 'details',
    header: 'Details',
    render: (row) => (
      <code className="block max-w-md whitespace-pre-wrap break-all text-xs text-slate-600">
        {JSON.stringify(row.details)}
      </code>
    ),
  },
]

export function AuditLogPage() {
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const query = useAuditLog({ action, page })

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Audit log</h1>
      <select
        className={`${inputClass} max-w-56`}
        aria-label="Action"
        value={action}
        onChange={(e) => {
          setAction(e.target.value)
          setPage(1)
        }}
      >
        <option value="">All actions</option>
        {ACTIONS.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>

      {query.isError ? (
        <ErrorState message={query.error.message} onRetry={() => query.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={query.data?.items ?? []}
          rowKey={(row) => row.id}
          page={page}
          pageSize={query.data?.page_size ?? 25}
          total={query.data?.total ?? 0}
          onPageChange={setPage}
          loading={query.isPending}
          emptyMessage="No audit entries match."
        />
      )}
    </div>
  )
}
