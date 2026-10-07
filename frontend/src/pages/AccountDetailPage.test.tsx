import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth/AuthContext'
import { setToken } from '../auth/tokenStore'
import type { Role } from '../types/api'
import { AccountDetailPage } from './AccountDetailPage'

const detail = {
  id: 'acc-1',
  name: 'Alpha Co',
  status: 'active',
  tier: 'gold',
  monthly_value: '1234.50',
  owner_user_id: 'u1',
  opened_at: '2026-03-01',
  closed_at: null,
  created_at: '2026-03-01T00:00:00Z',
  owner_name: 'Olive Owner',
  revenue_30d: '777.25',
}

function tx(n: number, type: 'charge' | 'refund' | 'credit', amount: string) {
  return {
    id: `t${n}`,
    account_id: 'acc-1',
    type,
    amount,
    description: `Tx ${n}`,
    occurred_at: '2026-09-15T20:00:00Z',
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

interface Opts {
  account?: () => Response
  transactions?: (url: URL) => Response
  patch?: (body: unknown) => Response
}

function stubApi(opts: Opts = {}) {
  const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/accounts/acc-1' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      return opts.patch ? opts.patch(body) : json({ ...detail, ...body })
    }
    if (url.pathname === '/api/accounts/acc-1') return opts.account ? opts.account() : json(detail)
    if (url.pathname === '/api/accounts/acc-1/transactions') {
      return opts.transactions
        ? opts.transactions(url)
        : json({
            items: [tx(1, 'charge', '100.00'), tx(2, 'refund', '20.00'), tx(3, 'credit', '5.00')],
            total: 3,
            page: 1,
            page_size: 10,
          })
    }
    if (url.pathname === '/api/users') return json({ items: [], total: 0, page: 1, page_size: 100 })
    return json({ error: { code: 'not_found', message: 'nope' } }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPage(role: Role = 'member') {
  const value: AuthState = {
    user: {
      id: 'u1',
      email: `${role}@acme.test`,
      full_name: 'Test Person',
      role,
      org_id: 'o1',
      org_name: 'Acme',
    },
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
  }
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={value}>
        <MemoryRouter initialEntries={['/accounts/acc-1']}>
          <Routes>
            <Route path="/accounts/:id" element={<AccountDetailPage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => setToken('test-token'))
afterEach(() => setToken(null))

describe('AccountDetailPage', () => {
  it('shows the account facts', async () => {
    stubApi()
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Alpha Co' })).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByText('Tier').nextElementSibling).toHaveTextContent('gold')
    expect(screen.getByText('Monthly value').nextElementSibling).toHaveTextContent('$1,234.50')
    expect(screen.getByText('Net revenue (30 days)').nextElementSibling).toHaveTextContent('$777.25')
    expect(screen.getByText('Owner').nextElementSibling).toHaveTextContent('Olive Owner')
    expect(screen.getByText('Opened').nextElementSibling).toHaveTextContent('Mar 1, 2026')
    expect(screen.getByText('Closed').nextElementSibling).toHaveTextContent('—')
  })

  it('shows Unassigned when there is no owner', async () => {
    stubApi({ account: () => json({ ...detail, owner_user_id: null, owner_name: null }) })
    renderPage()
    expect(await screen.findByText('Unassigned')).toBeInTheDocument()
  })

  it('lists transactions with refunds and credits negative', async () => {
    stubApi()
    renderPage()
    const row = (text: string) => screen.findByText(text).then((el) => el.closest('tr') as HTMLElement)
    expect(within(await row('Tx 1')).getByText('$100.00')).toBeInTheDocument()
    expect(within(await row('Tx 2')).getByText('−$20.00')).toBeInTheDocument()
    expect(within(await row('Tx 3')).getByText('−$5.00')).toBeInTheDocument()
  })

  it.each([404, 422])('renders the not-found page for a %i', async (status) => {
    stubApi({
      account: () => json({ error: { code: 'not_found', message: 'Account not found' } }, status),
    })
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })

  it('renders the error state for a 500', async () => {
    stubApi({
      account: () => json({ error: { code: 'server_error', message: 'Database down' } }, 500),
    })
    renderPage()
    expect(await screen.findByText('Database down')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Page not found' })).not.toBeInTheDocument()
  })

  it('offers Edit and Close account to an admin', async () => {
    stubApi()
    renderPage('admin')
    await screen.findByRole('heading', { name: 'Alpha Co' })
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close account' })).toBeInTheDocument()
  })

  it('offers neither to a member', async () => {
    stubApi()
    renderPage('member')
    await screen.findByRole('heading', { name: 'Alpha Co' })
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close account' })).not.toBeInTheDocument()
  })

  it('does not offer Close account for a closed account', async () => {
    stubApi({
      account: () => json({ ...detail, status: 'closed', closed_at: '2026-09-01' }),
    })
    renderPage('admin')
    await screen.findByRole('heading', { name: 'Alpha Co' })
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close account' })).not.toBeInTheDocument()
    expect(screen.getByText('Closed').nextElementSibling).toHaveTextContent('Sep 1, 2026')
  })

  it('confirming the close dialog sends PATCH with status closed', async () => {
    const fetchMock = stubApi()
    renderPage('admin')
    await userEvent.click(await screen.findByRole('button', { name: 'Close account' }))
    const dialog = screen.getByRole('dialog', { name: 'Close this account?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close account' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Close this account?' })).not.toBeInTheDocument(),
    )
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(new URL(String(patch[0])).pathname).toBe('/api/accounts/acc-1')
    expect(patch[1]?.body).toBe('{"status":"closed"}')
  })

  it('requests the next transactions page', async () => {
    const fetchMock = stubApi({
      transactions: () =>
        json({ items: [tx(1, 'charge', '100.00')], total: 25, page: 1, page_size: 10 }),
    })
    renderPage()
    await screen.findByText('Tx 1')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      const pages = fetchMock.mock.calls
        .map(([input]) => new URL(String(input)))
        .filter((u) => u.pathname === '/api/accounts/acc-1/transactions')
        .map((u) => u.searchParams.get('page'))
      expect(pages).toEqual(['1', '2'])
    })
  })
})
