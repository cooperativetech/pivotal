import { hc } from 'hono/client'
import type { AppType } from '../server'

// Use relative URL when running frontend code
// Use direct URL to local server when running outside frontend code (e.g. in evals)
const isFrontend = import.meta.env ?? false
const API_BASE_URL = isFrontend ? '/' : 'http://localhost:3001'

const appType = hc<AppType>(API_BASE_URL)
export const { api, local_api } = appType
