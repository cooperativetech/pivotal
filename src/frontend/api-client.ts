import { createAuthClient } from 'better-auth/react'
import { hc } from 'hono/client'
import type { AppType } from '../server'

export const authClient = createAuthClient()
export const api = hc<AppType>('/').api
