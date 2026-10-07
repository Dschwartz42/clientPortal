import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useAccounts,
  useAnalyticsSummary,
  useTimeseries,
  useTopAccounts,
} from '../api/hooks'
import { type Column, DataTable } from '../components/DataTable'
import { ErrorState } from '../components/ErrorState'
import { MetricCard } from '../components/MetricCard'
import { Panel } from '../components/Panel'
import { TrendChart } from '../components/TrendChart'
import { formatValue } from '../lib/format'
import type { TopAccount } from '../types/api'

/** First day of the month 11 months ago: twelve monthly points including this month. */
function twelveMonthsFrom(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))
    .toISOString()
    .slice(0, 10)
}

const topColumns: Column<TopAccount>[] = [
  {
    key: 'name',
    header: 'Account',
    render: (row) => (
      <Link to={`/accounts/${row.account_id}`} className="font-medium underline">
        {row.name}
      </Link>
    ),
  },
  { key: 'tier', header: 'Tier' },
  {
    key: 'net_revenue',
    header: 'Net revenue (90d)',
    render: (row) => formatValue(row.net_revenue, 'currency'),
  },
]

export function DashboardPage() {
  const [from] = useState(twelveMonthsFrom)
  const summary = useAnalyticsSummary()
  // The summary has no per-tier count; the list endpoint's total gives it without new API.
  const gold = useAccounts({ tier: 'gold', status: 'active', page_size: 1 })
  const revenue = useTimeseries('net_revenue', 'month', from)
  const newAccounts = useTimeseries('new_accounts', 'month', from)
  const top = useTopAccounts()
  // After a failed request no number is known; '' renders as a dash, never as 0.
  const s = summary.isError ? undefined : summary.data
  const goldTotal = gold.isError ? undefined : gold.data?.total

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>

      {summary.isError && (
        <ErrorState message={summary.error.message} onRetry={() => summary.refetch()} />
      )}
      {gold.isError && (
        <ErrorState
          message={`Could not load the gold account count: ${gold.error.message}`}
          onRetry={() => gold.refetch()}
        />
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Active accounts"
          value={s?.active_accounts ?? ''}
          loading={summary.isPending}
        />
        <MetricCard
          label="Total monthly value"
          value={s?.total_monthly_value ?? ''}
          format="currency"
          loading={summary.isPending}
        />
        <MetricCard
          label="Net revenue (30 days)"
          value={s?.net_revenue_30d ?? ''}
          change={s?.net_revenue_change_pct}
          format="currency"
          loading={summary.isPending}
        />
        <MetricCard
          label="Active gold accounts"
          value={goldTotal ?? ''}
          loading={gold.isPending}
        />
      </div>

      <Panel title="Net revenue, last 12 months" query={revenue}>
        {(data) => <TrendChart data={data} type="line" format="currency" />}
      </Panel>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel title="New accounts per month" query={newAccounts}>
          {(data) => <TrendChart data={data} type="bar" />}
        </Panel>
        <Panel title="Top 5 accounts" query={top} isEmpty={(data) => data.length === 0}>
          {(data) => (
            <DataTable columns={topColumns} rows={data} rowKey={(row) => row.account_id} />
          )}
        </Panel>
      </div>
    </div>
  )
}
