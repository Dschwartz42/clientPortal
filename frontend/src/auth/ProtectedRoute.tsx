import { Navigate, Outlet } from 'react-router-dom'
import { LoadingSkeleton } from '../components/LoadingSkeleton'
import { NotFoundPage } from '../pages/NotFoundPage'
import type { Role } from '../types/api'
import { useAuth } from './AuthContext'

export function ProtectedRoute({ role }: { role?: Role }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="p-6">
        <LoadingSkeleton rows={6} />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  if (role && user.role !== role) return <NotFoundPage />
  return <Outlet />
}
