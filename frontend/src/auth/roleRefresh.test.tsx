import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { createQueryClient } from '../api/queryClient'
import { AuthProvider } from './AuthProvider'
import { getToken, setToken } from './tokenStore'

const admin = { id: 'u1', email: 'a@acme.test', full_name: 'Ada Admin', role: 'admin', org_id: 'o', org_name: 'Acme' }
const other = { id: 'u2', email: 'b@acme.test', full_name: 'Other Admin', role: 'admin', org_id: 'o', org_name: 'Acme' }

function row(u: typeof admin, role: string) {
  return { ...u, role, is_active: true, last_login_at: null, created_at: '2026-01-01T00:00:00Z' }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('role refresh', () => {
  beforeEach(() => setToken('tok'))
  afterEach(() => setToken(null))

  it('an admin who makes themselves a member ends on not-found with the member badge', async () => {
    let demoted = false
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string, init: RequestInit = {}) => {
        const url = new URL(String(input))
        const method = init.method ?? 'GET'
        calls.push(`${method} ${url.pathname}`)
        if (url.pathname === '/api/auth/me') return json({ ...admin, role: demoted ? 'member' : 'admin' })
        if (url.pathname === '/api/users' && method === 'GET') {
          return demoted
            ? json({ error: { code: 'forbidden', message: 'Admins only' } }, 403)
            : json({ items: [row(admin, 'admin'), row(other, 'admin')], total: 2, page: 1, page_size: 100 })
        }
        if (url.pathname === '/api/users/u1' && method === 'PATCH') {
          demoted = true
          return json(row(admin, 'member'))
        }
        return json({ error: { code: 'not_found', message: 'nope' } }, 404)
      }),
    )
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/admin/users']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('heading', { name: 'Users', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('admin', { selector: 'span' })).toBeInTheDocument()

    await userEvent.selectOptions(await screen.findByLabelText('Role for Ada Admin'), 'member')

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Users', level: 1 })).not.toBeInTheDocument()
    expect(screen.getByText('member', { selector: 'span' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Audit log' })).not.toBeInTheDocument()

    // No retry loop: the number of /me calls stays put.
    await delay(100)
    const before = calls.filter((c) => c === 'GET /api/auth/me').length
    await delay(100)
    expect(calls.filter((c) => c === 'GET /api/auth/me').length).toBe(before)
    expect(before).toBeLessThanOrEqual(3)
    await waitFor(() => expect(getToken()).toBe('tok'))
  })
})
