import { Navigate } from 'react-router'
import { useAuth } from './useAuth'
import LoadingDots from './LoadingDots'

interface ProtectedRouteProps {
  children: React.ReactNode
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading } = useAuth()

  if (loading) {
    return <LoadingDots text="Loading" />
  }

  if (!user) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}