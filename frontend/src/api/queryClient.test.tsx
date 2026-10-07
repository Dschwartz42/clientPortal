import { useMutation, useQuery, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../auth/AuthContext'
import { AuthProvider } from '../auth/AuthProvider'
import { getToken, setToken } from '../auth/tokenStore'
import { apiFetch } from './client'
import { createQueryClient } from './queryClient'

const admin = { id: '1', email: 'a@acme.test', full_name: 'A', role: 'admin', org_id: 'o', org_name: 'Acme' }
const member = { ...admin, role: 'member' }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

/** /me answers with `meBodies` in order (the last one repeats); everything else fails with `status`. */
function stubApi(meBodies: unknown[], status: number) {
  let meCalls = 0
  const fetchMock = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/auth/me') {
      const body = meBodies[Math.min(meCalls, meBodies.length - 1)]
      meCalls += 1
      return json(body)
    }
    return json({ error: { code: 'forbidden', message: 'No access' } }, status)
  })
  vi.stubGlobal('fetch', fetchMock)
  const meRequests = () =>
    fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/auth/me').length
  return { fetchMock, meRequests }
}

function Failing({ n }: { n: number }) {
  useQuery({ queryKey: ['failing', n], queryFn: () => apiFetch(`/api/thing/${n}`) })
  return null
}

function FailingMutation() {
  const mutation = useMutation({ mutationFn: () => apiFetch('/api/thing', { method: 'POST', body: {} }) })
  return <button onClick={() => mutation.mutate()}>go</button>
}

function Role() {
  const { user } = useAuth()
  return <p data-testid="role">{user?.role ?? 'none'}</p>
}

/** Mounts its children only once the session check has finished, so each test starts from a settled session. */
function AfterSessionCheck({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  return user ? <>{children}</> : null
}

function renderApp(children: React.ReactNode) {
  const queryClient = createQueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Role />
        <AfterSessionCheck>{children}</AfterSessionCheck>
      </AuthProvider>
    </QueryClientProvider>,
  )
  return queryClient
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))

beforeEach(() => setToken('tok'))
afterEach(() => setToken(null))

describe('createQueryClient 403 handling', () => {
  it('asks /me exactly once when several queries fail with 403 at once, and updates the role', async () => {
    const { meRequests } = stubApi([admin, member], 403)
    renderApp(
      <>
        <Failing n={1} />
        <Failing n={2} />
        <Failing n={3} />
      </>,
    )
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('member'))
    await settle()
    // One call for the initial session check, exactly one for all three 403s.
    expect(meRequests()).toBe(2)
    expect(getToken()).toBe('tok')
  })

  it('does not loop: a refresh that succeeds triggers no further refresh', async () => {
    const { meRequests } = stubApi([member], 403)
    renderApp(<Failing n={1} />)
    await waitFor(() => expect(meRequests()).toBe(2))
    await settle()
    await settle()
    expect(meRequests()).toBe(2)
  })

  it('refreshes after a 403 from a mutation', async () => {
    const { meRequests } = stubApi([admin, member], 403)
    renderApp(<FailingMutation />)
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('admin'))
    act(() => screen.getByRole('button', { name: 'go' }).click())
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('member'))
    expect(meRequests()).toBe(2)
  })

  it('does not clear the token on a 403', async () => {
    const { meRequests } = stubApi([admin], 403)
    renderApp(<Failing n={1} />)
    await waitFor(() => expect(meRequests()).toBe(2))
    await settle()
    expect(getToken()).toBe('tok')
    expect(screen.getByTestId('role')).toHaveTextContent('admin')
  })

  it('still clears the session on a 401, without asking /me again', async () => {
    const { meRequests } = stubApi([admin], 401)
    renderApp(<Failing n={1} />)
    await waitFor(() => expect(getToken()).toBeNull())
    await settle()
    expect(screen.getByTestId('role')).toHaveTextContent('none')
    expect(meRequests()).toBe(1)
  })

  it('does not retry a 403', async () => {
    const { fetchMock } = stubApi([admin], 403)
    renderApp(<Failing n={1} />)
    await settle()
    const thing = fetchMock.mock.calls.filter(([i]) => new URL(String(i)).pathname === '/api/thing/1')
    expect(thing).toHaveLength(1)
  })
})
