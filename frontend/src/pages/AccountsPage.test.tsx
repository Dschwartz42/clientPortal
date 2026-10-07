import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth/AuthContext'
import { setToken } from '../auth/tokenStore'
import type { Role } from '../types/api'
import { AccountsPage } from './AccountsPage'

function account(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `acc-${n}`,
    name: `Account ${n}`,
    status: 'active',
    tier: 'gold',
    monthly_value: '1234.50',
    owner_user_id: null,
    opened_at: '2026-03-01',
    closed_at: null,
    created_at: '2026-03-01T00:00:00Z',
    ...overrides,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

type Responder = (url: URL) => Response

function stubApi(responder?: Responder) {
  const fetchMock = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/accounts') {
      return responder
        ? responder(url)
        : json({ items: [account(1), account(2)], total: 2, page: 1, page_size: 25 })
    }
    return json({ error: { code: 'not_found', message: 'nope' } }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function listCalls(fetchMock: ReturnType<typeof stubApi>) {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input)))
    .filter((url) => url.pathname === '/api/accounts')
}

function lastRequest(fetchMock: ReturnType<typeof stubApi>) {
  return listCalls(fetchMock).at(-1)!
}

function Where() {
  const location = useLocation()
  return <div data-testid="where">{location.pathname + location.search}</div>
}

function Back() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(-1)}>
      test-back
    </button>
  )
}

