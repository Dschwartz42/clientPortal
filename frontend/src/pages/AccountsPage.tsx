import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAccounts } from '../api/hooks'
import { RoleGate } from '../auth/RoleGate'
import { Button } from '../components/Button'
import { type Column, DataTable } from '../components/DataTable'
import { ErrorState } from '../components/ErrorState'
import { StatusBadge } from '../components/StatusBadge'
import { inputClass } from '../components/styles'
import { formatDate, formatValue } from '../lib/format'
import type { Account } from '../types/api'
import { AccountFormModal } from './AccountFormModal'

const PAGE_SIZE = 25

const columns: Column<Account>[] = [
  {
    key: 'name',
    header: 'Name',
    sortable: true,
    // A real link, so the account can be opened in a new tab; the row click is a convenience.
    render: (row) => (
      <Link to={`/accounts/${row.id}`} className="font-medium underline">
        {row.name}
      </Link>
    ),
  },
  { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
  { key: 'tier', header: 'Tier' },
  {
    key: 'monthly_value',
    header: 'Monthly value',
    sortable: true,
    render: (row) => formatValue(row.monthly_value, 'currency'),
  },
  { key: 'opened_at', header: 'Opened', sortable: true, render: (row) => formatDate(row.opened_at) },
]

// The API rejects pages above 1,000,000, and a hand-edited URL may hold anything.
function parsePage(raw: string | null): number {
  if (raw === null || !/^\d{1,7}$/.test(raw)) return 1
  const n = Number(raw)
  return n >= 1 && n <= 1_000_000 ? n : 1
}

const STATUSES = ['active', 'paused', 'closed']
const TIERS = ['bronze', 'silver', 'gold']
const SORT_FIELDS = ['name', 'monthly_value', 'opened_at', 'created_at', 'status', 'tier']
const SORTS = [...SORT_FIELDS, ...SORT_FIELDS.map((field) => `-${field}`)]
const MAX_SEARCH = 100

// Values from the URL are untrusted: anything outside the known set falls back to the default,
// so the control and the request always show the same value.
function oneOf(raw: string | null, allowed: string[], fallback: string): string {
  return raw !== null && allowed.includes(raw) ? raw : fallback
}

function parseSearch(raw: string | null): string {
  return (raw ?? '').replaceAll('\0', '').slice(0, MAX_SEARCH)
}

export function AccountsPage() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  // Filters live in the URL, so a filtered view can be bookmarked, shared and refreshed.
  const [params, setParams] = useSearchParams()
  const filters = {
    search: parseSearch(params.get('search')),
    status: oneOf(params.get('status'), STATUSES, ''),
    tier: oneOf(params.get('tier'), TIERS, ''),
    sort: oneOf(params.get('sort'), SORTS, 'name'),
    page: parsePage(params.get('page')),
  }
  const query = useAccounts({ ...filters, page_size: PAGE_SIZE })

  function update(changes: Record<string, string>) {
    const next = new URLSearchParams(params)
    // Any change other than paging goes back to page 1.
    if (!('page' in changes)) next.delete('page')
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    setParams(next, { replace: true })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Accounts</h1>
        <RoleGate role="admin">
          <Button onClick={() => setCreating(true)}>New account</Button>
        </RoleGate>
      </div>

      <div className="flex flex-wrap gap-3">
        <input
          className={`${inputClass} max-w-xs`}
          type="search"
          placeholder="Search by name"
          aria-label="Search by name"
          maxLength={MAX_SEARCH}
          value={filters.search}
          onChange={(e) => update({ search: e.target.value })}
        />
        <select
          className={`${inputClass} max-w-40`}
          aria-label="Status"
          value={filters.status}
          onChange={(e) => update({ status: e.target.value })}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="closed">Closed</option>
        </select>
        <select
          className={`${inputClass} max-w-40`}
          aria-label="Tier"
          value={filters.tier}
          onChange={(e) => update({ tier: e.target.value })}
        >
          <option value="">All tiers</option>
          <option value="bronze">Bronze</option>
          <option value="silver">Silver</option>
          <option value="gold">Gold</option>
        </select>
      </div>

      {query.isError ? (
        <ErrorState message={query.error.message} onRetry={() => query.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={query.data?.items ?? []}
          rowKey={(row) => row.id}
          sort={filters.sort}
          onSortChange={(sort) => update({ sort })}
          page={filters.page}
          pageSize={PAGE_SIZE}
          total={query.data?.total ?? 0}
          onPageChange={(page) => update({ page: String(page) })}
          onRowClick={(row) => navigate(`/accounts/${row.id}`)}
          loading={query.isPending}
          emptyMessage="No accounts match these filters."
        />
      )}

      {creating && (
        <AccountFormModal
          onClose={() => setCreating(false)}
          onSaved={(account) => navigate(`/accounts/${account.id}`)}
        />
      )}
    </div>
  )
}
