import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../api/client'
import type { LoginResponse, Me } from '../types/api'
import { AuthContext } from './AuthContext'
import { getToken, setToken, subscribe } from './tokenStore'

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<Me | null>(null)
  const [loading, setLoading] = useState(() => getToken() !== null)

  // After a refresh the token survives in sessionStorage; ask the API who it belongs to.
  useEffect(() => {
    if (getToken() === null) return
    let cancelled = false
    apiFetch<Me>('/api/auth/me')
      .then((me) => {
        if (!cancelled) setUser(me)
      })
      .catch(() => {
        // A 401 has already cleared the token; any other failure leaves the user logged out.
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Token cleared (logout, or a 401 anywhere): drop the user and every cached response,
  // so the next person to log in on this tab can never see the previous tenant's data.
  useEffect(
    () =>
      subscribe(() => {
        if (getToken() === null) {
          setUser(null)
          queryClient.clear()
        }
      }),
    [queryClient],
  )

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiFetch<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    })
    setToken(result.access_token)
    setUser(result.user)
  }, [])

  const logout = useCallback(() => setToken(null), [])

  const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
