import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
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
      <MemoryRouter>
        <AuditLogPage />
      </MemoryRouter>
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

  describe('Target column', () => {
    const ACCOUNT_ID = '3f2c9a1e-5b7d-4c8e-9a10-2b3c4d5e6f70'
    const USER_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

    it('shows the entity type and the first 8 characters of the id', async () => {
      stubApi(() =>
        json({
          items: [entry(1, { entity_type: 'user', entity_id: USER_ID, action: 'user.invited' })],
          total: 1,
          page: 1,
          page_size: 25,
        }),
      )
      renderPage()
      await screen.findByText('Actor 1')
      expect(screen.getByRole('columnheader', { name: 'Target' })).toBeInTheDocument()
      const row = screen.getAllByRole('row')[1]
      expect(row).toHaveTextContent('user 7a1b2c3d')
      expect(row).not.toHaveTextContent(USER_ID)
    })

    it('links an account entry to the account', async () => {
      stubApi(() =>
        json({
          items: [entry(1, { entity_type: 'account', entity_id: ACCOUNT_ID })],
          total: 1,
          page: 1,
          page_size: 25,
        }),
      )
      renderPage()
      const link = await screen.findByRole('link', { name: 'account 3f2c9a1e' })
      expect(link).toHaveAttribute('href', `/accounts/${ACCOUNT_ID}`)
    })

    it('does not link an account entry whose id is not UUID-shaped', async () => {
      stubApi(() =>
        json({
          items: [entry(1, { entity_type: 'account', entity_id: '../admin/users?x=1' })],
          total: 1,
          page: 1,
          page_size: 25,
        }),
      )
      renderPage()
      await screen.findByText('Actor 1')
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
      expect(screen.getAllByRole('row')[1]).toHaveTextContent('account ../admin')
    })

    it('does not link a user entry', async () => {
      stubApi(() =>
        json({
          items: [entry(1, { entity_type: 'user', entity_id: USER_ID })],
          total: 1,
          page: 1,
          page_size: 25,
        }),
      )
      renderPage()
      await screen.findByText('Actor 1')
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
    })
  })

  it('shows long details in full, wrapped, as text', async () => {
    const details = { note: 'x'.repeat(400), nested: { list: Array.from({ length: 20 }, (_, i) => `item-${i}`) } }
    stubApi(() => json({ items: [entry(1, { details })], total: 1, page: 1, page_size: 25 }))
    const { container } = renderPage()
    await screen.findByText('Actor 1')
    const code = container.querySelector('code')!
    expect(code.textContent).toBe(JSON.stringify(details))
    expect(code).toHaveClass('whitespace-pre-wrap', 'break-all')
    expect(code).not.toHaveClass('truncate')
  })
})
