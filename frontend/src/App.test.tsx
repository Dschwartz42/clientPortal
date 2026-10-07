import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { AuthContext, type AuthState } from './auth/AuthContext'
import type { Me, Role } from './types/api'

// The dashboard is covered by its own test; here it only needs to mount without network.
vi.mock('./pages/DashboardPage', () => ({
  DashboardPage: () => <h1>Dashboard</h1>,
}))

function makeUser(role: Role): Me {
  return {
    id: 'u1',
    email: `${role}@acme.test`,
    full_name: 'Test Person',
    role,
    org_id: 'o1',
    org_name: 'Acme Corp',
  }
}

function renderApp(path: string, auth: Partial<AuthState>) {
  const value: AuthState = {
    user: null,
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: async () => {},
    ...auth,
  }
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthContext.Provider value={value}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('App routing', () => {
  it('shows the login page to an unauthenticated visitor', () => {
    renderApp('/dashboard', {})
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument()
  })

  it('redirects / to the dashboard for a signed-in member', () => {
    renderApp('/', { user: makeUser('member') })
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
  })

  it('renders not-found for /admin/users as a member, without admin links', () => {
    renderApp('/admin/users', { user: makeUser('member') })
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Audit log' })).not.toBeInTheDocument()
  })

  it.each([
    ['/admin/users', 'Users', 'Invite user'],
    ['/admin/audit', 'Audit log', null],
  ])('renders %s for an admin', async (path, heading, button) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], total: 0, page: 1, page_size: 25 }))))
    renderApp(path, { user: makeUser('admin') })
    expect(screen.getByRole('heading', { name: heading, level: 1 })).toBeInTheDocument()
    if (button) expect(screen.getByRole('button', { name: button })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Page not found' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument())
  })

  it.each([
    ['/admin/users', 'Users'],
    ['/admin/audit', 'Audit log'],
  ])('renders not-found for %s as a member, not the page', (path, heading) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderApp(path, { user: makeUser('member') })
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: heading, level: 1 })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Invite user' })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the admin links to an admin', () => {
    renderApp('/dashboard', { user: makeUser('admin') })
    expect(screen.getByRole('link', { name: 'Users' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Audit log' })).toBeInTheDocument()
  })

  it('renders not-found inside the shell for an unknown path', () => {
    renderApp('/nope', { user: makeUser('member') })
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument()
  })

  it('shows a loading indicator while the session is being checked', () => {
    renderApp('/dashboard', { loading: true })
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument()
  })
})
