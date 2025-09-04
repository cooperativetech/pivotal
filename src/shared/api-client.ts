import { hc } from 'hono/client'
import { z } from 'zod'
import type { AppType } from '../server'

// Use relative URL when running through Vite to use proxy
// Use direct URL when running outside of Vite (e.g., in server or flack-eval)
const isViteDev = import.meta.env ?? false
const API_BASE_URL = isViteDev ? '/' : 'http://localhost:3001'

// Get session token from sessionStorage
// NOTE: We use sessionStorage instead of cookies because better-auth's cookies
// don't work properly across the Vite proxy (port 5173) to backend (port 3001).
// This is a temporary solution for development with ngrok.
// TODO: In production, use proper httpOnly cookies for security.

const SessionDataSchema = z.object({
  token: z.string().optional(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
  }).optional(),
})

function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  const sessionData = window.sessionStorage.getItem('auth-session')
  if (!sessionData) return {}

  try {
    const parsed = SessionDataSchema.parse(JSON.parse(sessionData))
    if (parsed.token) {
      return { Authorization: `Bearer ${parsed.token}` }
    }
  } catch {
    // Invalid JSON or doesn't match schema
  }
  return {}
}

// Create client with auth headers
const createAuthenticatedClient = () => {
  return hc<AppType>(API_BASE_URL, {
    headers: () => getAuthHeaders(),
  })
}

const appType = createAuthenticatedClient()
export const { api, local_api } = appType
