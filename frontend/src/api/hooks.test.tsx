import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setToken } from '../auth/tokenStore'
import { useAccount, useAccountTransactions, useUpdateAccount, useUpdateUser } from './hooks'

const nasty = '../users?x=1#frag/ok'
const encoded = encodeURIComponent(nasty)

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  )
}

function stub() {
  const fetchMock = vi.fn((input: URL | string) => Promise.resolve(new Response(JSON.stringify({ url: String(input) }))))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function requested(fetchMock: ReturnType<typeof stub>) {
  const url = new URL(String(fetchMock.mock.calls[0][0]))
  return url
}

beforeEach(() => setToken('t'))
afterEach(() => setToken(null))

describe('ids in request paths are encoded', () => {
  it('useAccount', async () => {
    const f = stub()
    renderHook(() => useAccount(nasty), { wrapper })
    await waitFor(() => expect(f).toHaveBeenCalled())
    const url = requested(f)
    expect(url.pathname).toBe(`/api/accounts/${encoded}`)
    expect(url.search).toBe('')
  })

  it('useAccountTransactions', async () => {
    const f = stub()
    renderHook(() => useAccountTransactions(nasty, 1), { wrapper })
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(requested(f).pathname).toBe(`/api/accounts/${encoded}/transactions`)
  })

  it('useUpdateAccount', async () => {
    const f = stub()
    const { result } = renderHook(() => useUpdateAccount(nasty), { wrapper })
    result.current.mutate({ status: 'closed' })
    await waitFor(() => expect(f).toHaveBeenCalled())
    const url = requested(f)
    expect(url.pathname).toBe(`/api/accounts/${encoded}`)
    expect(url.search).toBe('')
  })

  it('useUpdateUser', async () => {
    const f = stub()
    const { result } = renderHook(() => useUpdateUser(), { wrapper })
    result.current.mutate({ id: nasty, body: { is_active: false } })
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(requested(f).pathname).toBe(`/api/users/${encoded}`)
  })
})
