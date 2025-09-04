import type { ReactNode } from 'react'
import { createContext, useContext, useEffect, useState } from 'react'
import { authClient } from '@shared/auth-client'

interface Session {
  user: {
    id: string
    email: string
    name: string
  }
  token: string
}

interface AuthContextType {
  session: Session | null
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    checkAuth().catch((err) => {
      console.error('Failed to check auth:', err)
    })
  }, [])

  const checkAuth = async () => {
    try {
      const sessionData = await authClient.getSession()
      if (sessionData.data?.session && sessionData.data?.user) {
        const sessionInfo = {
          user: sessionData.data.user,
          token: sessionData.data.session.token,
        }
        setSession(sessionInfo)
        // Store in sessionStorage for API client to use
        window.sessionStorage.setItem('auth-session', JSON.stringify(sessionInfo))
      } else {
        window.sessionStorage.removeItem('auth-session')
      }
    } catch (error) {
      console.error('Auth check failed:', error)
      window.sessionStorage.removeItem('auth-session')
    } finally {
      setLoading(false)
    }
  }

  const signOut = async () => {
    try {
      await authClient.signOut()
      setSession(null)
      window.sessionStorage.removeItem('auth-session')
    } catch (error) {
      console.error('Sign out failed:', error)
    }
  }

  return (
    <AuthContext.Provider value={{ session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}