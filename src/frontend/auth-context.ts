import { createContext, useContext } from 'react'

export interface Session {
  user: {
    id: string
    email: string
    name: string
  }
  token: string
}

export interface AuthContextType {
  session: Session | null
  loading: boolean
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthContextType | null>(null)

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
