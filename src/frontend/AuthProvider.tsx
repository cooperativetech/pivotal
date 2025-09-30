import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { authClient } from '@shared/api-client'
import { AuthContext } from './auth-context'
import type { Session } from './auth-context'

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
      }
    } catch (error) {
      console.error('Auth check failed:', error)
    } finally {
      setLoading(false)
    }
  }

  const signOut = async () => {
    try {
      await authClient.signOut()
      setSession(null)
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
