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
    const requestedWith = getToken()
    if (requestedWith === null) return
    let cancelled = false
    apiFetch<Me>('/api/auth/me')
      .then((me) => {
        // Ignore the answer if the session changed (login or logout) while it was in flight.
        if (!cancelled && getToken() === requestedWith) setUser(me)
      })
      .catch(() => {
        // A 401 has already cleared the token. Any other failure (network, 500) deliberately
        // keeps the token and shows no user: a transient outage should not destroy the
        // session, and the next navigation or reload retries.
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
          setLoading(false)
          queryClient.clear()
        }
      }),
    [queryClient],
  )

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await apiFetch<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: { email, password },
        auth: false,
      })
      // Defense in depth: never let cached data outlive the session it was fetched for,
      // even if a token is replaced without passing through null.
      queryClient.clear()
      setToken(result.access_token)
      setUser(result.user)
      // Any pending /me check belongs to the old token; its result is now irrelevant.
      setLoading(false)
    },
    [queryClient],
  )

  const logout = useCallback(() => setToken(null), [])

  const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
