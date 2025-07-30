import { createContext } from 'react'

export interface User {
  id: string
  email: string
  name: string
}

export interface AuthContextType {
  user: User | null
  loading: boolean
  refetchUser: () => Promise<void>
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined)