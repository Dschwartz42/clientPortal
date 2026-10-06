import { createContext, useContext } from 'react'
import type { Me } from '../types/api'

export interface AuthState {
  user: Me | null
  /** true while a stored token is being checked against /api/auth/me */
  loading: boolean
  login(email: string, password: string): Promise<void>
  logout(): void
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
