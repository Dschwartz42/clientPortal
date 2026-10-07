import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../auth/AuthProvider'
import { getToken, setToken } from '../auth/tokenStore'
import { LoginPage } from './LoginPage'

function renderLogin() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function submit(email: string, password: string) {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Email'), email)
  await user.type(screen.getByLabelText('Password'), password)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

beforeEach(() => setToken(null))

describe('LoginPage', () => {
  it('shows the API error message on failed login', async () => {
    const body = { error: { code: 'invalid_credentials', message: 'Invalid email or password' } }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 401 })),
    )
    renderLogin()
    await submit('admin@acme.test', 'wrong')
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password')
    expect(getToken()).toBeNull()
  })

  it('shows a readable message when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderLogin()
    await submit('admin@acme.test', 'DemoPass123!')
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server')
  })

  it('stores the token on success', async () => {
    const body = {
      access_token: 'tok',
      user: {
        id: '1', email: 'admin@acme.test', full_name: 'A', role: 'admin',
        org_id: 'o', org_name: 'Acme Corp',
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
    )
    renderLogin()
    await submit('admin@acme.test', 'DemoPass123!')
    await vi.waitFor(() => expect(getToken()).toBe('tok'))
  })
})
