import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setToken } from '../auth/tokenStore'
import { AuditLogPage } from './AuditLogPage'

function entry(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: n,
    actor_user_id: 'u1',
    actor_name: `Actor ${n}`,
    action: 'account.created',
    entity_type: 'account',
    entity_id: `acc-${n}`,
    details: { name: `Account ${n}` },
    created_at: '2026-03-01T20:30:00Z',
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
    if (url.pathname === '/api/audit-log') {
      return responder
        ? responder(url)
        : json({ items: [entry(3), entry(2), entry(1)], total: 3, page: 1, page_size: 25 })
    }
    return json({ error: { code: 'not_found', message: 'nope' } }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function requests(fetchMock: ReturnType<typeof stubApi>) {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input)))
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuditLogPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => setToken('test-token'))
afterEach(() => setToken(null))

describe('AuditLogPage', () => {
  it('lists entries in the order returned, with time, actor, action and details', async () => {
    stubApi(() =>
      json({
        items: [
          entry(3, { actor_name: null, action: 'user.invited', details: { email: 'a@b.test' } }),
          entry(2),
          entry(1),
        ],
        total: 3,
        page: 1,
        page_size: 25,
      }),
    )
    renderPage()
    expect(await screen.findByText('Unknown user')).toBeInTheDocument()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('Unknown user')
    expect(rows[0]).toHaveTextContent('user.invited')
    expect(rows[0]).toHaveTextContent('{"email":"a@b.test"}')
    expect(rows[0]).toHaveTextContent('Mar 1, 2026, 12:30 PM')
    expect(rows[1]).toHaveTextContent('Actor 2')
    expect(rows[2]).toHaveTextContent('Actor 1')
    expect(rows[2]).toHaveTextContent('{"name":"Account 1"}')
  })

  it('choosing an action requests it and goes back to page 1', async () => {
    const fetchMock = stubApi(() => json({ items: [entry(1)], total: 60, page: 1, page_size: 25 }))
    renderPage()
    await screen.findByText('Actor 1')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(requests(fetchMock).at(-1)!.searchParams.get('page')).toBe('2'))
    await userEvent.selectOptions(screen.getByLabelText('Action'), 'user.deactivated')
    await waitFor(() => {
      const last = requests(fetchMock).at(-1)!
      expect(last.searchParams.get('action')).toBe('user.deactivated')
      expect(last.searchParams.get('page')).toBe('1')
    })
  })

  it('requests the next page when paging', async () => {
    const fetchMock = stubApi(() => json({ items: [entry(1)], total: 60, page: 1, page_size: 25 }))
    renderPage()
    await screen.findByText('Actor 1')
    expect(requests(fetchMock)[0].searchParams.get('page')).toBe('1')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(requests(fetchMock).at(-1)!.searchParams.get('page')).toBe('2'))
  })

  it('shows the loading state, then the empty state', async () => {
    stubApi(() => json({ items: [], total: 0, page: 1, page_size: 25 }))
    renderPage()
    expect(screen.queryByText('No audit entries match.')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(await screen.findByText('No audit entries match.')).toBeInTheDocument()
  })

  it('shows an error state with Try again', async () => {
    let calls = 0
    stubApi(() => {
      calls += 1
      return calls === 1
        ? json({ error: { code: 'server_error', message: 'Audit exploded' } }, 500)
        : json({ items: [entry(1)], total: 1, page: 1, page_size: 25 })
    })
    renderPage()
    expect(await screen.findByText('Audit exploded')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Actor 1')).toBeInTheDocument()
  })

  it('renders details as text, never as HTML', async () => {
    stubApi(() =>
      json({
        items: [entry(1, { details: { name: '<img src=x onerror=alert(1)><b>bold</b>' } })],
        total: 1,
        page: 1,
        page_size: 25,
      }),
    )
    const { container } = renderPage()
    await screen.findByText('Actor 1')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('code')!.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
