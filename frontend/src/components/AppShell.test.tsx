import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AuthContext } from '../auth/AuthContext'
import { AppShell } from './AppShell'

describe('AppShell', () => {
  it('shows the organisation, the user and their role, and logs out', async () => {
    const logout = vi.fn()
    render(
      <AuthContext.Provider
        value={{
          user: {
            id: 'u1',
            email: 'admin@acme.test',
            full_name: 'Ada Admin',
            role: 'admin',
            org_id: 'o1',
            org_name: 'Acme Corp',
          },
          loading: false,
          login: vi.fn(),
          logout,
        }}
      >
        <MemoryRouter>
          <AppShell />
        </MemoryRouter>
      </AuthContext.Provider>,
    )
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('Ada Admin')).toBeInTheDocument()
    expect(screen.getByText('admin')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }))
    expect(logout).toHaveBeenCalledTimes(1)
  })
})
