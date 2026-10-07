import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
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

function stubApi(overrides: { summary?: () => Response; accounts?: () => Response } = {}) {
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
        return overrides.accounts
          ? overrides.accounts()
          : json({ items: [], total: 7, page: 1, page_size: 1 })
      default:
        return json({ error: { code: 'not_found', message: 'nope' } }, 404)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The card element that holds a metric's label and value. */
function card(label: string): HTMLElement {
  const element = screen.getByText(label).parentElement
  if (!element) throw new Error(`No card for ${label}`)
  return element
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
    await waitFor(() => expect(within(card('Active gold accounts')).getByText('7')).toBeInTheDocument())
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

  it('shows a dash, not zeros, in the summary cards when the summary fails', async () => {
    stubApi({ summary: () => json({ error: { code: 'server_error', message: 'Summary exploded' } }, 500) })
    renderDashboard()
    expect(await screen.findByText('Summary exploded')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    for (const label of ['Active accounts', 'Total monthly value', 'Net revenue (30 days)']) {
      expect(card(label)).toHaveTextContent(`${label}—`)
    }
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
  })

  it('shows a dash and a retry for the gold card when only its request fails', async () => {
    const fetchMock = stubApi({
      accounts: () => json({ error: { code: 'server_error', message: 'Gold exploded' } }, 500),
    })
    renderDashboard()
    expect(await screen.findByText(/Gold exploded/)).toBeInTheDocument()
    expect(within(card('Active gold accounts')).getByText('—')).toBeInTheDocument()
    expect(card('Active gold accounts')).toHaveTextContent('Active gold accounts—')
    expect(within(card('Active accounts')).getByText('42')).toBeInTheDocument()
    expect(within(card('Total monthly value')).getByText('$12,345.50')).toBeInTheDocument()
    expect(within(card('Net revenue (30 days)')).getByText('$9,000.00')).toBeInTheDocument()

    const accountCalls = () =>
      fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/accounts')
        .length
    const before = accountCalls()
    const alert = screen.getByText(/Gold exploded/).closest('[role="alert"]')
    if (!(alert instanceof HTMLElement)) throw new Error('no alert')
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(accountCalls()).toBe(before + 1))
  })

  it('retries the summary request from its own error state', async () => {
    let calls = 0
    const fetchMock = stubApi({
      summary: () => {
        calls += 1
        return json({ error: { code: 'server_error', message: 'Summary exploded' } }, 500)
      },
    })
    renderDashboard()
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(calls).toBe(2))
    expect(fetchMock).toHaveBeenCalled()
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

  it('uses UTC months when the local date is still in the previous month', async () => {
    // 2026-03-01T00:30Z is still 28 February in Los Angeles; a local-time calculation
    // would give 2025-03-01 instead of 2025-04-01.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-01T00:30:00Z'))
    const fetchMock = stubApi()
    renderDashboard()
    await screen.findByText('$12,345.50')
    const froms = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname === '/api/analytics/timeseries')
      .map((url) => url.searchParams.get('from'))
    expect(froms).toEqual(['2025-04-01', '2025-04-01'])
  })
})
