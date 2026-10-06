import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getToken, setToken } from '../auth/tokenStore'
import { ApiError, apiFetch } from './client'

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(body === null ? null : JSON.stringify(body), { status }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => setToken(null))

describe('apiFetch', () => {
  it('sends the bearer token and skips empty query params', async () => {
    setToken('abc')
    const fetchMock = mockFetch(200, { ok: true })
    await apiFetch('/api/accounts', { params: { status: 'active', tier: '', page: 2 } })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://localhost:8000/api/accounts?status=active&page=2')
    expect(init.headers.Authorization).toBe('Bearer abc')
  })

  it('mirrors the token to sessionStorage', () => {
    setToken('abc')
    expect(sessionStorage.getItem('portal_token')).toBe('abc')
    setToken(null)
    expect(sessionStorage.getItem('portal_token')).toBeNull()
  })

  it('throws ApiError with the code and message from the error envelope', async () => {
    mockFetch(409, { error: { code: 'last_admin', message: 'Need one admin' } })
    await expect(apiFetch('/api/users/1', { method: 'PATCH', body: {} })).rejects.toMatchObject({
      status: 409,
      code: 'last_admin',
      message: 'Need one admin',
    })
  })

  it('clears the token on 401 so the app returns to login', async () => {
    setToken('expired')
    mockFetch(401, { error: { code: 'invalid_token', message: 'Invalid or expired token' } })
    await expect(apiFetch('/api/accounts')).rejects.toBeInstanceOf(ApiError)
    expect(getToken()).toBeNull()
  })

  it('does not clear the token for a failed login attempt', async () => {
    setToken('still-valid')
    mockFetch(401, { error: { code: 'invalid_credentials', message: 'Invalid email or password' } })
    await expect(
      apiFetch('/api/auth/login', { method: 'POST', body: {}, auth: false }),
    ).rejects.toBeInstanceOf(ApiError)
    expect(getToken()).toBe('still-valid')
  })

  it('turns a network failure into a readable ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(apiFetch('/api/accounts')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    })
  })

  it('returns undefined for 204', async () => {
    mockFetch(204, null)
    await expect(apiFetch('/api/accounts/1', { method: 'DELETE' })).resolves.toBeUndefined()
  })
})
