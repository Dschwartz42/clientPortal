import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useAccount, useAccountTransactions, useUpdateAccount } from '../api/hooks'
import { RoleGate } from '../auth/RoleGate'
import { Button } from '../components/Button'
import { type Column, DataTable } from '../components/DataTable'
import { ErrorState } from '../components/ErrorState'
import { LoadingSkeleton } from '../components/LoadingSkeleton'
import { Modal } from '../components/Modal'
import { StatusBadge } from '../components/StatusBadge'
import { formatDate, formatDateTime, formatValue } from '../lib/format'
import type { Transaction } from '../types/api'
import { AccountFormModal } from './AccountFormModal'
import { NotFoundPage } from './NotFoundPage'

const transactionColumns: Column<Transaction>[] = [
  { key: 'occurred_at', header: 'Date', render: (row) => formatDateTime(row.occurred_at) },
  { key: 'type', header: 'Type' },
  {
    key: 'amount',
    header: 'Amount',
    // Amounts are always positive; the type decides the sign.
    render: (row) =>
      `${row.type === 'charge' ? '' : '−'}${formatValue(row.amount, 'currency')}`,
  },
  { key: 'description', header: 'Description' },
]

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  )
}

export function AccountDetailPage() {
  const { id = '' } = useParams()
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const account = useAccount(id)
  const transactions = useAccountTransactions(id, page)
  const update = useUpdateAccount(id)

  if (account.isPending) return <LoadingSkeleton rows={8} />
  // Another tenant's account and a non-existent one look identical: both are 404.
  if (account.isError) {
    if (account.error instanceof ApiError && [404, 422].includes(account.error.status)) {
      return <NotFoundPage />
    }
    return <ErrorState message={account.error.message} onRetry={() => account.refetch()} />
  }
  const a = account.data

  return (
    <div className="space-y-6">
      <Link to="/accounts" className="text-sm underline">
        ← Accounts
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{a.name}</h1>
          <StatusBadge status={a.status} />
        </div>
        <RoleGate role="admin">
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {a.status !== 'closed' && (
              <Button variant="danger" onClick={() => setConfirmingClose(true)}>
                Close account
              </Button>
            )}
          </div>
        </RoleGate>
      </div>

      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-white p-4 md:grid-cols-3">
        <Detail label="Tier" value={a.tier} />
        <Detail label="Monthly value" value={formatValue(a.monthly_value, 'currency')} />
        <Detail label="Net revenue (30 days)" value={formatValue(a.revenue_30d, 'currency')} />
        <Detail label="Owner" value={a.owner_name ?? 'Unassigned'} />
        <Detail label="Opened" value={formatDate(a.opened_at)} />
        <Detail label="Closed" value={a.closed_at ? formatDate(a.closed_at) : '—'} />
      </dl>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Transactions</h2>
        {transactions.isError ? (
          <ErrorState
            message={transactions.error.message}
            onRetry={() => transactions.refetch()}
          />
        ) : (
          <DataTable
            columns={transactionColumns}
            rows={transactions.data?.items ?? []}
            rowKey={(row) => row.id}
            page={page}
            pageSize={10}
            total={transactions.data?.total ?? 0}
            onPageChange={setPage}
            loading={transactions.isPending}
            emptyMessage="No transactions for this account yet."
          />
        )}
      </section>

      {editing && (
        <AccountFormModal
          account={a}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}

      <Modal
        title="Close this account?"
        open={confirmingClose}
        onClose={() => setConfirmingClose(false)}
      >
        <p className="text-sm text-slate-600">
          {a.name} will be marked closed as of today. Its transactions are kept.
        </p>
        {update.isError && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {update.error.message}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmingClose(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({ status: 'closed' }, { onSuccess: () => setConfirmingClose(false) })
            }
          >
            Close account
          </Button>
        </div>
      </Modal>
    </div>
  )
}
