import { hc } from 'hono/client'
import type { AppType } from '../flack-server'

// Use relative URL when running through Vite to use proxy
// Use direct URL when running outside of Vite (e.g., in server or flack-eval)
const isViteDev = import.meta.env ?? false
const API_BASE_URL = isViteDev ? '/' : 'http://localhost:3001'

export const api = hc<AppType>(API_BASE_URL).api
