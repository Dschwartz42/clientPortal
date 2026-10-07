import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../api/client'
import { onForbidden } from '../api/queryClient'
import type { LoginResponse, Me } from '../types/api'
import { AuthContext } from './AuthContext'
import { getToken, setToken, subscribe } from './tokenStore'

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<Me | null>(null)
  const [loading, setLoading] = useState(() => getToken() !== null)

  // Ask the API who the current token belongs to. At most one request per token is in
  // flight; callers during that time share it.
  const inflight = useRef<{ token: string; promise: Promise<void> } | null>(null)
  const refreshUser = useCallback((): Promise<void> => {
    const requestedWith = getToken()
    if (requestedWith === null) return Promise.resolve()
    if (inflight.current?.token === requestedWith) return inflight.current.promise
    const promise = apiFetch<Me>('/api/auth/me')
      .then((me) => {
        // Ignore the answer if the session changed (login or logout) while it was in flight.
        if (getToken() === requestedWith) setUser(me)
      })
      .catch(() => {
        // A 401 has already cleared the token. Any other failure (network, 500) deliberately
        // keeps the token and the current user: a transient outage should not destroy the
        // session, and the next navigation or reload retries.
      })
      .finally(() => {
        if (inflight.current?.promise === promise) inflight.current = null
      })
    inflight.current = { token: requestedWith, promise }
    return promise
  }, [])

  // After a page reload the token survives in sessionStorage; find out whose it is.
  useEffect(() => {
    if (getToken() === null) return
    let cancelled = false
    void refreshUser().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [refreshUser])

  // Any 403 means the role may have changed on the server: re-read it.
  useEffect(
    () =>
      onForbidden(() => {
        void refreshUser()
      }),
    [refreshUser],
  )

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

  const value = useMemo(
    () => ({ user, loading, login, logout, refreshUser }),
    [user, loading, login, logout, refreshUser],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
