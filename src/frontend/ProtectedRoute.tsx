import { Navigate } from 'react-router'
import type { ReactNode } from 'react'
import { useAuth } from './AuthContext'

interface ProtectedRouteProps { children: ReactNode }

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { session, loading } = useAuth()

  if (loading) {
    return <div className="loading">Loading...</div>
  }

  if (!session) {
    return <Navigate to="/auth" replace />
  }

  return <>{children}</>
}
