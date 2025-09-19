import { createContext } from 'react'

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

