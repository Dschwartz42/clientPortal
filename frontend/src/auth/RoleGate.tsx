import type { ReactNode } from 'react'
import type { Role } from '../types/api'
import { useAuth } from './AuthContext'

/** UI convenience only: hides controls the user cannot use. The API enforces the real rule. */
export function RoleGate({ role, children }: { role: Role; children: ReactNode }) {
  const { user } = useAuth()
  return user?.role === role ? <>{children}</> : null
}
