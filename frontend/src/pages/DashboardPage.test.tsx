import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setToken } from '../auth/tokenStore'
import { DashboardPage } from './DashboardPage'

// Recharts cannot measure a container under jsdom and warns about it. Charts are not
// asserted on here, so only ResponsiveContainer is replaced; everything else is real.
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: () => <div data-testid="chart" />,
}))

const summary = {
  active_accounts: 42,
  total_monthly_value: '12345.50',
  net_revenue_30d: '9000.00',
  net_revenue_prev_30d: '8000.00',
  net_revenue_change_pct: 12.5,
}

const top = [
  { account_id: 'acc-1', name: 'Alpha Co', tier: 'gold', net_revenue: '5000.00' },
  { account_id: 'acc-2', name: 'Beta Co', tier: 'silver', net_revenue: '1234.00' },
]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function stubApi(overrides: { summary?: () => Response } = {}) {
  const fetchMock = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input))
    switch (url.pathname) {
      case '/api/analytics/summary':
        return overrides.summary ? overrides.summary() : json(summary)
      case '/api/analytics/timeseries':
        return json(
          url.searchParams.get('metric') === 'net_revenue'
            ? [{ period: '2026-10-01', value: '100.00' }]
            : [{ period: '2026-10-01', value: 3 }],
        )
      case '/api/analytics/top-accounts':
        return json(top)
      case '/api/accounts':
        return json({ items: [], total: 7, page: 1, page_size: 1 })
      default:
        return json({ error: { code: 'not_found', message: 'nope' } }, 404)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderDashboard() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => setToken('test-token'))
afterEach(() => {
  setToken(null)
  vi.useRealTimers()
})

describe('DashboardPage', () => {
  it('shows the four metric cards with formatted values', async () => {
    stubApi()
    renderDashboard()
    expect(await screen.findByText('$12,345.50')).toBeInTheDocument()
    expect(screen.getByText('$9,000.00')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('Active gold accounts').nextElementSibling).toHaveTextContent('7')
    expect(screen.getByText(/12\.5%/)).toBeInTheDocument()
  })

  it('shows no change indicator when the change is null', async () => {
    stubApi({ summary: () => json({ ...summary, net_revenue_change_pct: null }) })
    renderDashboard()
    expect(await screen.findByText('$9,000.00')).toBeInTheDocument()
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
  })

  it('lists the top accounts with links to their pages', async () => {
    stubApi()
    renderDashboard()
    const alpha = await screen.findByRole('link', { name: 'Alpha Co' })
    expect(alpha).toHaveAttribute('href', '/accounts/acc-1')
    expect(screen.getByRole('link', { name: 'Beta Co' })).toHaveAttribute('href', '/accounts/acc-2')
    expect(within(screen.getByRole('table')).getByText('$5,000.00')).toBeInTheDocument()
  })

  it('shows an error state with a retry button when the summary fails', async () => {
    let calls = 0
    stubApi({
      summary: () => {
        calls += 1
        return calls === 1
          ? json({ error: { code: 'server_error', message: 'Summary exploded' } }, 500)
          : json(summary)
      },
    })
    renderDashboard()
    expect(await screen.findByText('Summary exploded')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('$12,345.50')).toBeInTheDocument()
    expect(screen.queryByText('Summary exploded')).not.toBeInTheDocument()
  })

  it('asks for the series from the first day of the month eleven months ago', async () => {
    // Only Date is faked, so timers and promises keep running normally.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'))
    const fetchMock = stubApi()
    renderDashboard()
    await screen.findByText('$12,345.50')
    const series = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname === '/api/analytics/timeseries')
    expect(series.map((u) => u.searchParams.get('metric')).sort()).toEqual([
      'net_revenue',
      'new_accounts',
    ])
    for (const url of series) {
      expect(url.searchParams.get('from')).toBe('2025-04-01')
      expect(url.searchParams.get('interval')).toBe('month')
    }
  })
})
