import { createAuthClient } from 'better-auth/client'

// Use the current origin to make it work with ngrok, localhost, or production
const baseURL = typeof window !== 'undefined'
  ? `${window.location.origin}/api/auth`
  : 'http://localhost:3001/api/auth'

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
    headers: {
      'ngrok-skip-browser-warning': 'true',
    },
  },
})