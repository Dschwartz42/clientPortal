import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from './AuthContext'
import { AuthProvider } from './AuthProvider'
import { getToken, setToken } from './tokenStore'

function Probe() {
  const { user, loading } = useAuth()
  return <p data-testid="probe">{loading ? 'loading' : (user?.email ?? 'anonymous')}</p>
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
})
