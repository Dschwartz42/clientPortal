import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type AuthState, useAuth } from './AuthContext'
import { AuthProvider } from './AuthProvider'
import { getToken, setToken } from './tokenStore'

const latest: { auth: AuthState | null } = { auth: null }
const authRef = {
  login: (email: string, password: string) => latest.auth!.login(email, password),
  logout: () => latest.auth!.logout(),
}

function Probe() {
  const auth = useAuth()
  useEffect(() => {
    latest.auth = auth
  })
  const { user, loading } = auth
  return (
    <p data-testid="probe">
      {loading ? 'loading' : (user?.email ?? 'anonymous')}
    </p>
  )
}

function deferredFetch() {
  const pending: Array<(r: Response) => void> = []
  const fetchMock = vi.fn((input: URL | RequestInfo) => {
    const url = String(input)
    if (url.includes('/api/auth/login')) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'tokB', user: userB }), { status: 200 }),
      )
    }
    return new Promise<Response>((resolve) => pending.push(resolve))
  })
  vi.stubGlobal('fetch', fetchMock)
  return pending
}

const userB = {
  id: '2', email: 'b@acme.test', full_name: 'B', role: 'member', org_id: 'o2', org_name: 'Other',
}

function renderProvider(queryClient = new QueryClient()) {
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  )
  return queryClient
}

const me = {
  id: '1', email: 'admin@acme.test', full_name: 'A', role: 'admin', org_id: 'o', org_name: 'Acme',
}

beforeEach(() => setToken(null))

describe('AuthProvider', () => {
  it('loads the user from /api/auth/me when a token is present', async () => {
    setToken('tok')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(me), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderProvider()
    expect(screen.getByTestId('probe')).toHaveTextContent('loading')
    expect(await screen.findByText('admin@acme.test')).toBeInTheDocument()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/auth/me')
  })

  it('clears the token and leaves the user null when /api/auth/me returns 401', async () => {
    setToken('stale')
    const body = { error: { code: 'invalid_token', message: 'Invalid token' } }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 401 })),
    )
    renderProvider()
    expect(await screen.findByText('anonymous')).toBeInTheDocument()
    expect(getToken()).toBeNull()
  })

  it('drops the user and clears the query cache when the token is cleared', async () => {
    setToken('tok')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(me), { status: 200 })),
    )
    const queryClient = renderProvider()
    expect(await screen.findByText('admin@acme.test')).toBeInTheDocument()
    queryClient.setQueryData(['accounts'], { items: [{ id: 'a1' }] })
    expect(queryClient.getQueryData(['accounts'])).toBeDefined()

    act(() => setToken(null))

    expect(await screen.findByText('anonymous')).toBeInTheDocument()
    expect(queryClient.getQueryData(['accounts'])).toBeUndefined()
  })

  describe('stale /me responses', () => {
    it('keeps user B when the old /me later resolves 200 as user A', async () => {
      setToken('tokA')
      const pending = deferredFetch()
      renderProvider()
      expect(screen.getByTestId('probe')).toHaveTextContent('loading')
      await act(() => authRef.login('b@acme.test', 'pw'))
      expect(screen.getByTestId('probe')).toHaveTextContent('b@acme.test')
      await act(async () => pending[0](new Response(JSON.stringify(me), { status: 200 })))
      expect(screen.getByTestId('probe')).toHaveTextContent('b@acme.test')
      expect(getToken()).toBe('tokB')
    })

    it('keeps user B when the old /me later resolves 401', async () => {
      setToken('tokA')
      const pending = deferredFetch()
      renderProvider()
      await act(() => authRef.login('b@acme.test', 'pw'))
      const body = { error: { code: 'invalid_token', message: 'Invalid token' } }
      await act(async () => pending[0](new Response(JSON.stringify(body), { status: 401 })))
      expect(screen.getByTestId('probe')).toHaveTextContent('b@acme.test')
      expect(getToken()).toBe('tokB')
    })

    it('keeps the user null when /me resolves 200 after logout', async () => {
      setToken('tokA')
      const pending = deferredFetch()
      renderProvider()
      act(() => authRef.logout())
      expect(screen.getByTestId('probe')).toHaveTextContent('anonymous')
      await act(async () => pending[0](new Response(JSON.stringify(me), { status: 200 })))
      expect(screen.getByTestId('probe')).toHaveTextContent('anonymous')
      expect(getToken()).toBeNull()
    })
  })

  it('login clears previously cached query data', async () => {
    deferredFetch()
    const queryClient = renderProvider()
    queryClient.setQueryData(['accounts'], { items: [] })
    await act(() => authRef.login('b@acme.test', 'pw'))
    expect(queryClient.getQueryData(['accounts'])).toBeUndefined()
  })
})

describe('refreshUser', () => {
  it('updates the role from /api/auth/me', async () => {
    setToken('tok')
    const bodies = [me, { ...me, role: 'member' }]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(bodies.shift()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    function Role() {
      const { user } = useAuth()
      return <p data-testid="role">{user?.role ?? 'none'}</p>
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <Probe />
          <Role />
        </AuthProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('admin'))
    await act(() => latest.auth!.refreshUser())
    expect(screen.getByTestId('role')).toHaveTextContent('member')
    expect(getToken()).toBe('tok')
  })

  it('ignores a /me answer that arrives after the token changed', async () => {
    const pending: Array<(r: Response) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: URL | RequestInfo) =>
        String(input).includes('/api/auth/login')
          ? Promise.resolve(new Response(JSON.stringify({ access_token: 'tokB', user: userB }), { status: 200 }))
          : new Promise<Response>((resolve) => pending.push(resolve)),
      ),
    )
    setToken('tokA')
    renderProvider()
    await act(() => authRef.login('b@acme.test', 'pw'))
    let refreshed: Promise<void> = Promise.resolve()
    act(() => {
      refreshed = latest.auth!.refreshUser()
    })
    // pending[0] is the stale mount check, pending[1] the refresh made with tokB.
    expect(pending).toHaveLength(2)
    act(() => setToken('tokC'))
    await act(async () => {
      pending[1](new Response(JSON.stringify(me), { status: 200 }))
      await refreshed
    })
    expect(screen.getByTestId('probe')).not.toHaveTextContent('admin@acme.test')
  })

  it('keeps the session and the user when /me fails with a non-401 error', async () => {
    setToken('tok')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(me), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'server_error', message: 'boom' } }), { status: 500 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    renderProvider()
    expect(await screen.findByText('admin@acme.test')).toBeInTheDocument()
    await act(() => latest.auth!.refreshUser())
    expect(screen.getByTestId('probe')).toHaveTextContent('admin@acme.test')
    expect(getToken()).toBe('tok')
  })
})
