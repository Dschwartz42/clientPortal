import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Me, Role } from '../types/api'
import { AuthContext } from './AuthContext'
import { RoleGate } from './RoleGate'

function renderAs(role: Role | null) {
  const user: Me | null = role && {
    id: '1', email: 'x@acme.test', full_name: 'X', role, org_id: 'o', org_name: 'Acme',
  }
  const value = { user, loading: false, login: async () => {}, logout: () => {}, refreshUser: async () => {} }
  return render(
    <AuthContext.Provider value={value}>
      <RoleGate role="admin">
        <button>New account</button>
      </RoleGate>
    </AuthContext.Provider>,
  )
}

describe('RoleGate', () => {
  it('renders children for the required role', () => {
    renderAs('admin')
    expect(screen.getByRole('button', { name: 'New account' })).toBeInTheDocument()
  })

  it('hides children for members', () => {
    renderAs('member')
    expect(screen.queryByRole('button', { name: 'New account' })).not.toBeInTheDocument()
  })

  it('hides children when nobody is logged in', () => {
    renderAs(null)
    expect(screen.queryByRole('button', { name: 'New account' })).not.toBeInTheDocument()
  })
})