function renderPage(path = '/accounts', role: Role = 'member') {
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
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/accounts/:id" element={<h1>Detail page</h1>} />
          </Routes>
          <Where />
          <Back />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

const where = () => screen.getByTestId('where').textContent ?? ''
const query = () => new URLSearchParams(where().split('?')[1] ?? '')

beforeEach(() => setToken('test-token'))
afterEach(() => setToken(null))

describe('AccountsPage', () => {
  it('renders the rows with formatted money and dates', async () => {
    stubApi()
    renderPage()
    expect(await screen.findByText('Account 1')).toBeInTheDocument()
    expect(screen.getAllByText('$1,234.50')).toHaveLength(2)
    expect(screen.getAllByText('Mar 1, 2026')).toHaveLength(2)
    expect(screen.getByText('Showing 1–2 of 2')).toBeInTheDocument()
  })

  it('typing in search updates the URL and the request, and resets the page', async () => {
    const fetchMock = stubApi()
    renderPage('/accounts?page=3')
    await screen.findByText('Account 1')
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search by name' }), 'ab')
    expect(query().get('search')).toBe('ab')
    expect(query().has('page')).toBe(false)
    await waitFor(() => expect(lastRequest(fetchMock).searchParams.get('search')).toBe('ab'))
    expect(lastRequest(fetchMock).searchParams.get('page')).toBe('1')
  })

  it('search replaces the history entry instead of adding one per keystroke', async () => {
    stubApi()
    renderPage('/accounts?status=closed')
    await screen.findByText('Account 1')
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search by name' }), 'abc')
    expect(query().get('search')).toBe('abc')
    // With push, going back would land on ?search=ab. With replace there is nothing to go back to.
    await userEvent.click(screen.getByRole('button', { name: 'test-back' }))
    expect(query().get('search')).toBe('abc')
  })

  it('choosing a status updates the URL and the request', async () => {
    const fetchMock = stubApi()
    renderPage('/accounts?page=2')
    await screen.findByText('Account 1')
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'paused')
    expect(query().get('status')).toBe('paused')
    expect(query().has('page')).toBe(false)
    await waitFor(() => expect(lastRequest(fetchMock).searchParams.get('status')).toBe('paused'))
    expect(lastRequest(fetchMock).searchParams.get('page')).toBe('1')
  })

  it('choosing a tier updates the URL and the request', async () => {
    const fetchMock = stubApi()
    renderPage('/accounts?page=2')
    await screen.findByText('Account 1')
    await userEvent.selectOptions(screen.getByLabelText('Tier'), 'silver')
    expect(query().get('tier')).toBe('silver')
    expect(query().has('page')).toBe(false)
    await waitFor(() => expect(lastRequest(fetchMock).searchParams.get('tier')).toBe('silver'))
    expect(lastRequest(fetchMock).searchParams.get('page')).toBe('1')
  })

  it('clicking a sortable header updates the URL and the request, and resets the page', async () => {
    const fetchMock = stubApi()
    renderPage('/accounts?page=2')
    await screen.findByText('Account 1')
    await userEvent.click(screen.getByRole('button', { name: /Monthly value/ }))
    expect(query().get('sort')).toBe('monthly_value')
    expect(query().has('page')).toBe(false)
    await waitFor(() => expect(lastRequest(fetchMock).searchParams.get('sort')).toBe('monthly_value'))
    expect(lastRequest(fetchMock).searchParams.get('page')).toBe('1')
    await userEvent.click(screen.getByRole('button', { name: /Monthly value/ }))
    expect(query().get('sort')).toBe('-monthly_value')
    await waitFor(() => expect(lastRequest(fetchMock).searchParams.get('sort')).toBe('-monthly_value'))
  })

  it('reads its initial state from the URL', async () => {
    const fetchMock = stubApi()
    renderPage('/accounts?status=closed&sort=-monthly_value&page=2')
    await screen.findByText('Account 1')
    const request = listCalls(fetchMock)[0]
    expect(request.searchParams.get('status')).toBe('closed')
    expect(request.searchParams.get('sort')).toBe('-monthly_value')
    expect(request.searchParams.get('page')).toBe('2')
    expect(screen.getByLabelText('Status')).toHaveValue('closed')
    expect(screen.getByLabelText('Tier')).toHaveValue('')
    expect(screen.getByRole('columnheader', { name: /Monthly value/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
  })

  it.each(['abc', '0', '-2', '1.5', '99999999'])('falls back to page 1 for page=%s', async (bad) => {
    const fetchMock = stubApi()
    renderPage(`/accounts?page=${bad}`)
    await screen.findByText('Account 1')
    expect(listCalls(fetchMock)[0].searchParams.get('page')).toBe('1')
  })

  it('navigates to the account when a row is clicked', async () => {
    stubApi()
    renderPage()
    await userEvent.click(await screen.findByText('Account 2'))
    expect(await screen.findByRole('heading', { name: 'Detail page' })).toBeInTheDocument()
    expect(where()).toBe('/accounts/acc-2')
  })

  it('shows the empty message when there are no rows, but not while loading', async () => {
    stubApi(() => json({ items: [], total: 0, page: 1, page_size: 25 }))
    renderPage()
    expect(screen.queryByText('No accounts match these filters.')).not.toBeInTheDocument()
    expect(await screen.findByText('No accounts match these filters.')).toBeInTheDocument()
  })

  it('shows an error state with Try again', async () => {
    let calls = 0
    stubApi(() => {
      calls += 1
      return calls === 1
        ? json({ error: { code: 'server_error', message: 'List exploded' } }, 500)
        : json({ items: [account(1)], total: 1, page: 1, page_size: 25 })
    })
    renderPage()
    expect(await screen.findByText('List exploded')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Account 1')).toBeInTheDocument()
    expect(screen.queryByText('List exploded')).not.toBeInTheDocument()
  })

  it('offers New account to an admin only', async () => {
    stubApi()
    const { unmount } = renderPage('/accounts', 'admin')
    await screen.findByText('Account 1')
    expect(screen.getByRole('button', { name: 'New account' })).toBeInTheDocument()
    unmount()
    renderPage('/accounts', 'member')
    await screen.findByText('Account 1')
    expect(screen.queryByRole('button', { name: 'New account' })).not.toBeInTheDocument()
  })

  it('opens the form for an admin and lands on the new account after saving', async () => {
    stubApi()
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/users') return json({ items: [], total: 0, page: 1, page_size: 100 })
      if (init?.method === 'POST') return json(account(9), 201)
      return json({ items: [account(1)], total: 1, page: 1, page_size: 25 })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPage('/accounts', 'admin')
    await screen.findByText('Account 1')
    await userEvent.click(screen.getByRole('button', { name: 'New account' }))
    const dialog = screen.getByRole('dialog', { name: 'New account' })
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Fresh')
    await userEvent.type(within(dialog).getByLabelText('Monthly value (USD)'), '10')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('heading', { name: 'Detail page' })).toBeInTheDocument()
    expect(where()).toBe('/accounts/acc-9')
  })
})
